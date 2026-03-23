import config from '../config.js'
import { parseKugouCookie } from './kugou-songinfo.js'

const getBaseUrl = () => String(config.meting.kugou.upstream.url || '').trim().replace(/\/+$/, '')

const normalizeText = (value) => String(value || '').trim()

const request = async (path, { query = {}, cookie = '' } = {}) => {
  const baseUrl = getBaseUrl()
  if (!baseUrl) return null

  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  const headers = {
    Accept: 'application/json, text/plain, */*'
  }
  if (cookie) headers.Cookie = cookie

  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(config.meting.kugou.upstream.timeoutMs)
  })

  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : []
  const text = await response.text()
  let body = null

  try {
    body = JSON.parse(text)
  } catch (error) {
    body = null
  }

  return {
    ok: response.ok,
    body,
    text,
    cookies: setCookie
  }
}

const mergeCookies = (cookies = []) => {
  const out = {}
  for (const line of cookies) {
    const item = String(line || '').split(';')[0]
    const idx = item.indexOf('=')
    if (idx === -1) continue
    out[item.slice(0, idx)] = item.slice(idx + 1)
  }
  return out
}

const getAuthCookie = (cookie = '') => {
  const parsed = parseKugouCookie(cookie)
  const out = []
  if (parsed.t) out.push(`token=${parsed.t}`)
  if (parsed.KugooID) out.push(`userid=${parsed.KugooID}`)
  if (parsed.t1 !== undefined) out.push(`t1=${parsed.t1}`)
  if (parsed.vip_type !== undefined) out.push(`vip_type=${parsed.vip_type}`)
  if (parsed.vip_token !== undefined) out.push(`vip_token=${parsed.vip_token}`)
  if (parsed.dfid) out.push(`dfid=${parsed.dfid}`)
  if (parsed.mid) out.push(`KUGOU_API_MID=${parsed.mid}`)
  return out.join('; ')
}

export const hasKugouUpstreamAuth = () => Boolean(getBaseUrl())

export const fetchKugouQrLogin = async () => {
  const keyResp = await request('/login/qr/key', { query: { timestamp: Date.now() } })
  const key = keyResp?.body?.data?.qrcode
  if (!key) return null

  const qrResp = await request('/login/qr/create', {
    query: {
      key,
      qrimg: 1,
      timestamp: Date.now()
    }
  })

  return {
    key,
    url: qrResp?.body?.data?.url || '',
    base64: qrResp?.body?.data?.base64 || ''
  }
}

export const checkKugouQrLogin = async (key) => {
  const response = await request('/login/qr/check', {
    query: {
      key,
      timestamp: Date.now()
    }
  })

  const status = Number(response?.body?.data?.status || 0)
  const cookieMap = mergeCookies(response?.cookies || [])

  return {
    status,
    token: normalizeText(cookieMap.token),
    userid: normalizeText(cookieMap.userid),
    cookieMap,
    body: response?.body || null
  }
}

export const refreshKugouLogin = async (cookie) => {
  const response = await request('/login/token', {
    query: { timestamp: Date.now() },
    cookie: getAuthCookie(cookie)
  })

  return {
    body: response?.body || null,
    cookieMap: mergeCookies(response?.cookies || [])
  }
}

export const fetchKugouLoginProfile = async (cookie) => {
  const authCookie = getAuthCookie(cookie)
  const [detailResp, vipResp] = await Promise.all([
    request('/user/detail', { query: { timestamp: Date.now() }, cookie: authCookie }),
    request('/user/vip/detail', { query: { timestamp: Date.now() }, cookie: authCookie })
  ])

  return {
    detail: detailResp?.body || null,
    vip: vipResp?.body || null
  }
}

export const registerKugouDevice = async () => {
  const response = await request('/register/dev', { query: { timestamp: Date.now() } })
  return {
    body: response?.body || null,
    cookieMap: mergeCookies(response?.cookies || [])
  }
}
