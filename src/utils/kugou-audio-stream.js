import { HTTPException } from 'hono/http-exception'
import config from '../config.js'

const responseHeaders = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'cache-control'
]

// The URL comes from the authenticated resource resolver, never a URL query
// parameter. Keep HTTP-only upstream media behind the API's HTTPS origin.
export const streamKugouAudio = async (c, url) => {
  const headers = new Headers({ 'Accept-Encoding': 'identity' })
  for (const name of ['range', 'if-range']) {
    const value = c.req.header(name)
    if (value) headers.set(name, value)
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  const signal = c.req.raw.signal
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), Math.max(1, config.meting.kugou.upstream.timeoutMs))
  try {
    const response = await fetch(url, {
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      signal: controller.signal
    })
    const outgoing = new Headers()
    for (const name of responseHeaders) {
      const value = response.headers.get(name)
      if (value) outgoing.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: outgoing })
  } catch (error) {
    c.get('logger')?.warn({ error: error.name }, 'Kugou audio connection failed')
    throw new HTTPException(502, { message: '音频上游连接失败' })
  } finally {
    // Only the connection and headers have a deadline. The track itself streams
    // until completion or client cancellation, including slow playback clients.
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
