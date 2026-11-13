import config from '../config.js'
import { getKugouPoolUpstreamUrl } from './kugou-upstream-runtime.js'
import { kugouAuthSummary, logKugouAuth } from './kugou-auth-log.js'

export class KugouUpstreamError extends Error {
  constructor (message, { code, status, cause } = {}) {
    super(message, { cause })
    this.name = 'KugouUpstreamError'
    this.code = code
    this.status = status
  }
}

const stripEnvelope = text => {
  const startTag = '<!--KG_TAG_RES_START-->'
  const endTag = '<!--KG_TAG_RES_END-->'
  const start = text.indexOf(startTag)
  const end = text.lastIndexOf(endTag)
  return start !== -1 && end > start
    ? text.slice(start + startTag.length, end).trim()
    : text.trim()
}

// Keep HTTP status, response text and Set-Cookie together for login callers.
// Resource callers decide whether a failed response should fall back to Meting.
export const requestKugouUpstream = async (path, {
  query = {}, cookie = '', method = 'GET', body = null, headers: extraHeaders = {}, pool = 'premium'
} = {}) => {
  const baseUrl = getKugouPoolUpstreamUrl(pool).replace(/\/+$/, '')
  if (!baseUrl) return null

  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const headers = new Headers({
    Accept: 'application/json, text/plain, */*',
    // The upstream cache keys only on the URL and can replay another login's cookies.
    'X-Apicache-Bypass': '1'
  })
  if (cookie) headers.set('Cookie', cookie)
  for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value)
  if (body !== null) headers.set('Content-Type', 'application/json; charset=utf-8')

  const traceAuth = /^\/(login\/|captcha\/|register\/dev|user\/detail|user\/vip\/detail)/.test(path)
  if (traceAuth) logKugouAuth(pool, 'request', { path, auth: kugouAuthSummary(cookie) })

  let response
  let text
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, config.meting.kugou.upstream.timeoutMs))
    })
    text = await response.text()
  } catch (cause) {
    const code = cause.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR'
    if (traceAuth) logKugouAuth(pool, 'error', { path, code })
    throw new KugouUpstreamError(`Kugou upstream ${code.toLowerCase()}`, { code, cause })
  }

  let parsed
  try {
    parsed = JSON.parse(stripEnvelope(text))
    if (parsed === null || typeof parsed !== 'object') throw new Error('Expected JSON object or array')
  } catch (cause) {
    if (traceAuth) logKugouAuth(pool, 'error', { path, code: 'INVALID_RESPONSE', httpStatus: response.status })
    throw new KugouUpstreamError('Kugou upstream returned invalid JSON', {
      code: 'INVALID_RESPONSE', status: response.status, cause
    })
  }

  if (traceAuth) {
    logKugouAuth(pool, 'response', {
      path,
      httpStatus: response.status,
      status: parsed.status ?? null,
      errorCode: parsed.error_code ?? parsed.errcode ?? null,
      qrStatus: path === '/login/qr/check' ? parsed.data?.status ?? null : null,
      auth: kugouAuthSummary(response.headers.getSetCookie().map(line => line.split(';')[0]).join('; '))
    })
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    text,
    cookies: response.headers.getSetCookie()
  }
}
