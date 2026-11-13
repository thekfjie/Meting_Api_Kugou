import './setup.js'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { createApp } from '../src/app.js'
import { parseSimpleCookie, writeCookiePool } from '../src/utils/admin.js'
import { readCookieFile } from '../src/utils/cookie.js'
import { saveKugouAccount, getSavedKugouAccount } from '../src/utils/kugou-accounts.js'
import { readKugouAdminState, updateKugouAdminState } from '../src/utils/kugou-admin-state.js'
import { getKugouDispatchSnapshot, saveKugouDispatchPolicy, selectKugouAccount, setKugouAccountLimit, setKugouAccountEnabled } from '../src/utils/kugou-dispatch.js'
import { runKugouAccountAction } from '../src/utils/kugou-admin-actions.js'
import { runKugouAutoRefreshTick } from '../src/utils/kugou-auto-refresh.js'
import { createMockUpstream, json } from './helpers.js'

const owner = '10001'
const primary = '10002'
const cookie = (user, platform) => `t=private-${platform}-${user}; KugooID=${user}; KUGOU_API_PLATFORM=${platform}; mid=mid-${platform}-${user}; dfid=fixture-dfid`
let mock
let minute = 0
let failPrimary = false
const requests = []
before(async () => {
  mock = await createMockUpstream((req, res) => {
    const auth = parseSimpleCookie(req.headers.cookie)
    requests.push({ path: req.url.pathname, user: auth.userid, token: auth.token, platform: auth.KUGOU_API_PLATFORM })
    if (req.url.pathname.endsWith('/login/token')) {
      res.setHeader('Set-Cookie', [`token=renewed-${auth.userid}`, `userid=${auth.userid}`])
      return json(res, { status: 1, error_code: 0 })
    }
    if (req.url.pathname.endsWith('/user/detail') || req.url.pathname.endsWith('/login/device')) return json(res, { status: 1, error_code: 0, data: { userid: auth.userid, nickname: 'Fixture' } })
    if (req.url.pathname.endsWith('/user/vip/detail')) return json(res, { status: 1, data: {} })
    if (req.url.pathname.endsWith('/song/url')) {
      if (failPrimary && auth.userid === primary) return json(res, { status: 0 }, 502)
      return json(res, { url: [`https://audio.example/${auth.KUGOU_API_PLATFORM}/${auth.userid}.mp3`] })
    }
    return json(res, { status: 1, data: {} })
  })
  config.meting.kugou.upstream.defaultUrl = `${mock.url}/default`
  config.meting.kugou.upstream.liteUrl = `${mock.url}/lite`
  config.meting.kugou.premiumKey = 'fixture-key'
  config.meting.url = 'http://localhost'
  await writeCookiePool('premium', cookie(owner, 'default'))
  await writeCookiePool('general', cookie(primary, 'lite'))
  await saveKugouAccount(cookie(owner, 'lite'), 'lite', { nickname: 'Owner', userId: owner })
})
after(() => mock.close())
beforeEach(async t => {
  // Each case gets its own fixed minute, including when Node runs near a boundary.
  const now = 2000000000000 + minute++ * 600000
  t.mock.method(Date, 'now', () => now)
  requests.length = 0
  failPrimary = false
  await updateKugouAdminState(state => { state.dispatch = { mode: 'balanced', preferredUserId: '', disabled: [], limits: {} } })
})

test('priority fills the primary Lite account then uses the personal Lite login', async () => {
  await saveKugouDispatchPolicy({ mode: 'priority', preferredUserId: primary })
  await setKugouAccountLimit(`lite:${primary}`, 2)
  await setKugouAccountLimit(`lite:${owner}`, 2)
  const selected = []
  for (let i = 0; i < 4; i++) selected.push(await selectKugouAccount('general'))
  assert.deepEqual(selected.map(a => a.id), [`lite:${primary}`, `lite:${primary}`, `lite:${owner}`, `lite:${owner}`])
  assert.equal((await selectKugouAccount('general')).exhausted, true)
  assert.equal((await selectKugouAccount('premium')).id, `default:${owner}`)
})

test('balanced mode distributes work between the two Lite accounts', async () => {
  const selected = []
  for (let i = 0; i < 6; i++) selected.push((await selectKugouAccount('general')).userId)
  assert.equal(selected.filter(id => id === primary).length, 3)
  assert.equal(selected.filter(id => id === owner).length, 3)
})

test('concurrent requests reserve each account quota without oversubscription', async () => {
  await setKugouAccountLimit(`lite:${primary}`, 2)
  await setKugouAccountLimit(`lite:${owner}`, 2)
  const selected = await Promise.all(Array.from({ length: 20 }, () => selectKugouAccount('general')))
  assert.equal(selected.filter(a => a.id === `lite:${primary}`).length, 2)
  assert.equal(selected.filter(a => a.id === `lite:${owner}`).length, 2)
  assert.equal(selected.filter(a => a.exhausted).length, 16)
})

test('limits reset next minute and paused accounts cannot be selected', async t => {
  await setKugouAccountEnabled(`lite:${owner}`, false)
  await setKugouAccountLimit(`lite:${primary}`, 1)
  assert.equal((await selectKugouAccount('general')).userId, primary)
  assert.equal((await selectKugouAccount('general')).exhausted, true)
  const next = Date.now() + 60000
  t.mock.method(Date, 'now', () => next)
  assert.equal((await selectKugouAccount('general')).userId, primary)
})

test('existing blog quota exemptions leave Default limits and Lite counters untouched', async () => {
  await setKugouAccountLimit(`default:${owner}`, 1)
  await selectKugouAccount('premium')
  assert.equal((await selectKugouAccount('premium')).exhausted, true)
  assert.equal((await selectKugouAccount('premium', { consume: false })).id, `default:${owner}`)
  const snapshot = await getKugouDispatchSnapshot()
  assert.equal(snapshot.accounts.find(a => a.id === `default:${owner}`).used, 1)
  assert.equal(snapshot.accounts.find(a => a.id === `lite:${owner}`).used, 0)
})

test('API uses the chosen cookie, cached playback consumes no extra quota, and Default stays isolated', async () => {
  await saveKugouDispatchPolicy({ mode: 'priority', preferredUserId: primary })
  await setKugouAccountLimit(`lite:${primary}`, 1)
  const app = createApp()
  const path = '/music?server=kugou&type=url&id=ABC100&key=fixture-key'
  // Premium stays on Default, regardless of the Lite priority setting.
  assert.equal((await app.request(path)).headers.get('location'), `https://audio.example/default/${owner}.mp3`)
  const { createHmac } = await import('node:crypto')
  const url = hash => `/music?server=kugou&type=url&id=${hash}&auth=${createHmac('sha1', config.meting.token).update(`kugouurl${hash}`).digest('hex')}`
  const first = url('ABC101')
  assert.equal((await app.request(first)).headers.get('location'), `https://audio.example/lite/${primary}.mp3`)
  const hit = await app.request(first)
  assert.equal(hit.headers.get('x-cache'), 'hit')
  assert.equal(hit.headers.get('location'), `https://audio.example/lite/${primary}.mp3`)
  assert.equal((await app.request(url('ABC102'))).headers.get('location'), `https://audio.example/lite/${owner}.mp3`)
  const snapshot = await getKugouDispatchSnapshot()
  assert.equal(snapshot.accounts.find(a => a.id === `lite:${primary}`).used, 1)
  assert.equal(snapshot.accounts.find(a => a.id === `lite:${owner}`).used, 1)
  assert.equal(requests.filter(r => r.path.endsWith('/song/url')).length, 3)
})

test('a failed primary playback retries the other Lite login without using Default', async () => {
  await saveKugouDispatchPolicy({ mode: 'priority', preferredUserId: primary })
  failPrimary = true
  const { createHmac } = await import('node:crypto')
  const auth = createHmac('sha1', config.meting.token).update('kugouurlABC103').digest('hex')
  const response = await createApp().request(`/music?server=kugou&type=url&id=ABC103&auth=${auth}`)
  assert.equal(response.headers.get('location'), `https://audio.example/lite/${owner}.mp3`)
  assert.deepEqual(requests.filter(r => r.path.endsWith('/song/url')).map(r => r.platform), ['lite', 'lite'])
})

test('an additional login refreshes in place and receives its own automatic schedule', async () => {
  const before = await readCookieFile('kugou', 'general')
  assert.equal((await runKugouAccountAction(`lite:${owner}`, 'refresh')).ok, true)
  assert.equal(await readCookieFile('kugou', 'general'), before)
  assert.equal(parseSimpleCookie((await getSavedKugouAccount(`lite:${owner}`)).cookie).t, `renewed-${owner}`)
  await runKugouAutoRefreshTick()
  const state = await readKugouAdminState()
  assert.ok(state.accounts[`lite:${owner}`].maintenance.nextRefreshAt)
  assert.ok(state.accounts[`lite:${owner}`].maintenance.nextClaimAt)
  assert.equal(Object.keys(state.accounts).length, 3)
})

test('invalid limits and unknown priority users do not change the saved policy', async () => {
  assert.equal((await setKugouAccountLimit(`lite:${primary}`, '-1')).ok, false)
  assert.equal((await setKugouAccountLimit(`lite:${primary}`, '1.5')).ok, false)
  assert.equal((await saveKugouDispatchPolicy({ mode: 'priority', preferredUserId: '99999' })).ok, false)
  const app = createApp()
  config.admin.password = 'fixture-password'
  for (const action of ['dispatch/policy', 'dispatch/limit', 'dispatch/enabled', 'accounts/action']) {
    const r = await app.request(`/music/manage/${action}`, { method: 'POST' })
    assert.equal(r.status, 302)
  }
})
