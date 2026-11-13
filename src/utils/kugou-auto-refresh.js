import config from '../config.js'
import { logger } from '../middleware/logger.js'
import { readCookieFile } from './cookie.js'
import { isDueAt, buildNextClaimAt, buildNextRefreshAt } from './kugou-auto-schedule.js'
import {
  claimKugouLiteVip,
  refreshKugouPool,
  runKugouAccountAction
} from './kugou-admin-actions.js'
import { getKugouAdminPoolState, setKugouAdminPoolState, readKugouAdminState, updateKugouAdminState } from './kugou-admin-state.js'
import { getKugouAccountId } from './kugou-accounts.js'
import { hasKugouUpstreamAuth } from './kugou-upstream-auth.js'
import { getKugouPoolPlatform, shouldAutoClaimKugouPool } from './kugou-upstream-runtime.js'

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
  if ((await readKugouAdminState()).dispatch.disabled.includes(getKugouAccountId(cookie, getKugouPoolPlatform(pool)))) return
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

export const runKugouAutoRefreshTick = async () => {
  if (running) return
  if (!hasKugouUpstreamAuth()) return

  running = true
  try {
    for (const pool of KUGOU_POOLS) {
      await runPoolJobs(pool)
    }
    const currentIds = await Promise.all(KUGOU_POOLS.map(async pool => getKugouAccountId(await readCookieFile('kugou', pool), getKugouPoolPlatform(pool))))
    const state = await readKugouAdminState()
    for (const account of Object.values(state.accounts)) {
      if (currentIds.includes(account.id) || state.dispatch.disabled.includes(account.id)) continue
      const pool = KUGOU_POOLS.find(pool => account.platform === getKugouPoolPlatform(pool))
      if (!pool) continue
      const schedule = account.maintenance || {}
      const patch = {}
      if (!schedule.nextRefreshAt) patch.nextRefreshAt = buildNextRefreshAt()
      if (shouldAutoClaimKugouPool(pool) && !schedule.nextClaimAt) patch.nextClaimAt = buildNextClaimAt()
      if (Object.keys(patch).length) await updateKugouAdminState(draft => { draft.accounts[account.id].maintenance = { ...schedule, ...patch } })
      if (isDueAt(schedule.nextRefreshAt)) {
        const result = await runKugouAccountAction(account.id, 'refresh')
        if (!result.ok) continue
      }
      if (shouldAutoClaimKugouPool(pool) && isDueAt(schedule.nextClaimAt)) await runKugouAccountAction(account.id, 'claim')
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
    runKugouAutoRefreshTick().catch(() => {})
  }, intervalMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  runKugouAutoRefreshTick().catch(() => {})
  logger.info({ intervalMs }, 'Kugou scheduler started')
}

export const stopKugouAutoRefreshScheduler = () => {
  clearInterval(timer)
  timer = null
}
