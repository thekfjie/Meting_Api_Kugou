import config from '../config.js'
import { parseKugouCookie } from './kugou-songinfo.js'

const DFID_TTL_MS = 1000 * 60 * 60 * 6

let cachedDfid = ''
let cachedDfidAt = 0

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

const requestUpstream = async (path, { query = {}, cookie = '' } = {}) => {
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

const requestJson = async (url) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(config.meting.kugou.upstream.timeoutMs)
    })

    if (!response.ok) return null
    const text = normalizeText(await response.text())
    if (!text) return null
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

const buildAuthCookie = ({ cookie = '', dfid = '' } = {}) => {
  const parsed = parseKugouCookie(cookie)
  const parts = []

  const normalizedDfid = normalizeText(dfid)
  if (normalizedDfid) parts.push(`dfid=${normalizedDfid}`)

  const token = normalizeText(parsed.t)
  if (token) parts.push(`token=${token}`)

  const userId = normalizeText(parsed.KugooID)
  if (userId) parts.push(`userid=${userId}`)

  return parts.join('; ')
}

const ensureUpstreamDfid = async () => {
  const now = Date.now()
  if (cachedDfid && now - cachedDfidAt < DFID_TTL_MS) {
    return cachedDfid
  }

  const response = await requestUpstream('/register/dev')
  const dfid = normalizeText(response?.data?.dfid)
  if (!dfid) return ''

  cachedDfid = dfid
  cachedDfidAt = now
  return cachedDfid
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

const mapSongFromSearch = (item) => {
  const hash = extractKugouHashFromResourceId(item?.hash || item?.FileHash)
  if (!hash) return null

  const author = pickAuthor([], item?.singername || item?.SingerName)
  const title = splitName(item?.filename || item?.FileName, author) || normalizeText(item?.songname || item?.SongName) || hash
  const albumAudioId = normalizeText(item?.album_audio_id || item?.MixSongID)

  return {
    hash,
    title,
    author,
    url_id: buildCompositeId(hash, albumAudioId),
    pic_id: hash,
    lyric_id: hash
  }
}

const getSongMeta = async (albumAudioId, cookie) => {
  const normalizedAlbumAudioId = normalizeText(albumAudioId)
  if (!normalizedAlbumAudioId) return null

  const response = await requestUpstream('/krm/audio', {
    query: {
      album_audio_id: normalizedAlbumAudioId,
      fields: 'album_info,base,authors.base'
    },
    cookie: buildAuthCookie({ cookie })
  })

  return response?.data?.[0] || null
}

const getPrivilegeItem = async (hash, cookie) => {
  const response = await requestUpstream('/privilege/lite', {
    query: { hash },
    cookie: buildAuthCookie({ cookie })
  })

  return response?.data?.[0] || null
}

const getUpstreamSong = async ({ id, cookie }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const privilegeItem = await getPrivilegeItem(hash, cookie)
  if (!privilegeItem) return null

  const meta = await getSongMeta(privilegeItem.album_audio_id, cookie)
  return mapSongFromPrivilege(privilegeItem, meta)
}

const getUpstreamPic = async ({ id, cookie }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const privilegeItem = await getPrivilegeItem(hash, cookie)
  if (!privilegeItem) return null

  const cover = normalizeUrl(privilegeItem.info?.image || privilegeItem.trans_param?.union_cover)
  return cover ? { url: cover } : null
}

const getUpstreamUrl = async ({ id, cookie }) => {
  const hash = extractKugouHashFromResourceId(id)
  if (!hash) return null

  const dfid = await ensureUpstreamDfid()
  const response = await requestUpstream('/song/url', {
    query: {
      hash,
      album_audio_id: extractKugouAlbumAudioIdFromResourceId(id)
    },
    cookie: buildAuthCookie({ cookie, dfid })
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

const getUpstreamPlaylist = async ({ id }) => {
  const normalizedId = normalizeText(id)
  if (!normalizedId) return null

  const detail = await requestUpstream('/playlist/detail', {
    query: { ids: normalizedId }
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
      }
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

const getUpstreamSearch = async ({ id }) => {
  const keyword = normalizeText(id)
  if (!keyword) return null

  const url = new URL('https://mobiles.kugou.com/api/v3/search/song')
  url.searchParams.set('format', 'json')
  url.searchParams.set('keyword', keyword)
  url.searchParams.set('page', '1')
  url.searchParams.set('pagesize', '30')
  url.searchParams.set('showtype', '1')

  const response = await requestJson(url.toString())

  const items = Array.isArray(response?.data?.info)
    ? response.data.info
    : (Array.isArray(response?.data?.lists) ? response.data.lists : [])

  return items
    .map(mapSongFromSearch)
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

export const getKugouUpstreamData = async ({ type, id, cookie = '' }) => {
  if (!hasKugouUpstream()) return null

  if (type === 'search') return getUpstreamSearch({ id })
  if (type === 'song') return getUpstreamSong({ id, cookie })
  if (type === 'playlist') return getUpstreamPlaylist({ id })
  if (type === 'lrc') return getUpstreamLyric({ id })
  if (type === 'url') return getUpstreamUrl({ id, cookie })
  if (type === 'pic') return getUpstreamPic({ id, cookie })
  return null
}
