import config from '../config.js'
import { buildKugouUpstreamAuthCookie } from './kugou-upstream-auth.js'
import { buildKugouUpstreamRuntimeHeaders, getKugouPoolRuntime } from './kugou-upstream-runtime.js'

const DFID_TTL_MS = 1000 * 60 * 60 * 6

const cachedDfids = new Map()

const getBaseUrl = () => String(config.meting.kugou.upstream.url || '').trim().replace(/\/+$/, '')

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

const stripEnvelope = (text) => {
  const raw = normalizeText(text)
  if (!raw) return ''

  const startTag = '<!--KG_TAG_RES_START-->'
  const endTag = '<!--KG_TAG_RES_END-->'
  const start = raw.indexOf(startTag)
  const end = raw.lastIndexOf(endTag)

  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start + startTag.length, end).trim()
  }

  return raw
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

const requestUpstream = async (path, { query = {}, cookie = '', headers: extraHeaders = {} } = {}) => {
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
  Object.assign(headers, extraHeaders || {})

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(config.meting.kugou.upstream.timeoutMs)
    })

    if (!response.ok) return null

    const text = stripEnvelope(await response.text())
    if (!text) return null
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

const buildAuthCookie = ({ cookie = '', dfid = '' } = {}) => {
  return buildKugouUpstreamAuthCookie({ cookie, dfid })
}

const ensureUpstreamDfid = async (pool, cookie = '') => {
  const runtime = await getKugouPoolRuntime(pool, { cookie })
  const cacheKey = `${runtime.pool}:${runtime.platform}:${runtime.guid}`
  const now = Date.now()
  const cached = cachedDfids.get(cacheKey)
  if (cached?.dfid && now - cached.at < DFID_TTL_MS) {
    return cached.dfid
  }

  const headers = await buildKugouUpstreamRuntimeHeaders(pool, { cookie })
  const response = await requestUpstream('/register/dev', { headers })
  const dfid = normalizeText(response?.data?.dfid)
  if (!dfid) return ''

  cachedDfids.set(cacheKey, { dfid, at: now })
  return dfid
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
    headers: await buildKugouUpstreamRuntimeHeaders(pool, { cookie })
  })

  return response?.data?.[0] || null
}

const getPrivilegeItem = async (hash, cookie, pool) => {
  const response = await requestUpstream('/privilege/lite', {
    query: { hash },
    cookie: buildAuthCookie({ cookie }),
    headers: await buildKugouUpstreamRuntimeHeaders(pool, { cookie })
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
    headers: await buildKugouUpstreamRuntimeHeaders(pool, { cookie })
  })

  const url = Array.isArray(response?.url)
    ? response.url[0]
    : normalizeText(response?.url)
  const backupUrl = Array.isArray(response?.backupUrl)
    ? response.backupUrl[0]
    : normalizeText(response?.backupUrl)
  const resolved = normalizeUrl(url || backupUrl, 0)

  return resolved ? { url: resolved } : null
}

const getUpstreamLyric = async ({ id }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const search = await requestUpstream('/search/lyric', {
    query: { hash }
  })
  const candidate = search?.candidates?.[0]
  if (!candidate?.id || !candidate?.accesskey) return null

  const response = await requestUpstream('/lyric', {
    query: {
      id: candidate.id,
      accesskey: candidate.accesskey,
      fmt: 'lrc',
      decode: 'true'
    }
  })

  const lyric = normalizeText(response?.decodeContent)
  return lyric ? { lyric, tlyric: '' } : null
}

const getUpstreamPlaylist = async ({ id, pool }) => {
  const normalizedId = normalizeText(id)
  if (!normalizedId) return null

  const detail = await requestUpstream('/playlist/detail', {
    query: { ids: normalizedId },
    headers: await buildKugouUpstreamRuntimeHeaders(pool)
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
      headers: await buildKugouUpstreamRuntimeHeaders(pool)
    })
    const chunk = Array.isArray(response?.data?.songs) ? response.data.songs : []
    if (chunk.length === 0) break

    songs.push(...chunk)

    if (chunk.length < pageSize || (total > 0 && songs.length >= total)) {
      break
    }
  }

  return songs
    .map(mapSongFromPlaylist)
    .filter(Boolean)
}

export const hasKugouUpstream = () => Boolean(getBaseUrl())

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
  if (!hasKugouUpstream()) return null

  if (type === 'song') return getUpstreamSong({ id, cookie, pool })
  if (type === 'playlist') return getUpstreamPlaylist({ id, pool })
  if (type === 'lrc') return getUpstreamLyric({ id })
  if (type === 'url') return getUpstreamUrl({ id, cookie, pool })
  if (type === 'pic') return getUpstreamPic({ id, cookie, pool })
  return null
}
