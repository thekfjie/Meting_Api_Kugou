import './setup.js'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import config from '../src/config.js'
import { createApp } from '../src/app.js'
import { createAdminSession, copyCookiePool, moveCookiePool, parseSimpleCookie } from '../src/utils/admin.js'
import { applyKugouPoolCookieMap, refreshKugouPool } from '../src/utils/kugou-admin-actions.js'
import { readCookieFile } from '../src/utils/cookie.js'
import { getKugouAdminSession } from '../src/utils/kugou-admin-state.js'
import { buildKugouUpstreamAuthCookie } from '../src/utils/kugou-upstream-auth.js'
import { kugouAuthSummary } from '../src/utils/kugou-auth-log.js'
import { createMockUpstream, json } from './helpers.js'

let mock
let handler
const device = pool => ({
  KUGOU_API_PLATFORM: pool === 'general' ? 'lite' : 'default',
  KUGOU_API_GUID: `${pool}-guid`,
  KUGOU_API_DEV: `${pool}-dev`,
  KUGOU_API_MAC: `${pool}-mac`,
  KUGOU_API_MID: `${pool}-mid`,
  dfid: `${pool}-dfid`
})
const credentials = pool => ({ ...device(pool), token: `${pool}-token`, userid: '123456' })
const cookieFor = pool => `t=${pool}-token; KugooID=123456; ` + Object.entries(device(pool)).map(([k, v]) => `${k}=${v}`).join('; ')

before(async () => { mock = await createMockUpstream((req, res) => handler(req, res)) })
after(() => mock.close())
beforeEach(() => {
  config.admin.password = 'fixture-password'
  config.meting.kugou.upstream.defaultUrl = `${mock.url}/default`
  config.meting.kugou.upstream.liteUrl = `${mock.url}/lite`
  mock.requests.length = 0
  handler = (req, res) => json(res, req.url.pathname.endsWith('/user/detail')
    ? { status: 1, data: { userid: '123456', nickname: 'fixture' } }
    : { status: 1, data: { vip_type: 1 } })
})

test('auth and playback requests retain every login device field', () => {
  for (const pool of ['premium', 'general']) {
    const cookie = parseSimpleCookie(buildKugouUpstreamAuthCookie({ cookie: cookieFor(pool) }))
    assert.equal(cookie.token, `${pool}-token`)
    assert.equal(cookie.userid, '123456')
    for (const [key, value] of Object.entries(device(pool))) assert.equal(cookie[key], value)
  }
})

test('same account keeps independent tokens and devices through alternating refreshes', async () => {
  for (const pool of ['premium', 'general']) assert.equal((await applyKugouPoolCookieMap(pool, credentials(pool))).ok, true)
  const beforeGeneral = await readCookieFile('kugou', 'general')
  handler = (req, res) => {
    if (req.url.pathname.endsWith('/login/token')) {
      const pool = req.url.pathname.startsWith('/lite') ? 'general' : 'premium'
      const cookie = parseSimpleCookie(req.headers.cookie)
      // Simulate an upstream restart: its process defaults no longer match the login.
      assert.equal(cookie.KUGOU_API_GUID, `${pool}-guid`)
      assert.equal(cookie.KUGOU_API_DEV, `${pool}-dev`)
      assert.equal(cookie.KUGOU_API_MID, `${pool}-mid`)
      assert.equal(req.headers['x-apicache-bypass'], '1')
      res.setHeader('set-cookie', [`token=${pool}-refreshed`, 'userid=123456'])
    }
    json(res, { status: 1, data: { userid: '123456', vip_type: 1 } })
  }
  assert.equal((await refreshKugouPool('premium')).ok, true)
  assert.equal(await readCookieFile('kugou', 'general'), beforeGeneral)
  const premium = await readCookieFile('kugou', 'premium')
  assert.equal((await refreshKugouPool('general')).ok, true)
  assert.equal(await readCookieFile('kugou', 'premium'), premium)
  assert.equal(parseSimpleCookie(premium).t, 'premium-refreshed')
  assert.equal(parseSimpleCookie(await readCookieFile('kugou', 'general')).t, 'general-refreshed')
})

test('failed login and cross-version writes keep the existing working cookie', async () => {
  const beforeCookie = await readCookieFile('kugou', 'premium')
  for (const bad of [device('premium'), { ...credentials('premium'), token: 'undefined' }, credentials('general')]) {
    assert.equal((await applyKugouPoolCookieMap('premium', bad)).ok, false)
    assert.equal(await readCookieFile('kugou', 'premium'), beforeCookie)
  }
  await assert.rejects(copyCookiePool('premium', 'general'), /单独登录/)
  await assert.rejects(moveCookiePool('premium', 'general'), /单独登录/)
})

test('refresh refuses missing credentials and a different user ID', async () => {
  const beforeCookie = await readCookieFile('kugou', 'premium')
  for (const cookies of [[], ['token=wrong-user-token', 'userid=999999']]) {
    handler = (_, res) => {
      if (cookies.length) res.setHeader('set-cookie', cookies)
      json(res, { status: 1 })
    }
    assert.equal((await refreshKugouPool('premium')).ok, false)
    assert.equal(await readCookieFile('kugou', 'premium'), beforeCookie)
  }
})

test('two pending QR logins use their own device, platform and target pool', async () => {
  handler = (req, res) => {
    const pool = req.url.pathname.startsWith('/lite') ? 'general' : 'premium'
    if (req.url.pathname.endsWith('/register/dev')) {
      res.setHeader('set-cookie', Object.entries(device(pool)).map(([k, v]) => `${k}=${v}`))
      return json(res, { status: 1 })
    }
    assert.equal(parseSimpleCookie(req.headers.cookie).KUGOU_API_GUID, `${pool}-guid`)
    if (req.url.pathname.endsWith('/login/qr/key')) return json(res, { status: 1, data: { qrcode: `${pool}-qr` } })
    if (req.url.pathname.endsWith('/login/qr/create')) return json(res, { data: { url: 'https://fixture.test/qr' } })
    if (req.url.pathname.endsWith('/login/qr/check')) {
      assert.equal(req.url.searchParams.get('key'), `${pool}-qr`)
      res.setHeader('set-cookie', [`token=${pool}-qr-token`, 'userid=123456'])
      return json(res, { data: { status: 4 } })
    }
    json(res, { status: 1, data: { userid: '123456', vip_type: 1 } })
  }
  const app = createApp()
  const post = async (action, pool) => {
    const response = await app.request(`/music/manage/kugou/qr/${action}?format=json`, {
      method: 'POST',
      headers: { Cookie: `meting_admin_session=${createAdminSession()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pool })
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  for (const pool of ['premium', 'general']) assert.equal((await post('start', pool)).ok, true)
  for (const pool of ['general', 'premium']) {
    assert.equal((await post('check', pool)).status, 4)
    assert.equal((await getKugouAdminSession('qrLogin', pool)).key, `${pool}-qr`)
    assert.equal((await post('apply', pool)).ok, true)
    assert.equal(await getKugouAdminSession('qrLogin', pool), null)
  }
  for (const pool of ['premium', 'general']) {
    assert.equal(parseSimpleCookie(await readCookieFile('kugou', pool)).t, `${pool}-qr-token`)
  }
})

test('QR URLs identify the intended client version', async () => {
  const require = createRequire(import.meta.url)
  const createQr = require('../KuGouMusicApi/module/login_qr_create.js')
  const oldPlatform = process.env.platform
  try {
    for (const [platform, appid] of [['default', '1005'], ['lite', '3116']]) {
      process.env.platform = platform
      const result = await createQr({ key: 'fixture-key' })
      assert.equal(new URL(result.body.data.url).searchParams.get('appid'), appid)
    }
  } finally {
    if (oldPlatform === undefined) delete process.env.platform
    else process.env.platform = oldPlatform
  }
})

test('diagnostic summaries never contain raw account tokens or device identifiers', () => {
  const summary = JSON.stringify(kugouAuthSummary(cookieFor('premium')))
  for (const secret of ['123456', 'premium-token', 'premium-guid', 'premium-mid']) assert.equal(summary.includes(secret), false)
})
