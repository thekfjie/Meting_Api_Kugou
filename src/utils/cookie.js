import { readFile, watch } from 'node:fs/promises'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import config from '../config.js'

// Cookie 缓存
const cookieCache = new Map()
const COOKIE_TTL = 1000 * 60 * 5 // 5分钟缓存过期

// 启动文件监听
const cookieDir = resolve(process.cwd(), 'cookie')
let watcher = null

const normalizePool = (server, pool = 'default') => {
  if (server !== 'kugou') return 'default'
  if (pool === 'premium' || pool === 'general') return pool
  return 'default'
}

const getCacheKey = (server, pool = 'default') => `${server}:${normalizePool(server, pool)}`

const getCookieSources = (server, pool = 'default') => {
  const normalizedPool = normalizePool(server, pool)

  if (server === 'kugou' && normalizedPool === 'premium') {
    return {
      envKeys: ['METING_COOKIE_KUGOU_PREMIUM', 'METING_COOKIE_KUGOU'],
      fileNames: ['kugou-premium', 'kugou']
    }
  }

  if (server === 'kugou' && normalizedPool === 'general') {
    return {
      envKeys: ['METING_COOKIE_KUGOU_GENERAL'],
      fileNames: ['kugou-general']
    }
  }

  return {
    envKeys: [`METING_COOKIE_${server.toUpperCase()}`],
    fileNames: [server]
  }
}

const readCookieFromFiles = async (fileNames = []) => {
  for (const fileName of fileNames) {
    try {
      const cookiePath = resolve(process.cwd(), 'cookie', fileName)
      const cookie = await readFile(cookiePath, 'utf-8')
      const value = cookie.trim()
      if (value) return value
    } catch (error) {}
  }

  return ''
}

async function startWatcher () {
  try {
    watcher = watch(cookieDir)
    for await (const event of watcher) {
      if (event.filename) {
        cookieCache.clear()
      }
    }
  } catch (error) {
    // 监听失败不影响正常运行
  }
}

// 启动监听（仅启动一次）
if (!watcher) {
  startWatcher().catch(() => {})
}

export async function readCookieFile (server, pool = 'default') {
  const now = Date.now()
  const cacheKey = getCacheKey(server, pool)
  const cached = cookieCache.get(cacheKey)

  // 检查缓存是否有效
  if (cached && now - cached.timestamp < COOKIE_TTL) {
    return cached.value
  }

  const { envKeys, fileNames } = getCookieSources(server, pool)

  // 优先从环境变量读取
  for (const envKey of envKeys) {
    const envCookie = process.env[envKey]
    if (envCookie) {
      const value = envCookie.trim()
      cookieCache.set(cacheKey, {
        value,
        timestamp: now
      })
      return value
    }
  }

  // 从文件读取
  const fileValue = await readCookieFromFiles(fileNames)
  if (fileValue) {
    cookieCache.set(cacheKey, {
      value: fileValue,
      timestamp: now
    })

    return fileValue
  }

  // 读取失败时也缓存空字符串，避免频繁读取不存在的文件
  cookieCache.set(cacheKey, {
    value: '',
    timestamp: now
  })
  return ''
}

export async function inspectCookieSource (server, pool = 'default') {
  const { envKeys, fileNames } = getCookieSources(server, pool)

  for (const envKey of envKeys) {
    const envCookie = process.env[envKey]
    if (envCookie && envCookie.trim()) {
      return {
        source: 'env',
        activeKey: envKey,
        filePath: '',
        fallbackOrder: [...envKeys, ...fileNames.map(name => `cookie/${name}`)]
      }
    }
  }

  for (const fileName of fileNames) {
    try {
      const cookiePath = resolve(process.cwd(), 'cookie', fileName)
      const cookie = await readFile(cookiePath, 'utf-8')
      if (cookie.trim()) {
        return {
          source: 'file',
          activeKey: fileName,
          filePath: cookiePath,
          fallbackOrder: [...envKeys, ...fileNames.map(name => `cookie/${name}`)]
        }
      }
    } catch (error) {}
  }

  return {
    source: 'none',
    activeKey: '',
    filePath: resolve(process.cwd(), 'cookie', fileNames[0] || server),
    fallbackOrder: [...envKeys, ...fileNames.map(name => `cookie/${name}`)]
  }
}

export async function readCookiePoolFile (server, pool = 'default') {
  const { fileNames } = getCookieSources(server, pool)
  return readCookieFromFiles(fileNames)
}

export function clearCookieCache () {
  cookieCache.clear()
}

/**
 * 验证 referrer 是否在允许的主机列表中
 * @param {string} referrer - 请求的 referrer
 * @returns {boolean} 是否允许
 */
export function isAllowedHost (referrer) {
  if (config.meting.cookie.allowHosts.length === 0) return true
  if (!referrer) return false

  try {
    const url = new URL(referrer)
    const hostname = url.hostname.toLowerCase()
    return config.meting.cookie.allowHosts.includes(hostname)
  } catch (error) {
    return false
  }
}
