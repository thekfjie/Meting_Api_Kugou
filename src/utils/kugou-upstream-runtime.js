import crypto from 'node:crypto'
import config from '../config.js'
import { parseSimpleCookie } from './admin.js'
import { readCookiePoolFile } from './cookie.js'
import { getKugouRuntimeProfile, setKugouRuntimeProfile } from './kugou-admin-state.js'

const KUGOU_POOLS = ['premium', 'general']

const normalizePool = pool => (pool === 'general' ? 'general' : 'premium')
const normalizeText = value => String(value || '').trim()
const normalizePlatform = value => normalizeText(value).toLowerCase() === 'lite' ? 'lite' : 'default'

const randomHex = size => crypto.randomBytes(size).toString('hex')
const randomGuid = () => crypto.createHash('md5').update(crypto.randomUUID()).digest('hex')
const randomDev = () => randomHex(5).toUpperCase()
const randomMac = () => {
  const bytes = [...crypto.randomBytes(5)]
  return ['02', ...bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase())].join(':')
}

const getPoolEnvKey = (pool, suffix) => `METING_KUGOU_${normalizePool(pool).toUpperCase()}_${suffix}`

const parseCookieCandidates = (...cookies) => {
  const merged = {}
  for (const cookie of cookies) {
    Object.assign(merged, parseSimpleCookie(cookie))
  }
  return merged
}

const pickText = (...values) => {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) return normalized
  }
  return ''
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
    autoClaim: shouldAutoClaimKugouPool(pool)
  }))
}

export const getKugouPoolRuntime = async (pool, { cookie = '' } = {}) => {
  const normalizedPool = normalizePool(pool)
  const poolCookie = await readCookiePoolFile('kugou', normalizedPool)
  const cookieMap = parseCookieCandidates(poolCookie, cookie)
  const saved = await getKugouRuntimeProfile(normalizedPool)

  const next = {
    guid: pickText(
      process.env[getPoolEnvKey(normalizedPool, 'GUID')],
      saved.guid,
      cookieMap.KUGOU_API_GUID,
      randomGuid()
    ),
    dev: pickText(
      process.env[getPoolEnvKey(normalizedPool, 'DEV')],
      saved.dev,
      cookieMap.KUGOU_API_DEV,
      randomDev()
    ).toUpperCase(),
    mac: pickText(
      process.env[getPoolEnvKey(normalizedPool, 'MAC')],
      saved.mac,
      cookieMap.KUGOU_API_MAC,
      randomMac()
    ).toUpperCase()
  }

  if (next.guid !== saved.guid || next.dev !== saved.dev || next.mac !== saved.mac) {
    await setKugouRuntimeProfile(normalizedPool, next)
  }

  return {
    pool: normalizedPool,
    platform: getKugouPoolPlatform(normalizedPool),
    guid: next.guid,
    dev: next.dev,
    mac: next.mac
  }
}

export const buildKugouUpstreamRuntimeHeaders = async (pool, { cookie = '' } = {}) => {
  const runtime = await getKugouPoolRuntime(pool, { cookie })
  const headers = {
    'x-kugou-pool': runtime.pool,
    'x-kugou-platform': runtime.platform,
    'x-kugou-guid': runtime.guid,
    'x-kugou-dev': runtime.dev,
    'x-kugou-mac': runtime.mac
  }

  if (config.meting.kugou.upstream.runtimeSecret) {
    headers['x-kugou-runtime-secret'] = config.meting.kugou.upstream.runtimeSecret
  }

  return headers
}
