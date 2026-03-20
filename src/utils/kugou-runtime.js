import config from '../config.js'

const state = {
  startedAt: new Date().toISOString(),
  minuteBucket: Math.floor(Date.now() / (60 * 1000)),
  recent: {
    premium: [],
    general: []
  },
  requests: {
    premium: 0,
    general: 0,
    byKey: 0,
    byReferrer: 0,
    fallback: 0
  },
  cache: {
    premiumHit: 0,
    premiumMiss: 0,
    generalHit: 0,
    generalMiss: 0
  },
  exempt: {
    premium: 0,
    general: 0,
    blogPlaylist: 0
  },
  blocked: {
    premium: 0,
    general: 0
  },
  lastRequestAt: {
    premium: null,
    general: null
  }
}

const WINDOW_MS = 60 * 1000

const refreshMinuteWindow = (now = Date.now()) => {
  const bucket = Math.floor(now / WINDOW_MS)
  if (bucket !== state.minuteBucket) {
    state.minuteBucket = bucket
    for (const pool of ['premium', 'general']) {
      state.recent[pool] = []
    }
  }
}

const getMaxPerMinute = (pool) => {
  return config.meting.kugou.status.maxRpm[pool] || 0
}

const getRemainingPerMinute = (pool, currentPerMinute = state.recent[pool]?.length || 0) => {
  const maxPerMinute = getMaxPerMinute(pool)
  return Math.max(0, maxPerMinute - currentPerMinute)
}

const applyReasonStats = (reason) => {
  if (reason === 'key') state.requests.byKey += 1
  if (reason === 'referrer') state.requests.byReferrer += 1
  if (reason === 'fallback') state.requests.fallback += 1
}

export function peekKugouQuota (pool) {
  if (pool !== 'premium' && pool !== 'general') {
    return {
      allowed: true,
      currentPerMinute: 0,
      remainingPerMinute: 0
    }
  }

  refreshMinuteWindow()
  const currentPerMinute = state.recent[pool].length
  const maxPerMinute = getMaxPerMinute(pool)
  const allowed = maxPerMinute <= 0 || currentPerMinute < maxPerMinute

  return {
    allowed,
    currentPerMinute,
    remainingPerMinute: allowed ? getRemainingPerMinute(pool, currentPerMinute) : 0
  }
}

export function recordKugouBlocked ({ pool, reason }) {
  if (pool !== 'premium' && pool !== 'general') return

  const now = Date.now()
  refreshMinuteWindow(now)

  state.requests[pool] += 1
  state.lastRequestAt[pool] = new Date(now).toISOString()
  applyReasonStats(reason)
  state.blocked[pool] += 1

  return {
    allowed: false,
    currentPerMinute: state.recent[pool].length,
    remainingPerMinute: 0,
    countedTowardQuota: false
  }
}

export function recordKugouRequest ({
  pool,
  reason,
  cacheHit,
  countTowardQuota = !cacheHit,
  exemptTag = ''
}) {
  if (pool !== 'premium' && pool !== 'general') return

  const now = Date.now()
  refreshMinuteWindow(now)

  state.requests[pool] += 1
  state.lastRequestAt[pool] = new Date(now).toISOString()

  applyReasonStats(reason)

  const bucket = `${pool}${cacheHit ? 'Hit' : 'Miss'}`
  state.cache[bucket] += 1

  if (!countTowardQuota) {
    if (!cacheHit) {
      state.exempt[pool] += 1
      if (exemptTag === 'blog-playlist') {
        state.exempt.blogPlaylist += 1
      }
    }

    return {
      allowed: true,
      currentPerMinute: state.recent[pool].length,
      remainingPerMinute: getRemainingPerMinute(pool),
      countedTowardQuota: false
    }
  }

  const quotaState = peekKugouQuota(pool)
  if (!quotaState.allowed) {
    state.blocked[pool] += 1
    return {
      allowed: false,
      currentPerMinute: quotaState.currentPerMinute,
      remainingPerMinute: 0,
      countedTowardQuota: false
    }
  }

  state.recent[pool].push(now)

  return {
    allowed: true,
    currentPerMinute: state.recent[pool].length,
    remainingPerMinute: getRemainingPerMinute(pool, state.recent[pool].length),
    countedTowardQuota: true
  }
}

export function getKugouRuntimeSnapshot () {
  refreshMinuteWindow()

  return {
    startedAt: state.startedAt,
    requests: { ...state.requests },
    cache: { ...state.cache },
    exempt: {
      ...state.exempt,
      total: state.exempt.premium + state.exempt.general
    },
    blocked: {
      ...state.blocked,
      total: state.blocked.premium + state.blocked.general
    },
    lastRequestAt: { ...state.lastRequestAt },
    perMinute: {
      windowSeconds: 60,
      premium: state.recent.premium.length,
      general: state.recent.general.length,
      total: state.recent.premium.length + state.recent.general.length
    }
  }
}
