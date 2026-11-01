import './setup.js'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { requestKugouUpstream } from '../src/utils/kugou-upstream-client.js'
import { requestKugouUpstream as requestAuth } from '../src/utils/kugou-upstream-auth.js'
import { createMockUpstream, json } from './helpers.js'

let mock
let handler
before(async () => { mock = await createMockUpstream((req, res) => handler(req, res)) })
after(() => mock.close())
beforeEach(() => {
  config.meting.kugou.upstream.defaultUrl = `${mock.url}/default/`
  config.meting.kugou.upstream.liteUrl = `${mock.url}/lite`
  config.meting.kugou.upstream.timeoutMs = 1000
  mock.requests.length = 0
  handler = (_, res) => json(res, { status: 1 })
})

test('selects the pool upstream and preserves zero/false query values', async () => {
  await requestKugouUpstream('/test', { pool: 'general', query: { zero: 0, flag: false, empty: '', absent: null } })
  const { url } = mock.requests[0]
  assert.equal(url.pathname, '/lite/test')
  assert.equal(url.searchParams.get('zero'), '0')
  assert.equal(url.searchParams.get('flag'), 'false')
  assert.equal(url.searchParams.has('empty'), false)
  assert.equal(url.searchParams.has('absent'), false)
})

test('shares JSON envelope handling with login and preserves Set-Cookie', async () => {
  handler = (_, res) => {
    res.setHeader('set-cookie', ['token=fixture; Path=/', 'userid=123; Path=/'])
    res.end('<!--KG_TAG_RES_START-->{"status":1}<!--KG_TAG_RES_END-->')
  }
  const response = await requestAuth('/login')
  assert.deepEqual(response.body, { status: 1 })
  assert.equal(response.status, 200)
  assert.equal(response.cookies.length, 2)
  assert.match(response.text, /KG_TAG_RES_START/)
})

test('sends JSON bodies and authentication headers', async () => {
  await requestKugouUpstream('/post', {
    method: 'POST', cookie: 'token=fixture', body: { value: 1 }, headers: { 'X-Fixture': 'yes' }
  })
  assert.equal(mock.requests[0].headers.cookie, 'token=fixture')
  assert.equal(mock.requests[0].headers['x-fixture'], 'yes')
  assert.deepEqual(JSON.parse(mock.requests[0].body), { value: 1 })
})

test('retains HTTP failures for callers to inspect', async () => {
  handler = (_, res) => json(res, { error_code: 401, message: 'expired' }, 401)
  const response = await requestKugouUpstream('/expired')
  assert.equal(response.ok, false)
  assert.equal(response.status, 401)
  assert.equal(response.body.message, 'expired')
})

test('rejects invalid JSON instead of presenting an empty successful response', async () => {
  handler = (_, res) => res.end('<html>bad gateway</html>')
  await assert.rejects(requestKugouUpstream('/bad'), { code: 'INVALID_RESPONSE', status: 200 })
})

test('rejects primitive JSON', async () => {
  handler = (_, res) => res.end('null')
  await assert.rejects(requestKugouUpstream('/bad'), { code: 'INVALID_RESPONSE' })
})

test('aborts slow upstreams', async () => {
  config.meting.kugou.upstream.timeoutMs = 30
  handler = () => {}
  await assert.rejects(requestKugouUpstream('/slow'), { code: 'TIMEOUT' })
})

test('classifies a broken connection', async () => {
  handler = (_, res) => res.destroy()
  await assert.rejects(requestKugouUpstream('/disconnect'), { code: 'NETWORK_ERROR' })
})

test('does not send a request when the upstream is disabled', async () => {
  config.meting.kugou.upstream.defaultUrl = ''
  assert.equal(await requestKugouUpstream('/disabled'), null)
  assert.equal(mock.requests.length, 0)
})
