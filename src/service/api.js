import Meting from '@meting/core'
import { timingSafeEqual } from 'node:crypto'
import hashjs from 'hash.js'
import { HTTPException } from 'hono/http-exception'
import config from '../config.js'
import { format as lyricFormat } from '../utils/lyric.js'
import { readCookieFile, isAllowedHost } from '../utils/cookie.js'
import {
  getKugouCoverFromPublicSong,
  getKugouCoverFromSonginfo,
  getKugouPublicSong
} from '../utils/kugou-songinfo.js'
import {
  extractKugouHashFromResourceId,
  getKugouUpstreamData
} from '../utils/kugou-upstream.js'
import { recordKugouUpstreamTrace } from '../utils/kugou-upstream-status.js'
import { recordRequestSummary } from '../utils/request-summary-log.js'
import {
  canUseKugouSharePlaylist,
  getKugouPlaylistFromShare,
  normalizeKugouSharePlaylistInput
} from '../utils/kugou-share-playlist.js'
import {
  peekKugouQuota,
  recordKugouBlocked,
  recordKugouRequest
} from '../utils/kugou-runtime.js'
import { isHashInBlogPlaylist } from '../utils/blog-playlist-whitelist.js'
import { LRUCache } from 'lru-cache'

const cache = new LRUCache({
  max: 1000,
  ttl: 1000 * 30
})
const METING_METHODS = {
  search: 'search',
  song: 'song',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  songlist: 'playlist',
  lrc: 'lyric',
  url: 'url',
  pic: 'pic'
}
const BLOG_PLAYLIST_SOURCE = 'blog-playlist'

const summarizeAuthors = (item) => {
  if (typeof item?.author === 'string' && item.author) return item.author
  if (Array.isArray(item?.artist)) return item.artist.join(' / ')
  if (Array.isArray(item?.authors)) {
    return item.authors
      .map(author => author?.author_name || author?.name || '')
      .filter(Boolean)
      .join(' / ')
  }
  if (typeof item?.singerName === 'string' && item.singerName) return item.singerName
  return ''
}

const summarizeTitle = (item) => {
  return item?.title || item?.name || item?.songName || item?.song_name || item?.hash || ''
}

const summarizeItems = (data, limit = 3) => {
  const list = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : [])
  return list
    .map(item => {
      const title = summarizeTitle(item)
      const author = summarizeAuthors(item)
      return author && title ? `${author} - ${title}` : (title || author)
    })
    .filter(Boolean)
    .slice(0, limit)
}

const recordApiSummary = ({ c, server, type, id, pool, cacheHit, upstreamStatus, data }) => {
  const referer = c.req.header('referer') || ''
  const items = summarizeItems(data)
  if (!items.length) {
    if (type === 'url') items.push(`url:${id}`)
    else if (type === 'pic') items.push(`pic:${id}`)
    else if (type === 'lrc') items.push(`lrc:${id}`)
  }

  recordRequestSummary({
    at: new Date().toISOString(),
    path: c.req.path,
    server,
    type,
    id,
    requestId: c.get('requestId') || '',
    pool: server === 'kugou' ? pool : '',
    cache: cacheHit ? 'hit' : 'miss',
    upstream: server === 'kugou' ? upstreamStatus : '',
    referer,
    items
  }).catch(() => {})
}

export default async (c) => {
  c.header('access-control-expose-headers', 'x-cache, x-kugou-route, x-kugou-notice, x-kugou-upstream')

  const query = c.req.query()
  const server = query.server || 'netease'
  const rawType = query.type || 'search'
  const type = rawType === 'songlist' ? 'playlist' : rawType
  let id = query.id || 'hello'
  const token = query.token || query.auth || 'token'
  const requestKey = query.key || ''
  const requestSource = query.source || ''
  const hasPremiumKey = server === 'kugou' && hasValidKugouPremiumKey(requestKey)

  if (server === 'kugou' && type === 'playlist') {
    id = normalizeKugouSharePlaylistInput(id) || id
  }

  const isKugouSharePlaylist = server === 'kugou' && type === 'playlist' && canUseKugouSharePlaylist(id)

  if (!['netease', 'tencent', 'kugou', 'baidu', 'kuwo'].includes(server)) {
    throw new HTTPException(400, { message: 'server 参数不合法' })
  }
  if (!['song', 'album', 'search', 'artist', 'playlist', 'songlist', 'lrc', 'url', 'pic'].includes(rawType)) {
    throw new HTTPException(400, { message: 'type 参数不合法' })
  }

  if (['lrc', 'url', 'pic'].includes(type)) {
    if (!hasPremiumKey && auth(server, type, id) !== token) {
      throw new HTTPException(401, { message: '鉴权失败,非法调用' })
    }
  }

  const referrer = c.req.header('referer')
  const allowCookie = isAllowedHost(referrer)
  const kugouHashId = server === 'kugou'
    ? extractKugouHashFromResourceId(id)
    : id
  const kugouRoute = resolveKugouPool({
    server,
    referrer,
    allowCookie,
    requestKey,
    type,
    hash: kugouHashId
  })
  const kugouPool = kugouRoute.pool
  let effectiveKugouPool = kugouPool
  let fallbackNotice = ''
  const buildCacheKey = (pool) => {
    const cacheMode = getCacheMode({ server, allowCookie, kugouPool: pool })
    return `${server}/${type}/${id}/${cacheMode}`
  }

  let cacheKey = buildCacheKey(effectiveKugouPool)
  let cacheEntry = cache.get(cacheKey)
  let data = cacheEntry?.__metingCache ? cacheEntry.payload : cacheEntry
  let cacheHit = cacheEntry !== undefined
  let upstreamStatus = cacheEntry?.__metingCache ? (cacheEntry.upstreamStatus || 'miss') : 'miss'
  let upstreamAttempted = false

  if (server === 'kugou') {
    const quotaExempt = shouldExemptKugouQuota({
      server,
      kugouPool,
      reason: kugouRoute.reason,
      requestSource
    })
    if (effectiveKugouPool === 'premium' || effectiveKugouPool === 'general') {
      if (cacheHit) {
        recordKugouRequest({
          pool: effectiveKugouPool,
          reason: kugouRoute.reason,
          cacheHit: true,
          countTowardQuota: false,
          exemptTag: ''
        })
      } else if (quotaExempt) {
        recordKugouRequest({
          pool: effectiveKugouPool,
          reason: kugouRoute.reason,
          cacheHit: false,
          countTowardQuota: false,
          exemptTag: requestSource
        })
      } else {
        const quotaState = peekKugouQuota(effectiveKugouPool)

        if (!quotaState.allowed) {
          recordKugouBlocked({
            pool: effectiveKugouPool,
            reason: kugouRoute.reason
          })

          if (effectiveKugouPool === 'general') {
            effectiveKugouPool = 'internal'
            fallbackNotice = '普通线路繁忙，已切换至游客线路，VIP 歌曲可能仅支持试听'
            c.header('x-kugou-route', 'internal-fallback')
            c.header('x-kugou-notice', encodeURIComponent(fallbackNotice))
            cacheKey = buildCacheKey(effectiveKugouPool)
            cacheEntry = cache.get(cacheKey)
            data = cacheEntry?.__metingCache ? cacheEntry.payload : cacheEntry
            cacheHit = cacheEntry !== undefined
            upstreamStatus = cacheEntry?.__metingCache ? (cacheEntry.upstreamStatus || 'miss') : 'miss'
          } else {
            c.header('x-cache', 'miss')
            throw new HTTPException(429, {
              message: `${mapKugouPoolName(effectiveKugouPool)} 池本分钟额度已用尽，请等待下一分钟刷新`
            })
          }
        } else {
          recordKugouRequest({
            pool: effectiveKugouPool,
            reason: kugouRoute.reason,
            cacheHit: false,
            countTowardQuota: true,
            exemptTag: ''
          })
        }
      }
    }
  }

  if (data === undefined) {
    c.header('x-cache', 'miss')
    const meting = new Meting(server)
    meting.format(true)

    const cookiePool = getCookiePool({ server, allowCookie, kugouPool: effectiveKugouPool })
    const cookie = cookiePool
      ? await readCookieFile(server, cookiePool)
      : ''
    if (cookie) meting.cookie(cookie)

    if (server === 'kugou' && effectiveKugouPool !== 'internal' && !isKugouSharePlaylist) {
      upstreamAttempted = true
      const upstreamData = await getKugouUpstreamData({
        type,
        id,
        cookie,
        pool: effectiveKugouPool
      })
      if (upstreamData != null) {
        data = upstreamData
        upstreamStatus = 'hit'
      } else {
        upstreamStatus = 'fallback-meting'
      }
    }

    if (server === 'kugou' && type === 'pic' && data === undefined && cookie) {
      const cover = await getKugouCoverFromSonginfo({ hash: kugouHashId, cookie, size: 400 })
      if (cover) {
        data = cover
      }
    }

    if (server === 'kugou' && type === 'pic' && data === undefined) {
      const publicCover = await getKugouCoverFromPublicSong({ hash: kugouHashId, size: 400 })
      if (publicCover) {
        data = publicCover
      }
    }

    if (server === 'kugou' && type === 'song' && data === undefined) {
      const publicSong = await getKugouPublicSong(kugouHashId)
      if (publicSong) {
        data = publicSong
      }
    }

    if (data === undefined) {
      if (isKugouSharePlaylist) {
        data = await getKugouPlaylistFromShare(id)
      }

      if (data == null) {
        const method = METING_METHODS[type]
        const metingId = server === 'kugou' && ['song', 'lrc', 'url', 'pic'].includes(type)
          ? kugouHashId
          : id
        let response
        try {
          response = await meting[method](metingId)
        } catch (error) {
          throw new HTTPException(500, { message: '上游 API 调用失败' })
        }

        try {
          data = JSON.parse(response)
        } catch (error) {
          throw new HTTPException(500, { message: '上游 API 返回格式异常' })
        }
      }
    }
    cache.set(cacheKey, {
      __metingCache: true,
      payload: data,
      upstreamStatus
    }, {
      ttl: isKugouSharePlaylist
        ? 1000 * 60 * 30
        : (type === 'url' ? 1000 * 60 * 10 : 1000 * 60 * 60)
    })
  }

  if (fallbackNotice) {
    c.header('x-kugou-route', 'internal-fallback')
    c.header('x-kugou-notice', encodeURIComponent(fallbackNotice))
  }

  if (server === 'kugou') {
    c.header('x-kugou-upstream', upstreamStatus)
    recordKugouUpstreamTrace({
      status: upstreamStatus,
      type,
      pool: effectiveKugouPool,
      configured: Boolean(config.meting.kugou.upstream.url),
      attempted: upstreamAttempted,
      cacheHit,
      reason: upstreamAttempted
        ? (upstreamStatus === 'hit' ? 'upstream-hit' : 'fallback-after-upstream')
        : 'not-attempted'
    })
  }

  if (type === 'url') {
    recordApiSummary({
      c,
      server,
      type,
      id,
      pool: effectiveKugouPool,
      cacheHit,
      upstreamStatus,
      data
    })
    let url = data.url
    if (!url) {
      return c.body(null, 404)
    }
    if (server === 'netease') {
      url = url
        .replace('://m7c.', '://m7.')
        .replace('://m8c.', '://m8.')
        .replace('http://', 'https://')
      if (url.includes('vuutv=')) {
        const tempUrl = new URL(url)
        tempUrl.search = ''
        url = tempUrl.toString()
      }
    }
    if (server === 'tencent') {
      url = url
        .replace('http://', 'https://')
        .replace('://ws.stream.qqmusic.qq.com', '://dl.stream.qqmusic.qq.com')
    }
    if (server === 'baidu') {
      url = url
        .replace('http://zhangmenshiting.qianqian.com', 'https://gss3.baidu.com/y0s1hSulBw92lNKgpU_Z2jR7b2w6buu')
    }
    return c.redirect(url)
  }

  if (type === 'pic') {
    recordApiSummary({
      c,
      server,
      type,
      id,
      pool: effectiveKugouPool,
      cacheHit,
      upstreamStatus,
      data
    })
    const url = data.url
    if (!url) {
      return c.body(null, 404)
    }
    return c.redirect(url)
  }

  if (type === 'lrc') {
    recordApiSummary({
      c,
      server,
      type,
      id,
      pool: effectiveKugouPool,
      cacheHit,
      upstreamStatus,
      data
    })
    return c.text(lyricFormat(data.lyric, data.tlyric || ''))
  }

  const debug = ['1', 'true', 'yes', 'on'].includes(String(process.env.METING_DEBUG || '').toLowerCase())
  if (debug && server === 'kugou') {
    console.log('================ 酷狗原始返回数据 ================')
    console.log(JSON.stringify(data, null, 2))
    console.log('================================================')
  }

  // 🛡️ 智能兼容防弹装甲 🛡️
  const safeData = Array.isArray(data) ? data : (data.error ? [] : [data])
  recordApiSummary({
    c,
    server,
    type,
    id,
    pool: effectiveKugouPool,
    cacheHit,
    upstreamStatus,
    data: safeData
  })
  return c.json(safeData.map(x => {
    // 兼容标准格式(name)与酷狗原始格式(songName)
    const title = x.title || x.name || x.songName || '未知歌曲'

    // 兼容歌手格式
    let author = '未知歌手'
    if (typeof x.author === 'string' && x.author) {
      author = x.author
    } else if (Array.isArray(x.artist)) {
      author = x.artist.join(' / ')
    } else if (Array.isArray(x.authors)) {
      author = x.authors.map(a => a.author_name).join(' / ') // 提取酷狗的歌手名
    } else if (typeof x.singerName === 'string') {
      author = x.singerName
    }

    // 兼容 ID 格式：标准用 url_id，酷狗原始用 hash
    const urlId = server === 'kugou'
      ? (x.url_id || x.hash || id)
      : (x.url_id || x.hash || id)
    const picId = server === 'kugou'
      ? (x.pic_id || x.hash || x.url_id || id)
      : (x.pic_id || x.album_audio_id || x.albumid || x.hash || id)
    const lrcId = server === 'kugou'
      ? (x.lyric_id || x.hash || id)
      : (x.lyric_id || x.hash || id)

    return {
      title,
      author,
      url: buildResourceUrl({
        server,
        type: 'url',
        id: urlId,
        requestKey,
        requestSource,
        kugouPool: effectiveKugouPool
      }),
      pic: buildResourceUrl({
        server,
        type: 'pic',
        id: picId,
        requestKey,
        requestSource,
        kugouPool: effectiveKugouPool
      }),
      lrc: buildResourceUrl({
        server,
        type: 'lrc',
        id: lrcId,
        requestKey,
        requestSource,
        kugouPool: effectiveKugouPool
      })
    }
  }))
}

const hasValidKugouPremiumKey = (requestKey) => {
  const expectedKey = config.meting.kugou.premiumKey
  if (!expectedKey || !requestKey) return false

  const left = Buffer.from(requestKey)
  const right = Buffer.from(expectedKey)
  if (left.length !== right.length) return false

  return timingSafeEqual(left, right)
}

const resolveKugouPool = ({ server, referrer, allowCookie, requestKey, type, hash }) => {
  if (server !== 'kugou') return { pool: 'default', reason: 'default' }
  if (hasValidKugouPremiumKey(requestKey)) return { pool: 'premium', reason: 'key' }
  if (referrer && config.meting.cookie.allowHosts.length > 0 && allowCookie) {
    if (type !== 'playlist' && isHashInBlogPlaylist(hash)) {
      return { pool: 'premium', reason: 'referrer' }
    }
    return { pool: 'general', reason: 'referrer-non-whitelist' }
  }
  return { pool: 'general', reason: 'fallback' }
}

const shouldExemptKugouQuota = ({ server, kugouPool, reason, requestSource }) => {
  if (server !== 'kugou') return false
  if (requestSource !== BLOG_PLAYLIST_SOURCE) return false
  return kugouPool === 'premium' && reason === 'referrer'
}

const mapKugouPoolName = (pool) => {
  if (pool === 'premium') return 'Pro'
  if (pool === 'internal') return 'Guest'
  return 'Normal (CK)'
}

const getCacheMode = ({ server, allowCookie, kugouPool }) => {
  if (server === 'kugou') {
    return (kugouPool === 'premium' || kugouPool === 'general') ? kugouPool : 'internal'
  }
  return allowCookie ? 'cookie' : 'anon'
}

const getCookiePool = ({ server, allowCookie, kugouPool }) => {
  if (server === 'kugou') {
    return (kugouPool === 'premium' || kugouPool === 'general') ? kugouPool : ''
  }
  return allowCookie ? 'default' : ''
}

const buildResourceUrl = ({ server, type, id, requestKey, requestSource, kugouPool }) => {
  const url = new URL(`${config.meting.url}/music`)
  url.searchParams.set('server', server)
  url.searchParams.set('type', type)
  url.searchParams.set('id', id)
  url.searchParams.set('auth', auth(server, type, id))
  if (server === 'kugou' && kugouPool === 'premium' && requestSource === BLOG_PLAYLIST_SOURCE) {
    url.searchParams.set('source', requestSource)
  }
  if (server === 'kugou' && kugouPool === 'premium' && hasValidKugouPremiumKey(requestKey)) {
    url.searchParams.set('key', requestKey)
  }
  return url.toString()
}

const auth = (server, type, id) => {
  return hashjs.hmac(hashjs.sha1, config.meting.token).update(`${server}${type}${id}`).digest('hex')
}
