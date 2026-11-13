import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const statePath = resolve(process.cwd(), 'data', 'kugou-admin-state.json')

let cachedState = null
let pendingUpdate = Promise.resolve()

const normalizeLoginSessions = (value = {}) => {
  if (value?.pool) return { premium: null, general: null, [value.pool]: value }
  return { premium: value?.premium || null, general: value?.general || null }
}

const createPoolState = () => ({
  lastRefreshAt: '',
  lastRefreshResult: null,
  nextRefreshAt: '',
  lastClaimAt: '',
  lastClaimResult: null,
  nextClaimAt: '',
  lastProfileAt: '',
  account: null,
  lastError: null
})

const createRuntimeState = () => ({
  guid: '',
  dev: '',
  mac: ''
})

const createDefaultState = () => ({
  version: 3,
  accounts: {},
  pools: {
    premium: createPoolState(),
    general: createPoolState()
  },
  runtime: {
    premium: createRuntimeState(),
    general: createRuntimeState()
  },
  sessions: {
    qrLogin: normalizeLoginSessions(),
    smsLogin: normalizeLoginSessions()
  }
})

const normalizePoolState = (value = {}) => ({
  ...createPoolState(),
  ...value
})

const normalizeState = (value = {}) => ({
  version: 3,
  accounts: value?.accounts || {},
  pools: {
    premium: normalizePoolState(value?.pools?.premium),
    general: normalizePoolState(value?.pools?.general)
  },
  runtime: {
    premium: {
      ...createRuntimeState(),
      ...(value?.runtime?.premium || {})
    },
    general: {
      ...createRuntimeState(),
      ...(value?.runtime?.general || {})
    }
  },
  sessions: {
    qrLogin: normalizeLoginSessions(value?.sessions?.qrLogin),
    smsLogin: normalizeLoginSessions(value?.sessions?.smsLogin)
  }
})

const persistState = async (state) => {
  const normalized = normalizeState(state)
  await mkdir(dirname(statePath), { recursive: true })
  const tempPath = `${statePath}.tmp`
  await writeFile(tempPath, JSON.stringify(normalized, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, statePath)
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
    if (error.code !== 'ENOENT') throw error
    cachedState = createDefaultState()
    return cachedState
  }
}

export function updateKugouAdminState (mutator) {
  const operation = pendingUpdate.then(async () => {
    const current = normalizeState(await readKugouAdminState())
    const draft = structuredClone(current)
    const next = await mutator(draft)
    return persistState(next || draft)
  })
  pendingUpdate = operation.catch(() => {})
  return operation
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

export async function getKugouRuntimeProfile (pool) {
  const state = await readKugouAdminState()
  return state.runtime?.[pool] || createRuntimeState()
}

export async function setKugouRuntimeProfile (pool, patch) {
  return updateKugouAdminState((state) => {
    state.runtime[pool] = {
      ...createRuntimeState(),
      ...(state.runtime?.[pool] || {}),
      ...(patch || {})
    }
    return state
  })
}

export async function getKugouAdminSession (key, pool) {
  const state = await readKugouAdminState()
  const sessions = state.sessions?.[key] || {}
  // Requests without a pool keep the old behavior: use the most recent session.
  const value = pool
    ? sessions[pool] || null
    : Object.values(sessions).filter(Boolean).sort((a, b) => Number(b.expiresAt) - Number(a.expiresAt))[0] || null

  if (!value?.expiresAt) return value
  if (Number(value.expiresAt) >= Date.now()) return value

  await setKugouAdminSession(key, null, value.pool)
  return null
}

export async function setKugouAdminSession (key, value, pool = value?.pool || 'premium') {
  return updateKugouAdminState((state) => {
    state.sessions[key][pool] = value || null
    return state
  })
}

export function getKugouAdminStatePath () {
  return statePath
}
