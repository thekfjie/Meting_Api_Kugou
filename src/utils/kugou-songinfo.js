import crypto from 'node:crypto'

const SIGN_KEY = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const KUGOU_PUBLIC_SONGINFO_URL = 'https://m.kugou.com/app/i/getSongInfo.php'

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

function normalizeHash (hash = '') {
  return String(hash || '').trim().toUpperCase()
}

function pickFirstText (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function splitKugouFileName (fileName = '') {
  const raw = String(fileName || '').trim()
  if (!raw) {
    return { name: '', artists: [] }
  }

  const parts = raw.split(' - ')
  if (parts.length < 2) {
    return { name: raw, artists: [] }
  }

  const name = parts.pop()?.trim() || ''
  const artistText = parts.join(' - ').trim()
  if (!artistText) {
    return { name, artists: [] }
  }

  const artists = artistText
    .split(/\s*[/、,&]\s*/)
    .map(item => item.trim())
    .filter(Boolean)

  return { name, artists }
}

function extractKugouArtists (data) {
  if (Array.isArray(data?.authors) && data.authors.length > 0) {
    return data.authors
      .map(item => pickFirstText(item?.author_name, item?.name))
      .filter(Boolean)
  }

  const authorName = pickFirstText(data?.author_name, data?.singerName, data?.singer)
  if (authorName) {
    return authorName
      .split(/\s*[/、,&]\s*/)
      .map(item => item.trim())
      .filter(Boolean)
  }

  return splitKugouFileName(data?.fileName || data?.filename).artists
}

function normalizeKugouSong (data) {
  if (!data || typeof data !== 'object') return null

  const hash = normalizeHash(data.hash || data.req_hash)
  if (!hash) return null

  const fileName = pickFirstText(data.fileName, data.filename)
  const split = splitKugouFileName(fileName)
  const name = pickFirstText(data.songName, data.song_name, split.name)
  const artist = extractKugouArtists(data)

  return {
    id: hash,
    hash,
    name,
    title: name,
    artist,
    author: artist.join(' / '),
    album: pickFirstText(data.album_name, data.albumName),
    url_id: hash,
    pic_id: hash,
    lyric_id: hash,
    source: 'kugou'
  }
}

function extractKugouPublicCover (data, size = 400) {
  const cover = pickFirstText(
    data?.trans_param?.union_cover,
    data?.album_img,
    data?.imgUrl,
    data?.img,
    data?.sizable_cover
  )
  const url = normalizeCoverUrl(cover, size)
  return url ? { url } : null
}

export async function getKugouPublicSong (hash) {
  const normalizedHash = normalizeHash(hash)
  if (!normalizedHash) return null

  try {
    const res = await fetch(KUGOU_PUBLIC_SONGINFO_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'IPhone-8990-searchSong',
        'UNI-UserAgent': 'iOS11.4-Phone8990-1009-0-WiFi'
      },
      body: new URLSearchParams({
        cmd: 'playInfo',
        hash: normalizedHash,
        from: 'mkugou'
      })
    })

    if (!res.ok) return null

    const json = await res.json()
    return normalizeKugouSong(json)
  } catch (error) {
    return null
  }
}

export async function getKugouCoverFromPublicSong ({
  hash,
  size = 400
}) {
  const normalizedHash = normalizeHash(hash)
  if (!normalizedHash) return null

  try {
    const res = await fetch(KUGOU_PUBLIC_SONGINFO_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'IPhone-8990-searchSong',
        'UNI-UserAgent': 'iOS11.4-Phone8990-1009-0-WiFi'
      },
      body: new URLSearchParams({
        cmd: 'playInfo',
        hash: normalizedHash,
        from: 'mkugou'
      })
    })

    if (!res.ok) return null

    const json = await res.json()
    return extractKugouPublicCover(json, size)
  } catch (error) {
    return null
  }
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
