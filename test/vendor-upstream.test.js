import './setup.js'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import Meting from '@meting/core'
import { createMockUpstream, json } from './helpers.js'

const require = createRequire(import.meta.url)
const { createRequest } = require('../KuGouMusicApi/util/request.js')
const { createServer } = require('../KuGouMusicApi/server.js')
const search = require('../KuGouMusicApi/module/search.js')
const songUrl = require('../KuGouMusicApi/module/song_url_new.js')
const register = require('../KuGouMusicApi/module/register_dev.js')

let mock
let handler
before(async () => { mock = await createMockUpstream((req, res) => handler(req, res)) })
after(() => mock.close())

test('core QQ search uses the replacement endpoint and accepts old and new song fields', async () => {
  const api = new Meting('tencent').format(true)
  api._curl = async url => {
    const target = new URL(url)
    assert.equal(target.pathname, '/soso/fcgi-bin/search_for_qq_cp')
    assert.equal(target.searchParams.get('p'), '3')
    assert.equal(target.searchParams.get('n'), '2')
    assert.equal(target.searchParams.has('aggr'), false)
    api.raw = JSON.stringify({
      data: {
        song: {
          list: [
            { songmid: 'old', songname: 'Legacy', albumname: ' Album ', albummid: 'cover' },
            { mid: 'new', name: 'Modern', album: { title: ' Album ', mid: 'cover' }, singer: [{ name: 'Singer' }] }
          ]
        }
      }
    })
    return api
  }
  const result = JSON.parse(await api.search('fixture', { page: 3, limit: 2 }))
  assert.equal(result[0].id, 'old')
  assert.equal(result[0].album, 'Album')
  assert.deepEqual(result[0].artist, [])
  assert.equal(result[1].id, 'new')
  assert.deepEqual(result[1].artist, ['Singer'])
})

test('Lite search signs requests with its platform and preserves pagination and explicit zero', async () => {
  const previous = process.env.platform
  try {
    process.env.platform = 'lite'
    for (const type of ['song', 'album']) {
      const request = search({ type, keyword: 'fixture', page: 2, pagesize: 5, iscorrection: 0, cookie: { token: 'fixture' } }, value => value)
      assert.equal(request.params.clientver, 201)
      assert.equal(request.params.page, 2)
      assert.equal(request.params.pagesize, 5)
      assert.equal(request.params.iscorrection, 0)
      assert.equal(request.headers['x-router'], 'complexsearch.kugou.com')
      assert.equal(request.cookie.token, 'fixture')
    }
    process.env.platform = 'default'
    assert.equal(search({ keywords: 'fixture' }, value => value).params.clientver, undefined)
  } finally {
    if (previous === undefined) delete process.env.platform
    else process.env.platform = previous
  }
})

test('playback uses the HTTPS gateway while retaining session device and credentials', () => {
  const request = songUrl({ hash: 'ABC', cookie: { token: 'fixture', userid: '42', dfid: 'device', KUGOU_API_MID: 'mid' } }, value => value)
  assert.equal(request.baseURL, 'https://gateway.kugou.com')
  assert.equal(request.headers['x-router'], 'tracker.kugou.com')
  assert.equal(request.cookie.dfid, 'device')
  assert.equal(request.data.token, 'fixture')
  assert.equal(request.data.userid, '42')
})

test('device registration uses v3 without replacing the saved device identity', async () => {
  const sentinel = new Error('fixture')
  await assert.rejects(register({ cookie: { KUGOU_API_GUID: 'saved-guid', token: 'fixture' } }, async request => {
    assert.equal(request.url, '/risk/v3/r_register_dev')
    assert.equal(request.cookie.KUGOU_API_GUID, 'saved-guid')
    throw sentinel
  }), sentinel)
})

test('device registration recovers an empty v3 identifier once and rejects an empty fallback', async () => {
  const util = require('../KuGouMusicApi/util/index.js')
  const decrypt = util.playlistAesDecrypt
  const cookie = { KUGOU_API_GUID: 'saved-guid', token: 'fixture' }
  const calls = []
  let legacyDfid = 'fixture-device'
  util.playlistAesDecrypt = ({ str }) => JSON.parse(Buffer.from(str, 'base64').toString())
  try {
    const useAxios = async request => {
      calls.push(request)
      return {
        status: 200,
        cookie: [],
        body: Buffer.from(JSON.stringify({ status: 1, data: { dfid: request.url.includes('/v2/') ? legacyDfid : '' } }))
      }
    }
    const response = await register({ cookie }, useAxios)
    assert.deepEqual(calls.map(r => r.url), ['/risk/v3/r_register_dev', '/risk/v2/r_register_dev'])
    assert.ok(calls.every(r => r.cookie === cookie))
    assert.equal(calls[0].data, calls[1].data)
    assert.equal(calls[0].params.p, calls[1].params.p)
    assert.deepEqual(response.cookie, ['dfid=fixture-device'])
    legacyDfid = ''
    calls.length = 0
    await assert.rejects(register({ cookie }, useAxios), error => {
      assert.equal(error.status, 502)
      assert.equal(error.body.code, 'DEVICE_REGISTRATION_FAILED')
      assert.deepEqual(error.cookie, [])
      return true
    })
    assert.equal(calls.length, 2)
  } finally { util.playlistAesDecrypt = decrypt }
})

test('transport returns structured failures without serializing Axios credentials', async () => {
  handler = (_, res) => { res.destroy() }
  await assert.rejects(createRequest({ baseURL: mock.url, url: '/reset', cookie: { token: 'private-token', userid: '42' } }), error => {
    assert.equal(error.status, 502)
    assert.equal(error.body.code, 'UPSTREAM_REQUEST_FAILED')
    assert.doesNotMatch(JSON.stringify(error), /private-token|signature|AxiosError/)
    return true
  })
  handler = (_, res) => json(res, { status: 0, error_code: 20006, msg: 'expired' })
  await assert.rejects(createRequest({ baseURL: mock.url, url: '/expired' }), error => {
    assert.equal(error.body.error_code, 20006)
    return true
  })
  handler = (_, res) => { res.end('null') }
  assert.equal((await createRequest({ baseURL: mock.url, url: '/null' })).body, null)
})

test('transport aborts a stalled remote request within its deadline', { timeout: 12000 }, async () => {
  handler = () => {}
  const started = Date.now()
  await assert.rejects(createRequest({ baseURL: mock.url, url: '/stall' }), error => {
    assert.equal(error.body.code, 'UPSTREAM_TIMEOUT')
    return true
  })
  assert.ok(Date.now() - started < 11000)
})

test('HTTP upstream rejects prototype injection and survives malformed module errors', async () => {
  const app = await createServer([
    {
      route: '/inspect',
      module: async params => ({
        status: 200,
        cookie: [],
        body: {
          body: params.body,
          token: params.cookie.token,
          inheritedUser: params.cookie.userid ?? null,
          safeQuery: Object.getPrototypeOf(params) === null,
          safeCookies: Object.getPrototypeOf(params.cookie) === null
        }
      })
    },
    { route: '/error', module: async () => { throw Object.assign(new Error('fixture'), { body: { status: 0, msg: 'fixture failure' }, status: 900 }) } }
  ])
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const cookie = encodeURIComponent('__proto__=forged')
    const response = await fetch(`${base}/inspect?cookie=${cookie}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'token=fixture', 'X-Apicache-Bypass': '1' },
      body: '{"value":1,"__proto__":{"userid":"forged"},"nested":{"__proto__":{"token":"forged"}}}'
    })
    const result = await response.json()
    assert.equal(result.token, 'fixture')
    assert.equal(result.inheritedUser, null)
    assert.equal(result.safeQuery, true)
    assert.equal(result.safeCookies, true)
    assert.deepEqual(result.body, { value: 1, nested: {} })
    assert.equal((await fetch(`${base}/error`)).status, 500)
    assert.equal((await fetch(`${base}/healthz`)).status, 200)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
