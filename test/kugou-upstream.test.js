import './setup.js'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import { canUseKugouUpstream, getKugouUpstreamData } from '../src/utils/kugou-upstream.js'
import { createMockUpstream, json } from './helpers.js'

let mock
let handler
let sequence = 0
before(async () => { mock = await createMockUpstream((req, res) => handler(req, res)) })
after(() => mock.close())
beforeEach(() => {
  config.meting.kugou.upstream.defaultUrl = `${mock.url}/run-${++sequence}`
  config.meting.kugou.upstream.liteUrl = `${mock.url}/lite-${sequence}`
  mock.requests.length = 0
})

test('coalesces concurrent device registration and keeps pool devices separate', async () => {
  handler = (req, res) => {
    if (req.url.pathname.endsWith('/register/dev')) {
      setTimeout(() => json(res, { data: { dfid: 'fixture-device' } }), 25)
    } else {
      json(res, { url: ['https://audio.example/song.mp3'] })
    }
  }
  const calls = Array.from({ length: 8 }, () => getKugouUpstreamData({ type: 'url', id: 'ABC' }))
  const results = await Promise.all(calls)
  assert.ok(results.every(item => item.url === 'https://audio.example/song.mp3'))
  assert.equal(mock.requests.filter(req => req.url.pathname.endsWith('/register/dev')).length, 1)
  await getKugouUpstreamData({ type: 'url', id: 'ABC', pool: 'general' })
  assert.equal(mock.requests.filter(req => req.url.pathname.endsWith('/register/dev')).length, 2)
})

test('reuses a cookie device and forwards composite song identifiers', async () => {
  handler = (_, res) => json(res, { url: ['https://audio.example/song.mp3'] })
  await getKugouUpstreamData({ type: 'url', id: 'abc|123', cookie: 't=fixture; KugooID=456; dfid=existing' })
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].url.searchParams.get('hash'), 'ABC')
  assert.equal(mock.requests[0].url.searchParams.get('album_audio_id'), '123')
  assert.match(mock.requests[0].headers.cookie, /dfid=existing/)
  assert.match(mock.requests[0].headers.cookie, /token=fixture/)
})

test('preserves an HTTP playback URL supplied by a lite CDN', async () => {
  handler = (_, res) => json(res, { url: ['http://audio.example/song.mp3?signature=fixture'] })
  const result = await getKugouUpstreamData({ type: 'url', id: 'ABC', cookie: 'dfid=existing' })
  assert.equal(result.url, 'http://audio.example/song.mp3?signature=fixture')
})

test('maps a complete playlist to Meting resource identifiers', async () => {
  handler = (req, res) => req.url.pathname.endsWith('/playlist/detail')
    ? json(res, { data: [{ global_collection_id: '123', count: 1 }] })
    : json(res, { data: { songs: [{ hash: 'abc', name: 'Singer - Title', mixsongid: 42, singerinfo: [{ name: 'Singer' }] }] } })
  const result = await getKugouUpstreamData({ type: 'playlist', id: '123' })
  assert.deepEqual(result, [{ hash: 'ABC', title: 'Title', author: 'Singer', url_id: 'ABC|42', pic_id: 'ABC', lyric_id: 'ABC' }])
})

test('does not return a partial playlist if a subsequent page fails', async () => {
  handler = (req, res) => {
    if (req.url.pathname.endsWith('/playlist/detail')) return json(res, { data: [{ global_collection_id: '123', count: 301 }] })
    if (req.url.searchParams.get('page') === '1') {
      return json(res, { data: { songs: Array.from({ length: 300 }, (_, i) => ({ hash: `hash${i}` })) } })
    }
    json(res, { message: 'failed' }, 503)
  }
  assert.equal(await getKugouUpstreamData({ type: 'playlist', id: '123' }), null)
})

test('does not return a playlist shorter than the declared count', async () => {
  handler = (req, res) => req.url.pathname.endsWith('/playlist/detail')
    ? json(res, { data: [{ global_collection_id: '123', count: 10 }] })
    : json(res, { data: { songs: [{ hash: 'abc' }] } })
  assert.equal(await getKugouUpstreamData({ type: 'playlist', id: '123' }), null)
})

test('preserves a valid empty playlist', async () => {
  handler = (req, res) => req.url.pathname.endsWith('/playlist/detail')
    ? json(res, { data: [{ global_collection_id: '123', count: 0 }] })
    : json(res, { data: { songs: [] } })
  assert.deepEqual(await getKugouUpstreamData({ type: 'playlist', id: '123' }), [])
})

test('invalid resource responses fall back instead of escaping as a successful result', async () => {
  handler = (_, res) => res.end('invalid JSON')
  assert.equal(await getKugouUpstreamData({ type: 'song', id: 'ABC' }), null)
})

test('unsupported operations and disabled upstreams are not marked as attempts', async () => {
  assert.equal(canUseKugouUpstream('search'), false)
  assert.equal(await getKugouUpstreamData({ type: 'search', id: 'hello' }), null)
  config.meting.kugou.upstream.defaultUrl = ''
  assert.equal(canUseKugouUpstream('song'), false)
  assert.equal(mock.requests.length, 0)
})
