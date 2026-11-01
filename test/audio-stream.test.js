import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import config from '../src/config.js'
import { createApp } from '../src/app.js'
import { createMockUpstream, json } from './helpers.js'

test('HTTP audio stays on the API origin and preserves ranges and bytes', async () => {
  const audio = Buffer.from('ID3-fixture-audio-bytes')
  const mock = await createMockUpstream((req, res) => {
    if (req.url.pathname === '/register/dev') return json(res, { data: { dfid: 'fixture' } })
    if (req.url.pathname === '/song/url') return json(res, { url: [`${mock.url}/audio`] })
    if (req.url.pathname === '/audio') {
      assert.equal(req.headers.range, 'bytes=0-7')
      assert.equal(req.headers.cookie, undefined)
      assert.equal(req.headers.authorization, undefined)
      res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-7/${audio.length}`, 'accept-ranges': 'bytes' })
      return res.end(audio.subarray(0, 8))
    }
    json(res, {}, 404)
  })
  config.meting.url = 'https://api.example'
  config.meting.kugou.upstream.liteUrl = mock.url
  const auth = createHmac('sha1', config.meting.token).update('kugouurlSTREAM').digest('hex')
  try {
    const app = createApp()
    const redirect = await app.request(`/music?server=kugou&type=url&id=STREAM&auth=${auth}`)
    assert.equal(redirect.status, 302)
    const location = new URL(redirect.headers.get('location'))
    assert.equal(location.origin, 'https://api.example')
    assert.equal(location.pathname, '/music/stream')
    const response = await app.request(location.toString(), { headers: { Range: 'bytes=0-7', Cookie: 'must-not-forward=1' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 0-7/${audio.length}`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio.subarray(0, 8))
  } finally {
    await mock.close()
  }
})

test('audio forwarding requires a signed Kugou resource', async () => {
  const app = createApp()
  assert.equal((await app.request('/music/stream?server=kugou&type=url&id=BAD')).status, 401)
  assert.equal((await app.request('/music/stream?server=netease&type=url&id=BAD')).status, 400)
  assert.equal((await app.request('/api/stream?server=kugou&type=song&id=BAD')).status, 400)
})
