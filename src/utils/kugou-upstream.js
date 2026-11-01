import { logger } from '../middleware/logger.js'
import { buildKugouUpstreamAuthCookie } from './kugou-upstream-auth.js'
import { getKugouPoolUpstreamUrl, hasKugouPoolUpstream } from './kugou-upstream-runtime.js'
import { requestKugouUpstream } from './kugou-upstream-client.js'
import { parseKugouCookie } from './kugou-songinfo.js'

const DFID_TTL_MS = 1000 * 60 * 60 * 6

const cachedDfids = new Map()
const pendingDfids = new Map()
const UPSTREAM_TYPES = new Set(['song', 'playlist', 'lrc', 'url', 'pic'])

const getBaseUrl = (pool = 'premium') => String(getKugouPoolUpstreamUrl(pool) || '').trim().replace(/\/+$/, '')

const normalizeText = (value) => String(value || '').trim()

const normalizeUrl = (value, size = 400) => {
  let out = normalizeText(value)
  if (!out) return ''
  out = out.replace('{size}', String(size))
  if (out.startsWith('http://')) {
    out = `https://${out.slice('http://'.length)}`
  }
  return out
}

const buildCompositeId = (hash, albumAudioId = '') => {
  const normalizedHash = extractKugouHashFromResourceId(hash)
  const normalizedAlbumAudioId = normalizeText(albumAudioId)
  return normalizedAlbumAudioId ? `${normalizedHash}|${normalizedAlbumAudioId}` : normalizedHash
}

const splitName = (name, author = '') => {
  const rawName = normalizeText(name)
  const rawAuthor = normalizeText(author)
  if (!rawName) return ''
  if (rawAuthor && rawName.startsWith(`${rawAuthor} - `)) {
    return rawName.slice(rawAuthor.length + 3).trim()
  }

  const parts = rawName.split(' - ')
  if (parts.length > 1) {
    return parts.slice(1).join(' - ').trim()
  }

  return rawName
}

const pickAuthor = (names = [], fallback = '') => {
  const author = names
    .map(item => normalizeText(item))
    .filter(Boolean)
    .join(' / ')

  return author || normalizeText(fallback) || '未知歌手'
}

const requestUpstream = async (path, options = {}) => {
  try {
    const response = await requestKugouUpstream(path, options)
    if (!response) return null
    if (!response.ok) {
      logger.warn({ path, pool: options.pool, status: response.status }, 'Kugou upstream HTTP error')
      return null
    }
    return response.body
  } catch (error) {
    logger.warn({ path, pool: options.pool, code: error.code, status: error.status }, 'Kugou upstream request failed')
    return null
  }
}

const buildAuthCookie = ({ cookie = '', dfid = '' } = {}) => {
  return buildKugouUpstreamAuthCookie({ cookie, dfid })
}

const ensureUpstreamDfid = async (pool, cookie = '') => {
  const parsed = parseKugouCookie(cookie)
  const existingDfid = normalizeText(parsed.dfid || parsed.kg_dfid)
  if (existingDfid) return existingDfid

  const baseUrl = getBaseUrl(pool)
  const cacheKey = `${pool}:${baseUrl}`
  const now = Date.now()
  const cached = cachedDfids.get(cacheKey)
  if (cached?.dfid && now - cached.at < DFID_TTL_MS) {
    return cached.dfid
  }

  if (pendingDfids.has(cacheKey)) return pendingDfids.get(cacheKey)
  const pending = (async () => {
    const response = await requestUpstream('/register/dev', { pool })
    const dfid = normalizeText(response?.data?.dfid)
    if (dfid) cachedDfids.set(cacheKey, { dfid, at: Date.now() })
    return dfid
  })()
  pendingDfids.set(cacheKey, pending)
  try {
    return await pending
  } finally {
    pendingDfids.delete(cacheKey)
  }
}

const mapSongFromPrivilege = (item, meta = null) => {
  const hash = extractKugouHashFromResourceId(item?.hash)
  if (!hash) return null

  const albumAudioId = normalizeText(item?.album_audio_id || meta?.base?.album_audio_id)
  const authorNames = Array.isArray(meta?.authors)
    ? meta.authors.map(entry => entry?.base?.author_name)
    : []
  const author = pickAuthor(authorNames, item?.singername || meta?.base?.author_name)
  const title = normalizeText(meta?.base?.songname) || splitName(item?.name, item?.singername) || normalizeText(item?.name) || hash

  return {
    hash,
    title,
    author,
    url_id: buildCompositeId(hash, albumAudioId),
    pic_id: hash,
    lyric_id: hash
  }
}

const mapSongFromPlaylist = (item) => {
  const hash = extractKugouHashFromResourceId(item?.hash)
  if (!hash) return null

  const authorNames = Array.isArray(item?.singerinfo)
    ? item.singerinfo.map(entry => entry?.name)
    : []
  const author = pickAuthor(authorNames, item?.remark)
  const title = splitName(item?.name, authorNames[0] || item?.remark) || normalizeText(item?.name) || hash
  const albumAudioId = normalizeText(item?.mixsongid || item?.add_mixsongid || item?.album_audio_id)

  return {
    hash,
    title,
    author,
    url_id: buildCompositeId(hash, albumAudioId),
    pic_id: hash,
    lyric_id: hash
  }
}

const getSongMeta = async (albumAudioId, cookie, pool) => {
  const normalizedAlbumAudioId = normalizeText(albumAudioId)
  if (!normalizedAlbumAudioId) return null

  const response = await requestUpstream('/krm/audio', {
    query: {
      album_audio_id: normalizedAlbumAudioId,
      fields: 'album_info,base,authors.base'
    },
    cookie: buildAuthCookie({ cookie }),
    pool
  })

  return response?.data?.[0] || null
}

const getPrivilegeItem = async (hash, cookie, pool) => {
  const response = await requestUpstream('/privilege/lite', {
    query: { hash },
    cookie: buildAuthCookie({ cookie }),
    pool
  })

  return response?.data?.[0] || null
}

const getUpstreamSong = async ({ id, cookie, pool }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const privilegeItem = await getPrivilegeItem(hash, cookie, pool)
  if (!privilegeItem) return null

  const meta = await getSongMeta(privilegeItem.album_audio_id, cookie, pool)
  return mapSongFromPrivilege(privilegeItem, meta)
}

const getUpstreamPic = async ({ id, cookie, pool }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const privilegeItem = await getPrivilegeItem(hash, cookie, pool)
  if (!privilegeItem) return null

  const cover = normalizeUrl(privilegeItem.info?.image || privilegeItem.trans_param?.union_cover)
  return cover ? { url: cover } : null
}

const getUpstreamUrl = async ({ id, cookie, pool }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const dfid = await ensureUpstreamDfid(pool, cookie)
  const response = await requestUpstream('/song/url', {
    query: {
      hash,
      album_audio_id: extractKugouAlbumAudioIdFromResourceId(id)
    },
    cookie: buildAuthCookie({ cookie, dfid }),
    pool
  })

  const url = Array.isArray(response?.url)
    ? response.url[0]
    : normalizeText(response?.url)
  const backupUrl = Array.isArray(response?.backupUrl)
    ? response.backupUrl[0]
    : normalizeText(response?.backupUrl)
  // Playback URLs are signed upstream resources. Preserve their scheme: some
  // lite CDNs only serve a valid response over HTTP.
  const resolved = normalizeText(url || backupUrl)

  return /^https?:\/\//i.test(resolved) ? { url: resolved } : null
}

const getUpstreamLyric = async ({ id, pool }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const search = await requestUpstream('/search/lyric', {
    query: { hash },
    pool
  })
  const candidate = search?.candidates?.[0]
  if (!candidate?.id || !candidate?.accesskey) return null

  const response = await requestUpstream('/lyric', {
    query: {
      id: candidate.id,
      accesskey: candidate.accesskey,
      fmt: 'lrc',
      decode: 'true'
    },
    pool
  })

  const lyric = normalizeText(response?.decodeContent)
  return lyric ? { lyric, tlyric: '' } : null
}

const getUpstreamPlaylist = async ({ id, pool }) => {
  const normalizedId = normalizeText(id)
  if (!normalizedId) return null

  const detail = await requestUpstream('/playlist/detail', {
    query: { ids: normalizedId },
    pool
  })
  const detailItem = detail?.data?.[0]
  if (!detailItem?.global_collection_id) return null

  const songs = []
  const pageSize = 300
  const total = Number(detailItem.count || 0)

  for (let page = 1; page <= 20; page++) {
    const response = await requestUpstream('/playlist/track/all', {
      query: {
        id: normalizedId,
        page,
        pagesize: pageSize
      },
      pool
    })
    const chunk = response?.data?.songs
    // A failed page must not become a successful, truncated playlist.
    if (!Array.isArray(chunk)) return null
    if (chunk.length === 0) {
      if (total > songs.length) return null
      break
    }

    songs.push(...chunk)

    if (total > 0 && songs.length >= total) {
      break
    }
    if (chunk.length < pageSize) {
      if (total > songs.length) return null
      break
    }
    if (page === 20) return null
  }

  return songs
    .map(mapSongFromPlaylist)
    .filter(Boolean)
}

export const hasKugouUpstream = (pool = 'premium') => hasKugouPoolUpstream(pool)
export const canUseKugouUpstream = (type, pool = 'premium') => UPSTREAM_TYPES.has(type) && hasKugouUpstream(pool)

export const extractKugouHashFromResourceId = (value) => {
  const raw = normalizeText(value)
  if (!raw) return ''
  return raw.split('|')[0].trim().toUpperCase()
}

export const extractKugouAlbumAudioIdFromResourceId = (value) => {
  const raw = normalizeText(value)
  if (!raw.includes('|')) return ''
  return raw.split('|').slice(1).join('|').trim()
}

export const buildKugouCompositeId = (hash, albumAudioId = '') => {
  return buildCompositeId(hash, albumAudioId)
}

export const getKugouUpstreamData = async ({ type, id, cookie = '', pool = 'premium' }) => {
  if (!canUseKugouUpstream(type, pool)) return null

  if (type === 'song') return getUpstreamSong({ id, cookie, pool })
  if (type === 'playlist') return getUpstreamPlaylist({ id, pool })
  if (type === 'lrc') return getUpstreamLyric({ id, pool })
  if (type === 'url') return getUpstreamUrl({ id, cookie, pool })
  if (type === 'pic') return getUpstreamPic({ id, cookie, pool })
  return null
}
