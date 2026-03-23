import crypto from 'node:crypto'
import { writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import config from '../config.js'
import { clearCookieCache } from './cookie.js'

const SESSION_COOKIE = 'meting_admin_session'

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

const sign = (payload) => {
  return crypto.createHmac('sha256', config.admin.sessionSecret).update(payload).digest('hex')
}

export const hasAdminPassword = () => Boolean(config.admin.password)

export const verifyAdminPassword = (password) => {
  if (!hasAdminPassword()) return false
  return safeEqual(password, config.admin.password)
}

export const createAdminSession = () => {
  const expires = Date.now() + config.admin.sessionTtlMs
  const nonce = crypto.randomBytes(12).toString('hex')
  const payload = `${expires}.${nonce}`
  const signature = sign(payload)
  return `${payload}.${signature}`
}

export const verifyAdminSession = (token = '') => {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return false
  const [expires, nonce, signature] = parts
  const payload = `${expires}.${nonce}`
  if (!safeEqual(sign(payload), signature)) return false
  return Number(expires) > Date.now()
}

export const getAdminSessionCookieName = () => SESSION_COOKIE

export const getCookieValue = (cookieHeader = '', name) => {
  for (const part of String(cookieHeader || '').split(';')) {
    const item = part.trim()
    if (!item) continue
    const idx = item.indexOf('=')
    if (idx === -1) continue
    const key = item.slice(0, idx).trim()
    if (key !== name) continue
    return item.slice(idx + 1).trim()
  }
  return ''
}

export const setSessionCookie = (c, token) => {
  c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`)
}

export const clearSessionCookie = (c) => {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export const requireAdminAuth = (c) => {
  if (!hasAdminPassword()) return false
  const cookieHeader = c.req.header('cookie') || ''
  const token = getCookieValue(cookieHeader, SESSION_COOKIE)
  return verifyAdminSession(token)
}

export const maskText = (value, keep = 4) => {
  const raw = String(value || '')
  if (!raw) return ''
  if (raw.length <= keep * 2) return `${raw.slice(0, keep)}***`
  return `${raw.slice(0, keep)}***${raw.slice(-keep)}`
}

export const parseSimpleCookie = (cookie = '') => {
  const out = {}
  for (const part of String(cookie || '').split(';')) {
    const item = part.trim()
    if (!item) continue
    const idx = item.indexOf('=')
    if (idx === -1) continue
    out[item.slice(0, idx).trim()] = item.slice(idx + 1).trim()
  }
  return out
}

export const stringifyCookie = (cookieMap) => {
  return Object.entries(cookieMap)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}=${String(value).trim()}`)
    .join('; ')
}

export const normalizeKugouCookieForMeting = ({ existingCookie = '', upstreamCookie = '' }) => {
  const current = parseSimpleCookie(existingCookie)
  const upstream = parseSimpleCookie(upstreamCookie)

  if (upstream.token) {
    current.t = upstream.token
  }
  if (upstream.userid) {
    current.KugooID = upstream.userid
  }
  if (upstream.dfid) {
    current.dfid = upstream.dfid
    current.kg_dfid = upstream.dfid
  }
  if (upstream.t1 !== undefined) {
    current.t1 = upstream.t1
  }
  if (upstream.vip_type !== undefined) {
    current.vip_type = upstream.vip_type
  }
  if (upstream.vip_token !== undefined) {
    current.vip_token = upstream.vip_token
  }
  if (upstream.KUGOU_API_MID) {
    current.mid = upstream.KUGOU_API_MID
    current.kg_mid = upstream.KUGOU_API_MID
    current.kg_mid_temp = upstream.KUGOU_API_MID
  }

  return stringifyCookie(current)
}

export const writeCookiePool = async (pool, value) => {
  const cookieDir = resolve(process.cwd(), 'cookie')
  await mkdir(cookieDir, { recursive: true })
  const target = pool === 'premium' ? 'kugou-premium' : 'kugou-general'
  await writeFile(resolve(cookieDir, target), String(value || '').trim(), 'utf8')
  clearCookieCache()
}

const getPoolFilePath = (pool) => {
  const target = pool === 'premium' ? 'kugou-premium' : 'kugou-general'
  return resolve(process.cwd(), 'cookie', target)
}

export const clearCookiePool = async (pool) => {
  const filePath = getPoolFilePath(pool)
  try {
    await unlink(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  clearCookieCache()
}

export const copyCookiePool = async (fromPool, toPool) => {
  await mkdir(resolve(process.cwd(), 'cookie'), { recursive: true })
  await copyFile(getPoolFilePath(fromPool), getPoolFilePath(toPool))
  clearCookieCache()
}

export const moveCookiePool = async (fromPool, toPool) => {
  await mkdir(resolve(process.cwd(), 'cookie'), { recursive: true })
  await rename(getPoolFilePath(fromPool), getPoolFilePath(toPool))
  clearCookieCache()
}
