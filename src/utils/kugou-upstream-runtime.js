import config from '../config.js'

const KUGOU_POOLS = ['premium', 'general']

const normalizePool = pool => (pool === 'general' ? 'general' : 'premium')
const normalizeText = value => String(value || '').trim()
const normalizePlatform = value => normalizeText(value).toLowerCase() === 'lite' ? 'lite' : 'default'

const getPlatformUpstreamUrl = (platform) => {
  if (platform === 'lite') {
    return normalizeText(config.meting.kugou.upstream.liteUrl)
  }

  return normalizeText(config.meting.kugou.upstream.defaultUrl)
}

const getPlatformProcessName = (platform) => {
  if (platform === 'lite') {
    return normalizeText(config.meting.kugou.upstream.processNames?.lite) || 'kugou-upstream-lite'
  }

  return normalizeText(config.meting.kugou.upstream.processNames?.default) || 'kugou-upstream'
}

export const getKugouPoolPlatform = pool => {
  const normalizedPool = normalizePool(pool)
  return normalizePlatform(config.meting.kugou.pools?.[normalizedPool]?.platform || 'default')
}

export const isKugouPoolLite = pool => getKugouPoolPlatform(pool) === 'lite'

export const shouldAutoClaimKugouPool = pool => {
  const normalizedPool = normalizePool(pool)
  return isKugouPoolLite(normalizedPool) && Boolean(config.meting.kugou.pools?.[normalizedPool]?.autoClaim)
}

export const listKugouPoolPlatforms = () => {
  return KUGOU_POOLS.map(pool => ({
    pool,
    platform: getKugouPoolPlatform(pool),
    autoClaim: shouldAutoClaimKugouPool(pool),
    upstreamUrl: getKugouPoolUpstreamUrl(pool),
    processName: getKugouPoolUpstreamProcessName(pool)
  }))
}

export const getKugouPoolUpstreamUrl = pool => {
  const platform = getKugouPoolPlatform(pool)
  return getPlatformUpstreamUrl(platform)
}

export const hasKugouPoolUpstream = pool => Boolean(getKugouPoolUpstreamUrl(pool))

export const hasAnyKugouUpstream = () => {
  return KUGOU_POOLS.some(pool => hasKugouPoolUpstream(pool))
}

export const getKugouPoolUpstreamProcessName = pool => {
  const platform = getKugouPoolPlatform(pool)
  return getPlatformProcessName(platform)
}

export const listKugouUpstreamProcessNames = () => {
  return [...new Set(KUGOU_POOLS.map(pool => getKugouPoolUpstreamProcessName(pool)).filter(Boolean))]
}
