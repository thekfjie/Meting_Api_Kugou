import './setup.js'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { writeCookiePool, parseSimpleCookie } from '../src/utils/admin.js'
import { readCookieFile } from '../src/utils/cookie.js'
import { listKugouAccounts, getSavedKugouAccount } from '../src/utils/kugou-accounts.js'
import { activateKugouAccount, applyKugouPoolCookieMap, checkKugouPoolSession } from '../src/utils/kugou-admin-actions.js'
import { createApp } from '../src/app.js'
import { page } from '../src/views/admin.js'
import { createMockUpstream, json } from './helpers.js'

let mock
let rejectedUser = ''
let unavailableUser = ''
before(async () => {
  mock = await createMockUpstream((req, res) => {
    const cookie = parseSimpleCookie(req.headers.cookie)
    if (cookie.userid === rejectedUser) return json(res, { status: 0, error_code: 20004 }, 502)
    if (cookie.userid === unavailableUser) return json(res, { status: 0, error_code: 20006 }, 502)
    json(res, { status: 1, error_code: 0, data: { userid: cookie.userid, nickname: `Fixture ${cookie.userid}`, vip_type: 1 } })
  })
  config.meting.kugou.upstream.defaultUrl = `${mock.url}/default`
  config.meting.kugou.upstream.liteUrl = `${mock.url}/lite`
})
after(() => mock.close())

test('changing active accounts preserves the old login and allows switching back', async () => {
  await writeCookiePool('general', 't=first-private-token; KugooID=10001; KUGOU_API_PLATFORM=lite; mid=first-mid')
  assert.equal((await applyKugouPoolCookieMap('general', { token: 'second-private-token', userid: '10002', KUGOU_API_PLATFORM: 'lite' })).ok, true)
  const accounts = await listKugouAccounts()
  assert.deepEqual(accounts.map(a => a.id).sort(), ['lite:10001', 'lite:10002'])
  assert.equal(parseSimpleCookie(await readCookieFile('kugou', 'general')).KugooID, '10002')
  assert.equal((await activateKugouAccount('general', 'lite:10001')).ok, true)
  assert.equal(parseSimpleCookie(await readCookieFile('kugou', 'general')).t, 'first-private-token')
  assert.equal(parseSimpleCookie((await getSavedKugouAccount('lite:10002')).cookie).t, 'second-private-token')
})

test('saving a standby account keeps the current pool and both client versions', async () => {
  const beforeCookie = await readCookieFile('kugou', 'general')
  assert.equal((await applyKugouPoolCookieMap('general', { token: 'standby-private-token', userid: '10003', KUGOU_API_PLATFORM: 'lite' }, { activate: false })).ok, true)
  assert.equal(await readCookieFile('kugou', 'general'), beforeCookie)
  await writeCookiePool('premium', 't=default-private-token; KugooID=10003; KUGOU_API_PLATFORM=default; mid=default-mid')
  const accounts = await listKugouAccounts()
  assert.ok(accounts.some(a => a.id === 'lite:10003'))
  assert.ok(accounts.some(a => a.id === 'default:10003'))
  assert.equal(JSON.stringify(accounts).includes('standby-private-token'), false)
  assert.equal(JSON.stringify(accounts).includes('default-private-token'), false)
})

test('cross-version activation is refused and login checks record real auth results', async () => {
  const beforeCookie = await readCookieFile('kugou', 'premium')
  assert.equal((await activateKugouAccount('premium', 'lite:10003')).ok, false)
  assert.equal(await readCookieFile('kugou', 'premium'), beforeCookie)
  const checked = await checkKugouPoolSession('premium')
  assert.equal(checked.ok, true)
  assert.equal(checked.sessionStatus.profile.status, 1)
  assert.equal(checked.sessionStatus.device.status, 1)
})

test('an expired standby login cannot replace the currently working account', async () => {
  const beforeCookie = await readCookieFile('kugou', 'general')
  rejectedUser = '10002'
  try {
    assert.equal((await activateKugouAccount('general', 'lite:10002')).ok, false)
    assert.equal(await readCookieFile('kugou', 'general'), beforeCookie)
  } finally { rejectedUser = '' }
})

test('temporary upstream failures do not label the current account as expired', async () => {
  unavailableUser = '10003'
  try {
    const result = await checkKugouPoolSession('premium')
    assert.equal(result.ok, false)
    assert.equal(result.sessionStatus.status, 'unknown')
    assert.equal(parseSimpleCookie(await readCookieFile('kugou', 'premium')).t, 'default-private-token')
  } finally { unavailableUser = '' }
})

test('management assets support both aliases and new actions require authentication', async () => {
  config.admin.password = 'fixture-password'
  const app = createApp()
  for (const alias of ['api', 'music']) {
    const css = await app.request(`/${alias}/manage/assets/admin.css`)
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type'), /text\/css/)
    for (const action of ['accounts/activate', 'kugou/session/check']) {
      const denied = await app.request(`/${alias}/manage/${action}`, { method: 'POST' })
      assert.equal(denied.status, 302)
      assert.match(denied.headers.get('location'), /manage\/login$/)
    }
  }
})

test('dashboard escapes account data and lists standby accounts without secrets', async () => {
  const accounts = await listKugouAccounts()
  accounts[0].nickname = '<script>window.leaked=true</script>'
  const html = page({ basePath: '/music', pools: [], accounts, mon: {}, procs: [], logs: [], qrSessions: {}, smsSessions: {}, warnings: [] })
  assert.ok(html.includes('所有账号与登录态'))
  assert.ok(html.includes('备用'))
  assert.ok(html.includes('&lt;script&gt;window.leaked=true&lt;/script&gt;'))
  assert.equal(html.includes('<script>window.leaked=true</script>'), false)
  for (const secret of ['first-private-token', 'second-private-token', 'standby-private-token', 'default-private-token']) assert.equal(html.includes(secret), false)
})
