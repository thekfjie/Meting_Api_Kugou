const state = {
  startedAt: new Date().toISOString(),
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
  lastRequestAt: {
    premium: null,
    general: null
  }
}

const WINDOW_MS = 60 * 1000

const pruneRecent = (now = Date.now()) => {
  for (const pool of ['premium', 'general']) {
    state.recent[pool] = state.recent[pool].filter(ts => now - ts < WINDOW_MS)
  }
}

export function recordKugouRequest ({ pool, reason, cacheHit }) {
  if (pool !== 'premium' && pool !== 'general') return

  const now = Date.now()
  pruneRecent(now)
  state.recent[pool].push(now)

  state.requests[pool] += 1
  state.lastRequestAt[pool] = new Date().toISOString()

  if (reason === 'key') state.requests.byKey += 1
  if (reason === 'referrer') state.requests.byReferrer += 1
  if (reason === 'fallback') state.requests.fallback += 1

  const bucket = `${pool}${cacheHit ? 'Hit' : 'Miss'}`
  state.cache[bucket] += 1
}

export function getKugouRuntimeSnapshot () {
  pruneRecent()

  return {
    startedAt: state.startedAt,
    requests: { ...state.requests },
    cache: { ...state.cache },
    lastRequestAt: { ...state.lastRequestAt },
    perMinute: {
      windowSeconds: 60,
      premium: state.recent.premium.length,
      general: state.recent.general.length,
      total: state.recent.premium.length + state.recent.general.length
    }
  }
}
