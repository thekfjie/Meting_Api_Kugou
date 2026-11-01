import './setup.js'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import Meting from '@meting/core'
import config from '../src/config.js'
import { createApp } from '../src/app.js'
import { createMockUpstream, json } from './helpers.js'

test('health probe works without credentials or an upstream', async () => {
  const response = await createApp().request('/healthz')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
})

test('both API aliases reject unsupported providers consistently', async () => {
  const app = createApp()
  for (const alias of ['api', 'music']) {
    const response = await app.request(`/${alias}?server=invalid`)
    assert.equal(response.status, 400)
  }
})

test('both management aliases keep login and protected POST routes', async () => {
  config.admin.password = 'test-only-password'
  const app = createApp()
  for (const alias of ['api', 'music']) {
    assert.equal((await app.request(`/${alias}/manage/login`)).status, 200)
    const response = await app.request(`/${alias}/manage/pool/clear`, { method: 'POST', redirect: 'manual' })
    assert.ok([302, 303, 401, 403].includes(response.status), `protected route returned ${response.status}`)
  }
})

test('route prefix applies to the API while health remains at /healthz', async () => {
  config.http.prefix = '/prefix'
  try {
    const app = createApp()
    assert.equal((await app.request('/prefix/music?server=invalid')).status, 400)
    assert.equal((await app.request('/music')).status, 404)
    assert.equal((await app.request('/healthz')).status, 200)
  } finally {
    config.http.prefix = ''
  }
})

const upstreamServers = []
after(() => Promise.all(upstreamServers.map(server => new Promise(resolve => {
  server.close(resolve)
  server.closeAllConnections()
}))))

test('vendored upstream can start and serve health without contacting Kugou', async () => {
  process.env.PORT = '0'
  process.env.HOST = '127.0.0.1'
  const require = createRequire(import.meta.url)
  const { startService } = require('../KuGouMusicApi/server.js')
  const upstream = await startService()
  upstreamServers.push(upstream.service)
  if (!upstream.service.listening) await once(upstream.service, 'listening')
  const response = await fetch(`http://127.0.0.1:${upstream.service.address().port}/healthz`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
})

test('upstream module discovery excludes test files', async () => {
  const require = createRequire(import.meta.url)
  const { getModulesDefinitions } = require('../KuGouMusicApi/server.js')
  const { fileURLToPath } = await import('node:url')
  const definitions = await getModulesDefinitions(fileURLToPath(new URL('../KuGouMusicApi/module/', import.meta.url)), {}, false)
  assert.ok(definitions.some(item => item.route === '/comment/floor'))
  assert.equal(definitions.some(item => /\.(test|spec)$/.test(item.identifier)), false)
})

test('song output produces working signed playback, cover and lyric links', async () => {
  const mock = await createMockUpstream((req, res) => {
    const path = req.url.pathname
    if (path === '/privilege/lite') return json(res, { data: [{ hash: 'ABC123', album_audio_id: 42, name: 'Singer - Title', singername: 'Singer', info: { image: 'https://cover.example/{size}.jpg' } }] })
    if (path === '/krm/audio') return json(res, { data: [{ base: { songname: 'Title' }, authors: [{ base: { author_name: 'Singer' } }] }] })
    if (path === '/register/dev') return json(res, { data: { dfid: 'fixture-device' } })
    if (path === '/song/url') return json(res, { url: ['https://audio.example/song.mp3'] })
    if (path === '/search/lyric') return json(res, { candidates: [{ id: '123', accesskey: 'fixture' }] })
    if (path === '/lyric') return json(res, { decodeContent: '[00:00.00]fixture lyric' })
    json(res, { message: 'unexpected request' }, 404)
  })
  config.meting.kugou.upstream.liteUrl = mock.url
  config.meting.url = 'http://localhost:3000'
  try {
    const app = createApp()
    const response = await app.request('/music?server=kugou&type=song&id=ABC123')
    assert.equal(response.headers.get('x-kugou-upstream'), 'hit')
    const [song] = await response.json()
    assert.equal(song.title, 'Title')
    assert.equal(song.author, 'Singer')
    const audio = await app.request(song.url)
    assert.equal(audio.status, 302)
    assert.equal(audio.headers.get('location'), 'https://audio.example/song.mp3')
    const cover = await app.request(song.pic)
    assert.equal(cover.status, 302)
    assert.equal(cover.headers.get('location'), 'https://cover.example/400.jpg')
    assert.equal(await (await app.request(song.lrc)).text(), '[00:00.00]fixture lyric')
    const cached = await app.request('/api?server=kugou&type=song&id=ABC123')
    assert.equal(cached.headers.get('x-cache'), 'hit')
    assert.deepEqual(await cached.json(), [song])
  } finally {
    await mock.close()
    config.meting.kugou.upstream.liteUrl = ''
  }
})

test('unsupported upstream operations retain Meting compatibility and report miss', async t => {
  t.mock.method(Meting.prototype, 'search', async () => JSON.stringify([{ name: 'Fixture', artist: ['Singer'], url_id: 'ID' }]))
  const response = await createApp().request('/music?server=kugou&type=search&id=fixture-search')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-kugou-upstream'), 'miss')
  assert.equal((await response.json())[0].title, 'Fixture')
})

test('invalid upstream lyric responses fall back to Meting', async t => {
  const mock = await createMockUpstream((_, res) => res.end('not JSON'))
  config.meting.kugou.upstream.liteUrl = mock.url
  config.meting.kugou.premiumKey = 'fixture-key'
  t.mock.method(Meting.prototype, 'lyric', async () => JSON.stringify({ lyric: '[00:00.00]fallback', tlyric: '' }))
  try {
    const crypto = await import('node:crypto')
    const auth = crypto.createHmac('sha1', config.meting.token).update('kugoulrcFALLBACK').digest('hex')
    const response = await createApp().request(`/music?server=kugou&type=lrc&id=FALLBACK&auth=${auth}`)
    assert.equal(response.headers.get('x-kugou-upstream'), 'fallback-meting')
    assert.equal(await response.text(), '[00:00.00]fallback')
  } finally {
    await mock.close()
    config.meting.kugou.upstream.liteUrl = ''
  }
})

test('Meting transport failures cannot be cached as empty successful searches', async t => {
  t.mock.method(Meting.prototype, 'search', async function () {
    this.error = 'TIMEOUT'
    return '[]'
  })
  const app = createApp()
  const path = '/music?server=kugou&type=search&id=fixture-failure'
  assert.equal((await app.request(path)).status, 502)
  t.mock.method(Meting.prototype, 'search', async () => '[]')
  const retry = await app.request(path)
  assert.equal(retry.status, 200)
  assert.equal(retry.headers.get('x-cache'), 'miss')
})
