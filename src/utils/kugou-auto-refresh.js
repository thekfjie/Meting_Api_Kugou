import config from '../config.js'
import { logger } from '../middleware/logger.js'
import { readCookieFile } from './cookie.js'
import { isDueAt, buildNextClaimAt, buildNextRefreshAt } from './kugou-auto-schedule.js'
import {
  claimKugouLiteVip,
  refreshKugouPool
} from './kugou-admin-actions.js'
import { getKugouAdminPoolState, setKugouAdminPoolState } from './kugou-admin-state.js'
import { hasKugouUpstreamAuth } from './kugou-upstream-auth.js'
import { shouldAutoClaimKugouPool } from './kugou-upstream-runtime.js'

const KUGOU_POOLS = ['premium', 'general']

let timer = null
let running = false

const normalizePool = pool => (pool === 'general' ? 'general' : 'premium')

const ensureScheduleState = async (pool, state, hasCookie) => {
  const normalizedPool = normalizePool(pool)
  const patch = {}

  if (hasCookie && !state?.nextRefreshAt) {
    patch.nextRefreshAt = buildNextRefreshAt()
  }

  if (!hasCookie && state?.nextRefreshAt) {
    patch.nextRefreshAt = ''
  }

  if (shouldAutoClaimKugouPool(normalizedPool)) {
    if (hasCookie && !state?.nextClaimAt) {
      patch.nextClaimAt = buildNextClaimAt()
    }
  } else if (state?.nextClaimAt) {
    patch.nextClaimAt = ''
  }

  if (!hasCookie && state?.nextClaimAt) {
    patch.nextClaimAt = ''
  }

  if (Object.keys(patch).length > 0) {
    await setKugouAdminPoolState(normalizedPool, patch)
    return {
      ...state,
      ...patch
    }
  }

  return state
}

const runPoolJobs = async (pool) => {
  const normalizedPool = normalizePool(pool)
  const cookie = await readCookieFile('kugou', normalizedPool)
  const initialState = await getKugouAdminPoolState(normalizedPool)
  const state = await ensureScheduleState(normalizedPool, initialState, Boolean(cookie))

  if (!cookie) return

  const now = Date.now()
  let refreshFailed = false
  if (isDueAt(state?.nextRefreshAt, now)) {
    const result = await refreshKugouPool(normalizedPool, { trigger: 'auto' })
    refreshFailed = !result.ok
    logger.info({
      pool: normalizedPool,
      ok: result.ok,
      trigger: 'auto-refresh'
    }, 'Kugou pool refresh finished')
  }

  if (refreshFailed) return

  const refreshedState = await getKugouAdminPoolState(normalizedPool)
  if (shouldAutoClaimKugouPool(normalizedPool) && isDueAt(refreshedState?.nextClaimAt, now)) {
    const result = await claimKugouLiteVip(normalizedPool, { trigger: 'auto' })
    logger.info({
      pool: normalizedPool,
      ok: result.ok,
      trigger: 'auto-claim'
    }, 'Kugou lite claim finished')
  }
}

const tick = async () => {
  if (running) return
  if (!hasKugouUpstreamAuth()) return

  running = true
  try {
    for (const pool of KUGOU_POOLS) {
      await runPoolJobs(pool)
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Kugou scheduler tick failed')
  } finally {
    running = false
  }
}

export const startKugouAutoRefreshScheduler = () => {
  if (timer) return

  const intervalMs = Math.max(30 * 1000, config.meting.kugou.scheduler.checkIntervalMs || 60 * 1000)
  timer = setInterval(() => {
    tick().catch(() => {})
  }, intervalMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  tick().catch(() => {})
  logger.info({ intervalMs }, 'Kugou scheduler started')
}
