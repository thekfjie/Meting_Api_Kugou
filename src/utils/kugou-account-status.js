import config from '../config.js'
import Meting from '@meting/core'
import { readCookieFile } from './cookie.js'
import { getKugouRuntimeSnapshot } from './kugou-runtime.js'
import { getKugouSonginfo, parseKugouCookie } from './kugou-songinfo.js'
import { getKugouUpstreamData, hasKugouUpstream } from './kugou-upstream.js'

let cachedStatus = null

const STATUS_TTL_BASE_MS = 5 * 60 * 1000
const STATUS_TTL_JITTER_MS = 60 * 1000

const nowIso = () => new Date().toISOString()
const randomStatusTtlMs = () => {
  const offset = Math.floor(Math.random() * (STATUS_TTL_JITTER_MS * 2 + 1)) - STATUS_TTL_JITTER_MS
  return STATUS_TTL_BASE_MS + offset
}

const getPlayableUrl = (data) => data?.play_url || data?.play_backup_url || ''

const getResolvedUrl = (data) => {
  if (!data) return ''
  if (typeof data === 'string') return data
  if (typeof data?.url === 'string') return data.url
  return ''
}

const getFirstItem = (data) => {
  if (Array.isArray(data)) return data[0] || null
  return data && typeof data === 'object' ? data : null
}

const getKugouResolvedUrl = async ({ hash, cookie }) => {
  if (!hash || !cookie) return ''

  try {
    const meting = new Meting('kugou')
    meting.format(true)
    meting.cookie(cookie)

    const response = await meting.url(String(hash).toUpperCase())
    const data = JSON.parse(response)
    return typeof data?.url === 'string' ? data.url : ''
  } catch (error) {
    return ''
  }
}

const getKugouAnonymousSong = async (hash) => {
  if (!hash) return null

  try {
    const meting = new Meting('kugou')
    meting.format(true)

    const response = await meting.song(String(hash).toUpperCase())
    return getFirstItem(JSON.parse(response))
  } catch (error) {
    return null
  }
}

const getKugouAnonymousResolvedUrl = async (hash) => {
  if (!hash) return ''

  try {
    const meting = new Meting('kugou')
    meting.format(true)

    const response = await meting.url(String(hash).toUpperCase())
    const data = JSON.parse(response)
    return typeof data?.url === 'string' ? data.url : ''
  } catch (error) {
    return ''
  }
}

const classifyVipCapability = ({ songinfo, resolvedUrl }) => {
  const normalizedResolvedUrl = getResolvedUrl(resolvedUrl)

  if (normalizedResolvedUrl) {
    if (normalizedResolvedUrl.includes('/yp/full/')) {
      return {
        vip: true,
        vipState: 'full',
        vipReason: 'resolved-url-full'
      }
    }

    if (normalizedResolvedUrl.includes('/yp/p_')) {
      return {
        vip: false,
        vipState: 'preview',
        vipReason: 'resolved-url-preview'
      }
    }

    return {
      vip: true,
      vipState: 'full',
      vipReason: 'resolved-url-direct'
    }
  }

  if (!songinfo) {
    return {
      vip: false,
      vipState: 'unreachable',
      vipReason: 'vip-probe-no-data'
    }
  }

  const playUrl = getPlayableUrl(songinfo)
  if (!playUrl) {
    return {
      vip: false,
      vipState: 'blocked',
      vipReason: 'vip-probe-no-url'
    }
  }

  if (playUrl.includes('/yp/full/')) {
    return {
      vip: true,
      vipState: 'full',
      vipReason: 'ok'
    }
  }

  if (playUrl.includes('/yp/p_')) {
    return {
      vip: false,
      vipState: 'preview',
      vipReason: 'preview-only'
    }
  }

  const expectedDurationMs = config.meting.kugou.status.vipDurationMs
  const actualDurationMs = Number(songinfo.timelength || 0)

  if (expectedDurationMs > 0 && actualDurationMs > 0) {
    if (actualDurationMs >= expectedDurationMs * 0.9) {
      return {
        vip: true,
        vipState: 'full',
        vipReason: 'duration-match'
      }
    }

    return {
      vip: false,
      vipState: 'preview',
      vipReason: 'duration-preview'
    }
  }

  return {
    vip: false,
    vipState: 'unknown',
    vipReason: 'vip-probe-ambiguous'
  }
}

const withLoad = (pool, account, runtime) => {
  const currentPerMinute = runtime?.perMinute?.[pool] || 0
  const maxPerMinute = config.meting.kugou.status.maxRpm[pool] || 0
  const usagePercent = maxPerMinute > 0
    ? Math.min(999, Math.round((currentPerMinute / maxPerMinute) * 100))
    : null

  return {
    ...account,
    load: {
      currentPerMinute,
      maxPerMinute,
      usagePercent
    }
  }
}

const hasRequiredFields = (cookie) => {
  return Boolean(cookie.t && cookie.KugooID && (cookie.mid || cookie.kg_mid) && (cookie.dfid || cookie.kg_dfid))
}

const buildInternalStatus = async () => {
  const basicData = await getKugouAnonymousSong(config.meting.kugou.status.freeHash)
  const basicUrl = await getKugouAnonymousResolvedUrl(config.meting.kugou.status.freeHash)
  const valid = Boolean(
    basicUrl ||
    basicData?.hash ||
    basicData?.songName ||
    basicData?.name ||
    basicData?.url
  )

  if (!valid) {
    return {
      mode: 'anonymous',
      configured: true,
      requiredFields: true,
      valid: false,
      vip: false,
      vipState: 'unreachable',
      routeEligible: true,
      statusReason: 'legacy-anonymous-meting',
      vipReason: 'not-tested'
    }
  }

  if (!config.meting.kugou.status.vipHash) {
    return {
      mode: 'anonymous',
      configured: true,
      requiredFields: true,
      valid: true,
      vip: null,
      vipState: 'untested',
      routeEligible: true,
      statusReason: 'ok',
      vipReason: 'vip-hash-unset'
    }
  }

  const [vipSong, vipResolvedUrl] = await Promise.all([
    getKugouAnonymousSong(config.meting.kugou.status.vipHash),
    getKugouAnonymousResolvedUrl(config.meting.kugou.status.vipHash)
  ])
  const vipResult = classifyVipCapability({
    songinfo: vipSong,
    resolvedUrl: vipResolvedUrl
  })

  return {
    mode: 'anonymous',
    configured: true,
    requiredFields: true,
    valid: true,
    vip: vipResult.vip,
    vipState: vipResult.vipState,
    routeEligible: true,
    statusReason: 'ok',
    vipReason: vipResult.vipReason
  }
}

const probeCookiePool = async (pool) => {
  const cookie = await readCookieFile('kugou', pool)

  if (!cookie) {
    return {
      mode: 'cookie',
      configured: false,
      requiredFields: false,
      valid: false,
      vip: null,
      vipState: 'untested',
      routeEligible: false,
      statusReason: 'missing-cookie',
      vipReason: 'not-tested'
    }
  }

  const parsed = parseKugouCookie(cookie)
  const requiredFields = hasRequiredFields(parsed)

  if (!requiredFields) {
    return {
      mode: 'cookie',
      configured: true,
      requiredFields: false,
      valid: false,
      vip: null,
      vipState: 'untested',
      routeEligible: false,
      statusReason: 'missing-required-fields',
      vipReason: 'not-tested'
    }
  }

  const basicData = hasKugouUpstream()
    ? await getKugouUpstreamData({
      type: 'song',
      id: config.meting.kugou.status.freeHash,
      cookie
    })
    : await getKugouSonginfo({
      hash: config.meting.kugou.status.freeHash,
      cookie
    })

  const valid = Boolean(
    basicData?.hash ||
    basicData?.audio_name ||
    basicData?.song_name ||
    basicData?.title ||
    basicData?.name
  )

  if (!valid) {
    return {
      mode: 'cookie',
      configured: true,
      requiredFields: true,
      valid: false,
      vip: null,
      vipState: 'untested',
      routeEligible: false,
      statusReason: hasKugouUpstream() ? 'upstream-basic-probe-failed' : 'songinfo-probe-failed',
      vipReason: 'not-tested'
    }
  }

  if (!config.meting.kugou.status.vipHash) {
    return {
      mode: 'cookie',
      configured: true,
      requiredFields: true,
      valid: true,
      vip: null,
      vipState: 'untested',
      routeEligible: true,
      statusReason: 'ok',
      vipReason: 'vip-hash-unset'
    }
  }

  const vipData = hasKugouUpstream()
    ? await getKugouUpstreamData({
      type: 'song',
      id: config.meting.kugou.status.vipHash,
      cookie
    })
    : await getKugouSonginfo({
      hash: config.meting.kugou.status.vipHash,
      cookie
    })

  const resolvedUrl = hasKugouUpstream()
    ? await getKugouUpstreamData({
      type: 'url',
      id: vipData?.url_id || vipData?.hash || config.meting.kugou.status.vipHash,
      cookie
    })
    : await getKugouResolvedUrl({
      hash: config.meting.kugou.status.vipHash,
      cookie
    })

  const vipResult = classifyVipCapability({
    songinfo: vipData,
    resolvedUrl
  })

  return {
    mode: 'cookie',
    configured: true,
    requiredFields: true,
    valid: true,
    vip: vipResult.vip,
    vipState: vipResult.vipState,
    routeEligible: true,
    statusReason: 'ok',
    vipReason: vipResult.vipReason
  }
}

const buildStatusPayload = ({ checkedAt, ttl, expiresAt, premium, general, internal }) => {
  const runtime = getKugouRuntimeSnapshot()
  const premiumMaxPerMinute = config.meting.kugou.status.maxRpm.premium || 0
  const generalMaxPerMinute = config.meting.kugou.status.maxRpm.general || 0
  const premiumRemaining = Math.max(0, premiumMaxPerMinute - (runtime.perMinute?.premium || 0))
  const generalRemaining = Math.max(0, generalMaxPerMinute - (runtime.perMinute?.general || 0))
  const cacheRemainingMs = expiresAt ? Math.max(0, expiresAt - Date.now()) : 0

  return {
    checkedAt,
    ttlSeconds: Math.floor(ttl / 1000),
    nextCheckAt: expiresAt ? new Date(expiresAt).toISOString() : '',
    cacheRemainingSeconds: Math.floor(cacheRemainingMs / 1000),
    auth: {
      premiumKeyConfigured: Boolean(config.meting.kugou.premiumKey),
      premiumByReferrerAllowed: config.meting.cookie.allowHosts.length > 0,
      allowHosts: config.meting.cookie.allowHosts
    },
    traffic: {
      ...runtime,
      remainingPerMinute: {
        premium: premiumRemaining,
        general: generalRemaining,
        total: premiumRemaining + generalRemaining
      }
    },
    accounts: {
      premium: withLoad('premium', premium, runtime),
      general: withLoad('general', general, runtime),
      internal
    }
  }
}

export async function getKugouAccountStatus (force = false) {
  const now = Date.now()

  if (!force && cachedStatus && now < (cachedStatus.expiresAt || 0)) {
    return buildStatusPayload({
      checkedAt: cachedStatus.checkedAt,
      ttl: cachedStatus.ttlMs,
      expiresAt: cachedStatus.expiresAt,
      premium: cachedStatus.accounts.premium,
      general: cachedStatus.accounts.general,
      internal: cachedStatus.accounts.internal
    })
  }

  const [premium, general, internal] = await Promise.all([
    probeCookiePool('premium'),
    probeCookiePool('general'),
    buildInternalStatus()
  ])
  const ttl = randomStatusTtlMs()

  cachedStatus = {
    checkedAt: nowIso(),
    ttlMs: ttl,
    expiresAt: now + ttl,
    accounts: {
      premium,
      general,
      internal
    }
  }

  return buildStatusPayload({
    checkedAt: cachedStatus.checkedAt,
    ttl,
    expiresAt: cachedStatus.expiresAt,
    premium,
    general,
    internal
  })
}
