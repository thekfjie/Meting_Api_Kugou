import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { summarizeKugouProfile, claimKugouLiteVip, runKugouAccountAction } from '../src/utils/kugou-admin-actions.js'
import { summarizeKugouMemberships, parseKugouVipTime } from '../src/utils/kugou-membership.js'
import { saveKugouAccount, listKugouAccounts } from '../src/utils/kugou-accounts.js'
import { writeCookiePool, parseSimpleCookie } from '../src/utils/admin.js'
import { readCookieFile } from '../src/utils/cookie.js'
import { page } from '../src/service/admin.js'
import { createMockUpstream, json } from './helpers.js'

const vipData = {
  vip_end_time: '2025-01-01 00:00:00',
  su_vip_end_time: '2025-02-01 00:00:00',
  busi_vip: [
    { busi_type: 'concept', product_type: 'svip', is_vip: 1, vip_end_time: '2030-01-01 00:00:00', vip_token: 'private-vip-token' },
    { busi_type: 'concept', product_type: 'tvip', is_vip: 1, vip_end_time: '2030-02-01 00:00:00' }
  ]
}

test('membership display keeps all product dates and separates expired regular products from concept products', () => {
  const items = summarizeKugouProfile({ vip: { data: vipData } }).memberships
  assert.equal(items.length, 4)
  assert.equal(items.find(x => x.id === 'concept/svip').expireTime, '2030-01-01 00:00:00')
  assert.equal(items.find(x => x.id === 'concept/tvip').expireTime, '2030-02-01 00:00:00')
  assert.equal(items.find(x => x.id === 'regular/svip').status, 'expired')
  assert.equal(JSON.stringify(items).includes('private-vip-token'), false)
})

test('membership dates use UTC+8 and never mistake a quota reset date for expiry', () => {
  assert.equal(parseKugouVipTime('2030-01-01 00:00:00'), Date.parse('2029-12-31T16:00:00Z'))
  assert.equal(parseKugouVipTime('0000-00-00 00:00:00'), 0)
  const data = { busi_vip: [{ ...vipData.busi_vip[0], vip_end_time: 'invalid', vip_clearday: '2099-01-01 00:00:00' }] }
  assert.equal(summarizeKugouMemberships(data)[0].expireTime, '')
})

test('existing account panel shows all memberships and escapes labels without exposing credentials', async () => {
  const profile = summarizeKugouProfile({ vip: { data: vipData } })
  profile.memberships[0].name = '<script>bad()</script>'
  await saveKugouAccount('KugooID=10000; t=private-login-token; KUGOU_API_PLATFORM=lite', 'lite', profile)
  const accounts = await listKugouAccounts()
  const html = page({ basePath: '/music', pools: [], accounts, mon: {}, procs: [], logs: [], qrSessions: {}, smsSessions: {}, warnings: [], quickProcessNames: [] })
  assert.ok(html.includes('概念 TVIP'))
  assert.ok(html.includes('超级 VIP'))
  assert.ok(html.includes('已到期'))
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'))
  for (const secret of ['private-vip-token', 'private-login-token']) assert.equal(html.includes(secret), false)
})

test('stable pool and additional-account claims retain the original endpoints, credentials and listener error behavior', async () => {
  const mock = await createMockUpstream((req, res) => {
    const cookie = parseSimpleCookie(req.headers.cookie)
    if (req.url.pathname === '/user/detail') return json(res, { status: 1, data: { userid: cookie.userid, nickname: 'Fixture' } })
    if (req.url.pathname === '/user/vip/detail') return json(res, { status: 1, data: vipData })
    if (req.url.pathname === '/youth/listen/song') return json(res, { status: 0, error_code: 130012 }, 502)
    if (req.url.pathname === '/youth/vip') return json(res, { status: 1, data: { award_vip_hour: 3, done: 1, total: 8, remain: 7 } })
    json(res, { status: 0 }, 404)
  })
  config.meting.kugou.upstream.liteUrl = mock.url
  config.meting.kugou.upstream.defaultUrl = mock.url
  try {
    await writeCookiePool('general', 'KugooID=10001; t=primary-token; KUGOU_API_PLATFORM=lite')
    await saveKugouAccount('KugooID=10002; t=second-token; KUGOU_API_PLATFORM=lite', 'lite', { userId: '10002' })
    await writeCookiePool('premium', 'KugooID=10002; t=default-token; KUGOU_API_PLATFORM=default')
    assert.equal((await claimKugouLiteVip('general')).ok, true)
    const primary = await readCookieFile('kugou', 'general')
    assert.equal((await runKugouAccountAction('lite:10002', 'claim')).ok, true)
    assert.equal(await readCookieFile('kugou', 'general'), primary)
    const claims = mock.requests.filter(r => r.url.pathname === '/youth/vip')
    assert.deepEqual(claims.map(r => parseSimpleCookie(r.headers.cookie).userid), ['10001', '10002'])
    assert.equal(mock.requests.some(r => r.url.pathname.includes('/youth/day/')), false)
    assert.equal((await runKugouAccountAction('default:10002', 'claim')).ok, false)
  } finally { await mock.close() }
})
