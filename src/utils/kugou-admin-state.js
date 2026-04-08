import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const statePath = resolve(process.cwd(), 'data', 'kugou-admin-state.json')

let cachedState = null

const createPoolState = () => ({
  lastRefreshAt: '',
  lastRefreshResult: null,
  lastClaimAt: '',
  lastClaimResult: null,
  lastProfileAt: '',
  account: null,
  lastError: null
})

const createDefaultState = () => ({
  version: 1,
  pools: {
    premium: createPoolState(),
    general: createPoolState()
  },
  sessions: {
    qrLogin: null,
    smsLogin: null
  }
})

const normalizePoolState = (value = {}) => ({
  ...createPoolState(),
  ...value
})

const normalizeState = (value = {}) => ({
  version: Number(value?.version || 1),
  pools: {
    premium: normalizePoolState(value?.pools?.premium),
    general: normalizePoolState(value?.pools?.general)
  },
  sessions: {
    qrLogin: value?.sessions?.qrLogin || null,
    smsLogin: value?.sessions?.smsLogin || null
  }
})

const persistState = async (state) => {
  const normalized = normalizeState(state)
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(normalized, null, 2), 'utf8')
  cachedState = normalized
  return normalized
}

export async function readKugouAdminState () {
  if (cachedState) return cachedState

  try {
    const raw = await readFile(statePath, 'utf8')
    cachedState = normalizeState(JSON.parse(raw))
    return cachedState
  } catch (error) {
    cachedState = createDefaultState()
    return cachedState
  }
}

export async function updateKugouAdminState (mutator) {
  const current = normalizeState(await readKugouAdminState())
  const draft = structuredClone(current)
  const next = await mutator(draft)
  return persistState(next || draft)
}

export async function getKugouAdminPoolState (pool) {
  const state = await readKugouAdminState()
  return state.pools?.[pool] || createPoolState()
}

export async function setKugouAdminPoolState (pool, patch) {
  return updateKugouAdminState((state) => {
    state.pools[pool] = {
      ...createPoolState(),
      ...(state.pools?.[pool] || {}),
      ...(patch || {})
    }
    return state
  })
}

export async function getKugouAdminSession (key) {
  const state = await readKugouAdminState()
  const value = state.sessions?.[key] || null

  if (!value?.expiresAt) return value
  if (Number(value.expiresAt) >= Date.now()) return value

  await setKugouAdminSession(key, null)
  return null
}

export async function setKugouAdminSession (key, value) {
  return updateKugouAdminState((state) => {
    state.sessions[key] = value || null
    return state
  })
}

export function getKugouAdminStatePath () {
  return statePath
}
