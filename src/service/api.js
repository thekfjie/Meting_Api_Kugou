import Meting from '@meting/core'
import { timingSafeEqual } from 'node:crypto'
import hashjs from 'hash.js'
import { HTTPException } from 'hono/http-exception'
import config from '../config.js'
import { format as lyricFormat } from '../utils/lyric.js'
import { readCookieFile, isAllowedHost } from '../utils/cookie.js'
import { getKugouCoverFromSonginfo } from '../utils/kugou-songinfo.js'
import { recordKugouRequest } from '../utils/kugou-runtime.js'
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
  lrc: 'lyric',
  url: 'url',
  pic: 'pic'
}

export default async (c) => {
  const query = c.req.query()
  const server = query.server || 'netease'
  const type = query.type || 'search'
  const id = query.id || 'hello'
  const token = query.token || query.auth || 'token'
  const requestKey = query.key || ''

  if (!['netease', 'tencent', 'kugou', 'baidu', 'kuwo'].includes(server)) {
    throw new HTTPException(400, { message: 'server 参数不合法' })
  }
  if (!['song', 'album', 'search', 'artist', 'playlist', 'lrc', 'url', 'pic'].includes(type)) {
    throw new HTTPException(400, { message: 'type 参数不合法' })
  }

  if (['lrc', 'url', 'pic'].includes(type)) {
    if (auth(server, type, id) !== token) {
      throw new HTTPException(401, { message: '鉴权失败,非法调用' })
    }
  }

  const referrer = c.req.header('referer')
  const allowCookie = isAllowedHost(referrer)
  const kugouRoute = resolveKugouPool({
    server,
    referrer,
    allowCookie,
    requestKey
  })
  const kugouPool = kugouRoute.pool
  const cacheMode = getCacheMode({ server, allowCookie, kugouPool })

  const cacheKey = `${server}/${type}/${id}/${cacheMode}`
  let data = cache.get(cacheKey)
  const cacheHit = data !== undefined
  if (server === 'kugou') {
    recordKugouRequest({
      pool: kugouPool,
      reason: kugouRoute.reason,
      cacheHit
    })
  }

  if (data === undefined) {
    c.header('x-cache', 'miss')
    const meting = new Meting(server)
    meting.format(true)

    const cookiePool = getCookiePool({ server, allowCookie, kugouPool })
    const cookie = cookiePool
      ? await readCookieFile(server, cookiePool)
      : ''
    if (cookie) meting.cookie(cookie)

    if (server === 'kugou' && type === 'pic' && cookie) {
      const cover = await getKugouCoverFromSonginfo({ hash: id, cookie, size: 400 })
      if (cover) {
        data = cover
      }
    }

    if (data === undefined) {
      const method = METING_METHODS[type]
      let response
      try {
        response = await meting[method](id)
      } catch (error) {
        throw new HTTPException(500, { message: '上游 API 调用失败' })
      }

      try {
        data = JSON.parse(response)
      } catch (error) {
        throw new HTTPException(500, { message: '上游 API 返回格式异常' })
      }
    }
    cache.set(cacheKey, data, {
      ttl: type === 'url' ? 1000 * 60 * 10 : 1000 * 60 * 60
    })
  }

  if (type === 'url') {
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
    const url = data.url
    if (!url) {
      return c.body(null, 404)
    }
    return c.redirect(url)
  }

  if (type === 'lrc') {
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
  return c.json(safeData.map(x => {
    // 兼容标准格式(name)与酷狗原始格式(songName)
    const title = x.name || x.songName || '未知歌曲'

    // 兼容歌手格式
    let author = '未知歌手'
    if (Array.isArray(x.artist)) {
      author = x.artist.join(' / ')
    } else if (Array.isArray(x.authors)) {
      author = x.authors.map(a => a.author_name).join(' / ') // 提取酷狗的歌手名
    } else if (typeof x.singerName === 'string') {
      author = x.singerName
    }

    // 兼容 ID 格式：标准用 url_id，酷狗原始用 hash
    const urlId = x.url_id || x.hash || id
    const picId = server === 'kugou'
      ? (x.hash || x.pic_id || x.url_id || id)
      : (x.pic_id || x.album_audio_id || x.albumid || x.hash || id)
    const lrcId = x.lyric_id || x.hash || id

    return {
      title,
      author,
      url: buildResourceUrl({
        server,
        type: 'url',
        id: urlId,
        requestKey,
        kugouPool
      }),
      pic: buildResourceUrl({
        server,
        type: 'pic',
        id: picId,
        requestKey,
        kugouPool
      }),
      lrc: buildResourceUrl({
        server,
        type: 'lrc',
        id: lrcId,
        requestKey,
        kugouPool
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

const resolveKugouPool = ({ server, referrer, allowCookie, requestKey }) => {
  if (server !== 'kugou') return { pool: 'default', reason: 'default' }
  if (hasValidKugouPremiumKey(requestKey)) return { pool: 'premium', reason: 'key' }
  if (referrer && config.meting.cookie.allowHosts.length > 0 && allowCookie) {
    return { pool: 'premium', reason: 'referrer' }
  }
  return { pool: 'general', reason: 'fallback' }
}

const getCacheMode = ({ server, allowCookie, kugouPool }) => {
  if (server === 'kugou') {
    return kugouPool
  }
  return allowCookie ? 'cookie' : 'anon'
}

const getCookiePool = ({ server, allowCookie, kugouPool }) => {
  if (server === 'kugou') return kugouPool
  return allowCookie ? 'default' : ''
}

const buildResourceUrl = ({ server, type, id, requestKey, kugouPool }) => {
  const url = new URL(`${config.meting.url}/music`)
  url.searchParams.set('server', server)
  url.searchParams.set('type', type)
  url.searchParams.set('id', id)
  url.searchParams.set('auth', auth(server, type, id))
  if (server === 'kugou' && kugouPool === 'premium' && hasValidKugouPremiumKey(requestKey)) {
    url.searchParams.set('key', requestKey)
  }
  return url.toString()
}

const auth = (server, type, id) => {
  return hashjs.hmac(hashjs.sha1, config.meting.token).update(`${server}${type}${id}`).digest('hex')
}
