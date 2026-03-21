const KUGOU_SHARE_HTML_PATTERNS = [
  /var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*,\s*\/\//,
  /var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*;/
]

const KUGOU_SHARE_HOSTS = new Set([
  't1.kugou.com',
  'wwwapi.kugou.com',
  'm.kugou.com'
])
const KUGOU_SHARE_CODE_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{8,}$/

const FETCH_TIMEOUT_MS = 15000
const ZLIST_API_HOST = 'https://m3ws.kugou.com'
const ZLIST_PAGE_SIZE = 200
const ZLIST_MAX_PAGES = 20

// Smart cache: avoid full re-fetch every time
// Page 1 = newest songs → refresh frequently
// Pages 2+ = older songs → rarely change
const INCR_CHECK_MS = 2 * 60 * 60 * 1000   // 2 hours: only refresh page 1
const FULL_REFRESH_MS = 3 * 24 * 60 * 60 * 1000 // 3 days: full re-fetch
const smartCache = new Map()

const normalizeHash = (value) => String(value || '').trim().toUpperCase()

const extractShareCode = (normalizedUrl) => {
  try {
    const url = new URL(normalizedUrl)
    if (url.hostname === 't1.kugou.com') {
      return url.pathname.replace(/^\//, '')
    }
    return url.searchParams.get('chain') || null
  } catch {
    return null
  }
}

const normalizeShareInput = (value) => {
  if (!value || typeof value !== 'string') return null

  const input = value.trim()
  if (KUGOU_SHARE_CODE_PATTERN.test(input)) {
    return `https://t1.kugou.com/${input}`
  }

  try {
    const url = new URL(input)
    const hostname = url.hostname.toLowerCase()
    if (!KUGOU_SHARE_HOSTS.has(hostname)) return null

    if (hostname === 't1.kugou.com') {
      const code = url.pathname.replace(/^\//, '')
      if (!KUGOU_SHARE_CODE_PATTERN.test(code)) return null
      return `https://t1.kugou.com/${code}`
    }

    if (url.pathname !== '/share/zlist.html') return null

    const chain = url.searchParams.get('chain') || ''
    if (KUGOU_SHARE_CODE_PATTERN.test(chain)) {
      return `https://t1.kugou.com/${chain}`
    }

    return url.toString()
  } catch {
    return null
  }
}

const parseSharePlaylistData = (html) => {
  if (!html) return []

  for (const pattern of KUGOU_SHARE_HTML_PATTERNS) {
    const match = html.match(pattern)
    if (!match) continue

    try {
      const parsed = JSON.parse(match[1])
      if (Array.isArray(parsed)) return parsed
    } catch {}
  }

  return []
}

const normalizeShareSongs = (items) => {
  const songs = []
  const seen = new Set()

  for (const item of items) {
    const hash = normalizeHash(item?.hash)
    if (!hash || seen.has(hash)) continue
    seen.add(hash)

    const artist = String(item?.author_name || '').trim()
    songs.push({
      name: String(item?.song_name || '').trim(),
      artist: artist ? [artist] : [],
      album: '',
      album_id: String(item?.album_id || '').trim(),
      hash,
      source: 'kugou-share'
    })
  }

  return songs
}

const normalizeZlistSongs = (items) => {
  const songs = []
  const seen = new Set()

  for (const item of items) {
    const hash = normalizeHash(item?.hash)
    if (!hash || seen.has(hash)) continue
    seen.add(hash)

    // zlist API uses "name" field with "artist - title" format
    const rawName = String(item?.name || item?.filename || item?.fileName || '').trim()
    let songName = String(item?.songname || item?.song_name || '').trim()
    let artistName = String(item?.singername || item?.author_name || '').trim()

    if (!songName && rawName) {
      const parts = rawName.split(' - ')
      if (parts.length >= 2) {
        artistName = artistName || parts[0].trim()
        songName = parts.slice(1).join(' - ').trim()
      } else {
        songName = rawName
      }
    }

    songs.push({
      name: songName,
      artist: artistName ? [artistName] : [],
      album: String(item?.album_name || '').trim(),
      album_id: String(item?.album_id || '').trim(),
      hash,
      source: 'kugou-share'
    })
  }

  return songs
}

const fetchJson = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    })

    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const fetchRedirectUrl = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    })

    return {
      url: response.url,
      ok: response.ok,
      text: response.ok ? await response.text() : ''
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const extractZlistParams = (redirectUrl) => {
  try {
    const url = new URL(redirectUrl)
    const params = {}

    for (const key of ['type', 'listid', 'uid', 'share_type', 'global_collection_id', 'sign', 'chain']) {
      const value = url.searchParams.get(key)
      if (value) params[key] = value
    }

    if (!params.global_collection_id || !params.sign) return null
    return params
  } catch {
    return null
  }
}

const buildZlistPageUrl = (params, page) => {
  const apiUrl = new URL(`${ZLIST_API_HOST}/zlist/list`)
  apiUrl.searchParams.set('appid', '1058')
  apiUrl.searchParams.set('clientver', '1014')
  apiUrl.searchParams.set('pagesize', String(ZLIST_PAGE_SIZE))
  apiUrl.searchParams.set('page', String(page))

  for (const [key, value] of Object.entries(params)) {
    apiUrl.searchParams.set(key, value)
  }

  return apiUrl.toString()
}

const fetchZlistPage = async (params, page) => {
  const data = await fetchJson(buildZlistPageUrl(params, page))
  if (!data || data.errcode || !data.status) return null

  const songs = data.list?.info || data.info || []
  const total = data.list?.total || data.total || 0
  return { songs: Array.isArray(songs) ? songs : [], total }
}

const fetchAllZlistPages = async (params) => {
  const allSongs = []

  for (let page = 1; page <= ZLIST_MAX_PAGES; page++) {
    const result = await fetchZlistPage(params, page)
    if (!result || result.songs.length === 0) break

    allSongs.push(...result.songs)
    if (allSongs.length >= result.total) break
  }

  return allSongs
}

const resolveZlistParams = async (normalizedInput) => {
  const response = await fetchRedirectUrl(normalizedInput)
  if (!response) return null

  const params = extractZlistParams(response.url || normalizedInput)
  const html = response.ok ? response.text : ''
  return { params, html }
}

export const canUseKugouSharePlaylist = (value) => {
  return Boolean(normalizeShareInput(value))
}

export const normalizeKugouSharePlaylistInput = (value) => {
  return normalizeShareInput(value)
}

export const getKugouPlaylistFromShare = async (value) => {
  const normalizedInput = normalizeShareInput(value)
  if (!normalizedInput) return null

  const cacheKey = extractShareCode(normalizedInput) || normalizedInput
  const cached = smartCache.get(cacheKey)
  const now = Date.now()

  // ── Case 1: Fresh cache — page 1 checked recently ──
  if (cached && cached.allSongs.length > 0 && (now - cached.lastIncrCheck) < INCR_CHECK_MS) {
    return cached.allSongs
  }

  // ── Resolve zlist API params (use cached params if available) ──
  let zlistParams = cached?.zlistParams
  let htmlFallback = ''

  if (!zlistParams) {
    const resolved = await resolveZlistParams(normalizedInput)
    if (resolved) {
      zlistParams = resolved.params
      htmlFallback = resolved.html
    }
  }

  if (!zlistParams) {
    // Can't use zlist API — try HTML scraping fallback
    if (htmlFallback) {
      const items = parseSharePlaylistData(htmlFallback)
      if (items.length > 0) return normalizeShareSongs(items)
    }
    return cached?.allSongs || null
  }

  // ── Case 2: Cache exists, not too old — incremental refresh (page 1 only) ──
  if (cached && cached.allSongs.length > 0 && (now - cached.lastFullFetch) < FULL_REFRESH_MS) {
    try {
      const page1 = await fetchZlistPage(zlistParams, 1)
      if (page1 && page1.songs.length > 0) {
        const newRawSongs = page1.songs.filter(s => {
          const hash = normalizeHash(s?.hash)
          return hash && !cached.hashSet.has(hash)
        })

        if (newRawSongs.length > 0) {
          const newNormalized = normalizeZlistSongs(newRawSongs)
          cached.allSongs = [...newNormalized, ...cached.allSongs]
          for (const s of newNormalized) {
            cached.hashSet.add(s.hash)
          }
        }

        cached.lastIncrCheck = now
        cached.zlistParams = zlistParams
        return cached.allSongs
      }
    } catch {}

    // Page 1 fetch failed — return stale cache
    cached.lastIncrCheck = now
    return cached.allSongs
  }

  // ── Case 3: No cache or expired — full fetch ──
  try {
    const allRaw = await fetchAllZlistPages(zlistParams)
    if (allRaw.length > 0) {
      const normalized = normalizeZlistSongs(allRaw)
      const hashSet = new Set(normalized.map(s => s.hash))

      smartCache.set(cacheKey, {
        allSongs: normalized,
        hashSet,
        zlistParams,
        lastFullFetch: now,
        lastIncrCheck: now
      })

      return normalized
    }
  } catch {}

  // Full fetch failed — try HTML scraping
  if (htmlFallback) {
    const items = parseSharePlaylistData(htmlFallback)
    if (items.length > 0) return normalizeShareSongs(items)
  }

  return cached?.allSongs || null
}
