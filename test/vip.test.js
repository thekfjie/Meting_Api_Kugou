import './setup.js'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { createMockUpstream, json } from './helpers.js'
import { claimKugouLiteVipReward } from '../src/utils/kugou-vip-claim.js'
import { getKugouVipDay, summarizeKugouMemberships, parseKugouVipTime } from '../src/utils/kugou-membership.js'
import { summarizeKugouProfile, runKugouAccountAction, claimKugouLiteVip, claimAllKugouLiteVip } from '../src/utils/kugou-admin-actions.js'
import { writeCookiePool, parseSimpleCookie } from '../src/utils/admin.js'
import { readCookieFile } from '../src/utils/cookie.js'
import { saveKugouAccount, getSavedKugouAccount, listKugouAccounts } from '../src/utils/kugou-accounts.js'
import { updateKugouAdminState } from '../src/utils/kugou-admin-state.js'
import { page } from '../src/service/admin.js'
import { runKugouAutoRefreshTick } from '../src/utils/kugou-auto-refresh.js'
import { buildNextClaimAt } from '../src/utils/kugou-auto-schedule.js'

const cookie = 'KugooID=10001; t=private-token; KUGOU_API_PLATFORM=lite; KUGOU_API_GUID=private-device'
const membership = expires => ({ busi_type: 'concept', product_type: 'svip', is_vip: 1, vip_end_time: expires, vip_token: 'private-vip-token' })
let mock
let settings
let requests
before(async () => {
  mock = await createMockUpstream((req, res) => {
    const path = req.url.pathname
    requests.push(req)
    if (path === '/user/detail') return json(res, { status: 1, data: { userid: parseSimpleCookie(req.headers.cookie).userid, nickname: 'Fixture' } })
    if (path === '/login/device') return json(res, { status: 1 })
    if (path === '/user/vip/detail') return json(res, { status: 1, data: { vip_end_time: '2025-01-01 00:00:00', su_vip_end_time: '2025-02-01 00:00:00', busi_vip: [membership(settings.extended ? '2030-02-01 00:00:00' : '2030-01-01 00:00:00'), { ...membership('2030-03-01 00:00:00'), product_type: 'tvip' }] } })
    if (path === '/youth/listen/song') return json(res, { status: settings.listenOk ? 1 : 0, error_code: settings.listenOk ? 0 : 130012 }, settings.listenOk ? 200 : 502)
    if (path === '/youth/vip') {
      if (settings.disconnect) return res.destroy()
      if (settings.claimOk && settings.extend) settings.extended = true
      return json(res, { status: settings.claimOk ? 1 : 0, error_code: settings.claimOk ? 0 : 123, msg: 'private-upstream-message', data: settings.proof ? { award_vip_hour: 3, done: 2, total: 8, remain: 6 } : {} })
    }
    json(res, { status: 0 }, 404)
  })
  config.meting.kugou.upstream.liteUrl = mock.url
  config.meting.kugou.upstream.defaultUrl = mock.url
})
after(() => mock.close())
beforeEach(async () => {
  settings = { listenOk: true, claimOk: true, extend: true, extended: false, proof: true }
  requests = []
  await updateKugouAdminState(state => {
    state.accounts = {}
    for (const pool of ['premium', 'general']) state.pools[pool].lastClaimResult = null
  })
})
const writes = () => requests.filter(r => ['/youth/listen/song', '/youth/vip'].includes(r.url.pathname))

test('membership summaries keep every product, independent dates and expired regular memberships without secrets', () => {
  const profile = summarizeKugouProfile({ vip: { data: { vip_end_time: '2025-01-01 00:00:00', su_vip_end_time: '2025-02-01 00:00:00', busi_vip: [membership('2030-01-01 00:00:00'), { ...membership('2030-03-01 00:00:00'), product_type: 'tvip' }, membership('2029-01-01 00:00:00')] } } })
  assert.equal(profile.memberships.length, 4)
  assert.equal(profile.memberships.find(x => x.id === 'concept/svip').expireTime, '2030-01-01 00:00:00')
  assert.equal(profile.memberships.find(x => x.id === 'regular/svip').status, 'expired')
  assert.ok(!JSON.stringify(profile.memberships).includes('private-vip-token'))
  assert.equal(parseKugouVipTime('2030-01-01 00:00:00'), Date.parse('2029-12-31T16:00:00Z'))
  assert.equal(parseKugouVipTime('0000-00-00 00:00:00'), 0)
  assert.equal(getKugouVipDay(Date.parse('2026-11-16T16:01:00Z')), '2026-11-17')
  assert.equal(summarizeKugouMemberships({ busi_vip: [{ ...membership('invalid'), vip_clearday: '2099-01-01 00:00:00' }] })[0].expireTime, '')
})

test('restored flow only calls listen and the original reward endpoint, and verifies membership changes', async () => {
  const result = await claimKugouLiteVipReward(cookie, 'general')
  assert.equal(result.ok, true)
  assert.equal(result.evidence.kind, 'listen-reward')
  assert.equal(result.evidence.claim.state, 'confirmed')
  assert.ok(result.evidence.changes.some(x => x.id === 'concept/svip'))
  assert.deepEqual(writes().map(r => r.url.pathname), ['/youth/listen/song', '/youth/vip'])
  assert.equal(requests.some(r => r.url.pathname.includes('/youth/day/')), false)
  assert.equal(JSON.stringify(result.evidence).includes('private'), false)
})

test('a listen rejection cannot block the legacy reward, while existing VIP cannot mask a failed reward', async () => {
  settings.listenOk = false
  let result = await claimKugouLiteVipReward(cookie, 'general')
  assert.equal(result.ok, true)
  assert.equal(result.evidence.steps.listen.code, 130012)
  assert.equal(writes().length, 2)
  settings.listenOk = true
  settings.claimOk = false
  requests = []
  result = await claimKugouLiteVipReward(cookie, 'general')
  assert.equal(result.ok, false)
  assert.equal(result.evidence.claim.state, 'failed')
})

test('an accepted request without reward proof or changed expiry stays pending and rechecks only read', async () => {
  settings.proof = false
  settings.extend = false
  const first = await claimKugouLiteVipReward(cookie, 'general')
  assert.equal(first.ok, false)
  assert.equal(first.evidence.claim.state, 'accepted')
  requests = []
  const second = await claimKugouLiteVipReward(cookie, 'general', { previousResult: first })
  assert.equal(second.ok, false)
  assert.equal(writes().length, 0)
  settings.extended = true
  const third = await claimKugouLiteVipReward(cookie, 'general', { previousResult: second })
  assert.equal(third.ok, true)
  assert.equal(writes().length, 0)
})

test('a verified reward receipt remains successful when expiry propagation is delayed', async () => {
  settings.extend = false
  const result = await claimKugouLiteVipReward(cookie, 'general')
  assert.equal(result.ok, true)
  assert.equal(result.evidence.reward.hours, 3)
  assert.equal(result.evidence.changes.length, 0)
})

test('a reward timeout remains uncertain and rechecks cannot repeat its reward write', async () => {
  settings.disconnect = true
  const first = await claimKugouLiteVipReward(cookie, 'general')
  assert.equal(first.ok, false)
  assert.equal(first.evidence.claim.state, 'uncertain')
  requests = []
  await claimKugouLiteVipReward(cookie, 'general', { previousResult: first })
  assert.equal(writes().length, 0)
})

test('daily schedules use UTC+8, always stay in the future, and completed days move to tomorrow', t => {
  t.mock.method(Math, 'random', () => 0)
  const now = Date.parse('2026-11-16T14:00:00+08:00')
  assert.equal(buildNextClaimAt({ now }), '2026-11-16T06:01:00.000Z')
  assert.equal(buildNextClaimAt({ now, tomorrow: true }), '2026-11-17T01:00:00.000Z')
  assert.equal(buildNextClaimAt({ now: Date.parse('2026-11-16T21:00:00+08:00') }), '2026-11-17T01:00:00.000Z')
})

test('additional accounts claim in place; pool actions use the same original reward path', async () => {
  await writeCookiePool('general', cookie)
  const additional = cookie.replace('10001', '10002').replace('private-token', 'second-token').replace('private-device', 'second-device')
  await saveKugouAccount(additional, 'lite', { userId: '10002', nickname: 'Second' })
  const initial = await readCookieFile('kugou', 'general')
  assert.equal((await runKugouAccountAction('lite:10002', 'claim')).ok, true)
  assert.equal(await readCookieFile('kugou', 'general'), initial)
  assert.ok(writes().every(r => parseSimpleCookie(r.headers.cookie).userid === '10002'))
  assert.ok((await getSavedKugouAccount('lite:10002')).profile.memberships.length > 1)
  requests = []
  await runKugouAccountAction('lite:10001', 'claim')
  requests = []
  await claimKugouLiteVip('general')
  assert.ok(writes().some(r => r.url.pathname === '/youth/vip'))
  assert.equal(requests.some(r => r.url.pathname.includes('/youth/day/')), false)
})

test('batch action includes both Lite logins and excludes Default; membership checks update the panel', async () => {
  await writeCookiePool('general', cookie)
  await saveKugouAccount(cookie.replace('10001', '10002'), 'lite', { nickname: 'Second' })
  await writeCookiePool('premium', cookie.replace('lite', 'default'))
  const result = await claimAllKugouLiteVip()
  assert.equal(result.results.length, 2)
  assert.ok(writes().every(r => parseSimpleCookie(r.headers.cookie).KUGOU_API_PLATFORM === 'lite'))
  assert.equal((await runKugouAccountAction('default:10001', 'claim')).ok, false)
  assert.equal((await runKugouAccountAction('default:10001', 'check')).ok, true)
  const accounts = await listKugouAccounts()
  const account = accounts.find(a => a.id === 'default:10001')
  assert.equal(account.memberships.length, 4)
  account.memberships[0].name = '<script>bad()</script>'
  const html = page({ basePath: '/music', pools: [], accounts, mon: {}, procs: [], logs: [], qrSessions: {}, smsSessions: {}, warnings: [], quickProcessNames: [] })
  assert.ok(html.includes('概念 TVIP'))
  assert.ok(html.includes('超级 VIP'))
  assert.ok(html.includes('已到期'))
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'))
  assert.ok(!html.includes('private-token'))
  assert.equal((html.match(/value="claim"/g) || []).length, 2)
})

test('automatic pool and additional-account jobs use the original reward flow and skip paused accounts', async () => {
  await writeCookiePool('general', cookie)
  for (const userId of ['10002', '10003']) await saveKugouAccount(cookie.replace('10001', userId), 'lite', { userId })
  const future = new Date(Date.now() + 86400000).toISOString()
  const past = new Date(Date.now() - 60000).toISOString()
  await updateKugouAdminState(state => {
    state.dispatch.disabled = ['lite:10003']
    for (const pool of ['premium', 'general']) Object.assign(state.pools[pool], { nextRefreshAt: future, nextClaimAt: past })
    for (const account of Object.values(state.accounts)) account.maintenance = { nextRefreshAt: future, nextClaimAt: past }
  })
  await runKugouAutoRefreshTick()
  assert.deepEqual(writes().filter(r => r.url.pathname === '/youth/vip').map(r => parseSimpleCookie(r.headers.cookie).userid), ['10001', '10002'])
  assert.equal(requests.some(r => r.url.pathname.includes('/youth/day/')), false)
})
