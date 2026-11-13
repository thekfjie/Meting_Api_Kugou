import { createHash } from 'node:crypto'
import { logger } from '../middleware/logger.js'
import { parseKugouCookie } from './kugou-songinfo.js'
import { getKugouPoolPlatform } from './kugou-upstream-runtime.js'

const fingerprint = value => value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : ''

export const kugouAuthSummary = (cookie = '') => {
  const c = parseKugouCookie(cookie)
  return {
    user: fingerprint(c.KugooID || c.userid),
    token: fingerprint(c.t || c.token),
    mid: fingerprint(c.KUGOU_API_MID || c.mid || c.kg_mid),
    dfid: fingerprint(c.dfid || c.kg_dfid),
    guid: fingerprint(c.KUGOU_API_GUID),
    dev: fingerprint(c.KUGOU_API_DEV),
    platform: c.KUGOU_API_PLATFORM || ''
  }
}

export const logKugouAuth = (pool, phase, details = {}) => {
  logger.info({ event: 'kugou-auth', pool, platform: getKugouPoolPlatform(pool), phase, ...details }, 'Kugou authentication')
}
