import './setup.js'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { createMockUpstream, json } from './helpers.js'
import { claimAndUpgradeKugouLiteVip } from '../src/utils/kugou-vip-claim.js'
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
    if (path === '/youth/month/vip/record') return json(res, { status: settings.recordOk ? 1 : 0, data: { list: settings.claimed ? [{ day: getKugouVipDay(), receive_vip: 1, vip_type: 'svip' }] : [] } })
    if (path === '/youth/listen/song') return json(res, { status: settings.listenOk ? 1 : 0 })
    if (path === '/youth/day/vip') {
      if (settings.claimOk && settings.addRecord) settings.claimed = true
      return json(res, { status: settings.claimOk ? 1 : 0, msg: 'private-upstream-message' })
    }
    if (path === '/youth/day/vip/upgrade') {
      if (settings.upgradeOk && settings.extend) settings.extended = true
      if (settings.disconnect) return res.destroy()
      return json(res, { status: settings.upgradeOk ? 1 : 0, error_code: settings.upgradeOk ? 0 : 297000 })
    }
    json(res, { status: 0 }, 404)
  })
  config.meting.kugou.upstream.liteUrl = mock.url
  config.meting.kugou.upstream.defaultUrl = mock.url
})
after(() => mock.close())
beforeEach(async () => {
  settings = { claimed: false, recordOk: true, listenOk: true, claimOk: true, addRecord: true, upgradeOk: true, extend: true, extended: false }
  requests = []
  await updateKugouAdminState(state => {
    state.accounts = {}
    for (const pool of ['premium', 'general']) state.pools[pool].lastClaimResult = null
  })
})
const writes = () => requests.filter(r => ['/youth/listen/song', '/youth/day/vip', '/youth/day/vip/upgrade'].includes(r.url.pathname))

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

test('daily claim uses today explicitly then upgrades once and verifies changed product expiry', async () => {
  const result = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(result.ok, true)
  assert.equal(result.evidence.claim.state, 'confirmed')
  assert.equal(result.evidence.upgrade.state, 'confirmed')
  assert.equal(result.evidence.upgrade.changes[0].id, 'concept/svip')
  assert.deepEqual(writes().map(r => r.url.pathname), ['/youth/listen/song', '/youth/day/vip', '/youth/day/vip/upgrade'])
  assert.equal(writes()[1].url.searchParams.get('receive_day'), getKugouVipDay())
  assert.equal(requests.some(r => r.url.pathname === '/youth/vip'), false)
  assert.equal(JSON.stringify(result.evidence).includes('private'), false)
})

test('existing VIP cannot mask a failed listen or claim', async () => {
  settings.listenOk = false
  let result = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(result.ok, false)
  assert.equal(writes().length, 1)
  settings.listenOk = true
  settings.claimOk = false
  requests = []
  result = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(result.ok, false)
  assert.equal(result.evidence.claim.state, 'failed')
  assert.equal(requests.some(r => r.url.pathname.endsWith('/upgrade')), false)
})

test('already claimed today skips listening and daily write, while failed record reads perform no writes', async () => {
  settings.claimed = true
  const result = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(result.ok, true)
  assert.equal(result.evidence.claim.alreadyReceived, true)
  assert.deepEqual(writes().map(r => r.url.pathname), ['/youth/day/vip/upgrade'])
  settings.recordOk = false
  requests = []
  assert.equal((await claimAndUpgradeKugouLiteVip(cookie, 'general')).ok, false)
  assert.equal(writes().length, 0)
})

test('accepted daily request without a record stays pending and is not submitted again', async () => {
  settings.addRecord = false
  const first = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(first.ok, false)
  assert.equal(first.evidence.claim.state, 'accepted')
  requests = []
  const second = await claimAndUpgradeKugouLiteVip(cookie, 'general', { previousResult: first })
  assert.equal(second.ok, false)
  assert.equal(writes().length, 0)
})

test('upgrade acceptance is pending until readback changes, and retries only read', async () => {
  settings.claimed = true
  settings.extend = false
  const first = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(first.ok, false)
  assert.equal(first.evidence.upgrade.state, 'accepted')
  requests = []
  settings.extended = true
  const second = await claimAndUpgradeKugouLiteVip(cookie, 'general', { previousResult: first })
  assert.equal(second.ok, true)
  assert.equal(second.evidence.upgrade.state, 'confirmed')
  assert.equal(writes().length, 0)
})

test('an upgrade timeout is uncertain and never repeats its reward write that day', async () => {
  settings.claimed = true
  settings.disconnect = true
  const first = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(first.ok, false)
  assert.equal(first.evidence.upgrade.state, 'uncertain')
  requests = []
  await claimAndUpgradeKugouLiteVip(cookie, 'general', { previousResult: first })
  assert.equal(writes().length, 0)
})

test('an upstream reward refusal is shown truthfully and same-day rechecks cannot repeat the upgrade', async () => {
  settings.claimed = true
  settings.upgradeOk = false
  const first = await claimAndUpgradeKugouLiteVip(cookie, 'general')
  assert.equal(first.ok, false)
  assert.match(first.message, /297000/)
  requests = []
  const recheck = await claimAndUpgradeKugouLiteVip(cookie, 'general', { previousResult: first })
  assert.equal(recheck.evidence.upgrade.state, 'failed')
  assert.match(recheck.message, /297000/)
  assert.equal(writes().length, 0)
})

test('daily schedules use UTC+8, always stay in the future, and completed days move to tomorrow', t => {
  t.mock.method(Math, 'random', () => 0)
  const now = Date.parse('2026-11-16T14:00:00+08:00')
  assert.equal(buildNextClaimAt({ now }), '2026-11-16T06:01:00.000Z')
  assert.equal(buildNextClaimAt({ now, tomorrow: true }), '2026-11-17T01:00:00.000Z')
  assert.equal(buildNextClaimAt({ now: Date.parse('2026-11-16T21:00:00+08:00') }), '2026-11-17T01:00:00.000Z')
})

test('additional accounts claim and upgrade in place; pool and account actions share deduplication', async () => {
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
  assert.equal(writes().length, 0)
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

test('automatic pool and additional-account jobs use the upgrade flow and skip paused accounts', async () => {
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
  assert.deepEqual(writes().filter(r => r.url.pathname.endsWith('/upgrade')).map(r => parseSimpleCookie(r.headers.cookie).userid), ['10001', '10002'])
  assert.equal(requests.some(r => r.url.pathname === '/youth/vip'), false)
})
