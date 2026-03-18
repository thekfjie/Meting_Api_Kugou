import crypto from 'node:crypto'

const SIGN_KEY = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'

function parseCookie (cookie = '') {
  const out = {}
  for (const part of cookie.split(';')) {
    const p = part.trim()
    if (!p) continue
    const idx = p.indexOf('=')
    if (idx === -1) continue
    const key = p.slice(0, idx).trim()
    const value = p.slice(idx + 1).trim()
    if (!key) continue
    out[key] = value
  }
  return out
}

export const parseKugouCookie = parseCookie

function signature (params) {
  const sorted = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
    .split('&')
    .sort()
    .join('')

  return crypto
    .createHash('md5')
    .update(`${SIGN_KEY}${sorted}${SIGN_KEY}`)
    .digest('hex')
}

function buildSonginfoUrl (params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    q.set(k, String(v))
  }
  q.set('signature', signature(params))
  return `https://wwwapi.kugou.com/play/songinfo?${q.toString()}`
}

function normalizeCoverUrl (url, size = 400) {
  if (!url) return ''

  let out = String(url)
  if (out.includes('{size}')) {
    out = out.replace('{size}', String(size))
  }
  if (out.startsWith('http://')) {
    out = `https://${out.slice('http://'.length)}`
  }
  return out
}

export async function getKugouSonginfo ({
  hash,
  cookie
}) {
  if (!hash || !cookie) return null

  const c = parseCookie(cookie)
  const token = c.t || ''
  const userId = c.KugooID || ''
  if (!token || !userId) return null

  const mid = c.mid || c.kg_mid || ''
  const dfid = c.dfid || c.kg_dfid || ''
  const uuid = c.uuid || mid

  const now = Date.now()
  const params = {
    srcappid: '2919',
    clientver: '20000',
    clienttime: String(now),
    mid,
    uuid,
    dfid,
    appid: '1014',
    platid: '4',
    hash: String(hash).toUpperCase(),
    token,
    userid: userId
  }

  try {
    const res = await fetch(buildSonginfoUrl(params), {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0',
        Cookie: cookie
      }
    })

    if (!res.ok) return null

    const json = await res.json()
    const data = json && typeof json === 'object' ? json.data : null
    if (!data || typeof data !== 'object') return null

    return data
  } catch (error) {
    return null
  }
}

export async function getKugouCoverFromSonginfo ({
  hash,
  cookie,
  size = 400
}) {
  const data = await getKugouSonginfo({ hash, cookie })
  if (!data) return null

  const cover = data.trans_param?.union_cover || data.sizable_cover || data.img || ''
  const url = normalizeCoverUrl(cover, size)
  return url ? { url } : null
}
