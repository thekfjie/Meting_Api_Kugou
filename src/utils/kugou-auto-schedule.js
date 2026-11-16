import config from '../config.js'

const oneDayMs = 24 * 60 * 60 * 1000

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max)

const randomSignedOffset = max => {
  const limit = Math.max(0, Number(max || 0))
  if (!limit) return 0
  return Math.floor(Math.random() * (limit * 2 + 1)) - limit
}

export const parseTime = value => {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export const isDueAt = (value, now = Date.now()) => {
  const parsed = parseTime(value)
  return parsed > 0 && parsed <= now
}

export const buildNextRefreshAt = ({ now = Date.now(), retry = false } = {}) => {
  const baseMs = retry
    ? config.meting.kugou.scheduler.refreshRetryMs
    : config.meting.kugou.scheduler.refreshBaseMs
  const jitterMs = retry
    ? Math.min(config.meting.kugou.scheduler.refreshJitterMs, Math.floor(baseMs / 2))
    : config.meting.kugou.scheduler.refreshJitterMs
  return new Date(now + baseMs + randomSignedOffset(jitterMs)).toISOString()
}

export const buildNextClaimAt = ({ now = Date.now() } = {}) => {
  const current = new Date(now)
  const startHour = clampNumber(config.meting.kugou.scheduler.claimWindowStartHour, 0, 23)
  const endHour = clampNumber(config.meting.kugou.scheduler.claimWindowEndHour, startHour + 1, 24)

  const start = new Date(current)
  start.setHours(startHour, 0, 0, 0)

  const end = new Date(current)
  end.setHours(endHour, 0, 0, 0)

  let windowStart = start.getTime()
  let windowEnd = end.getTime()
  if (now >= windowEnd) {
    windowStart += oneDayMs
    windowEnd += oneDayMs
  }

  const span = Math.max(60 * 1000, windowEnd - windowStart)
  const offset = Math.floor(Math.random() * span)
  return new Date(windowStart + offset).toISOString()
}
