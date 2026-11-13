import config from '../config.js'
import { readCookieFile } from './cookie.js'
import { getKugouAccountId } from './kugou-accounts.js'
import { readKugouAdminState, updateKugouAdminState } from './kugou-admin-state.js'
import { getKugouPoolPlatform } from './kugou-upstream-runtime.js'
import { kugouAuthSummary } from './kugou-auth-log.js'

const pools = ['premium', 'general']
let bucket = -1
let sequence = 0
const usage = new Map()
const currentUsage = () => {
  const next = Math.floor(Date.now() / 60000)
  if (next !== bucket) { usage.clear(); bucket = next }
  return usage
}

// Request selection never changes a pool file or another request's credentials.
const candidates = async () => {
  const state = await readKugouAdminState()
  const records = new Map(Object.values(state.accounts).map(a => [a.id, { ...a }]))
  for (const pool of pools) {
    const cookie = await readCookieFile('kugou', pool)
    const id = getKugouAccountId(cookie, getKugouPoolPlatform(pool))
    if (id) records.set(id, { ...records.get(id), id, cookie, platform: id.split(':')[0], userId: id.split(':')[1] })
  }
  return [...records.values()].map(account => ({
    ...account,
    pool: pools.find(pool => getKugouPoolPlatform(pool) === account.platform)
  })).filter(a => a.pool && getKugouAccountId(a.cookie, a.platform) === a.id)
}

const accountLimit = (account, settings) => {
  return Number(settings.limits[account.id] ?? config.meting.kugou.status.maxRpm[account.pool] ?? 0)
}

export const getKugouDispatchSnapshot = async () => {
  const accounts = await candidates()
  const { dispatch: settings } = await readKugouAdminState()
  const counters = currentUsage()
  return {
    ...settings,
    configured: accounts.length > 0,
    accounts: accounts.map(a => {
      const used = counters.get(a.id)?.count || 0
      const limit = accountLimit(a, settings)
      return { id: a.id, userId: a.userId, pool: a.pool, enabled: !settings.disabled.includes(a.id), used, limit, remaining: limit > 0 ? Math.max(0, limit - used) : null }
    })
  }
}

export const saveKugouDispatchPolicy = async ({ mode, preferredUserId = '' }) => {
  if (!['balanced', 'priority'].includes(mode)) return { ok: false, message: '请选择调度策略' }
  const accounts = await candidates()
  if (mode === 'priority' && !accounts.some(a => a.userId === preferredUserId)) return { ok: false, message: '请选择已登录的优先账号' }
  await updateKugouAdminState(state => { state.dispatch.mode = mode; state.dispatch.preferredUserId = preferredUserId })
  return { ok: true, message: '调度策略已保存' }
}

export const setKugouAccountLimit = async (id, value) => {
  const limit = Number(value)
  if (!String(value).trim() || !Number.isSafeInteger(limit) || limit < 0 || limit > 100000) return { ok: false, message: '每分钟上限须为 0–100000 的整数，0 表示不限' }
  if (!(await candidates()).some(a => a.id === id)) return { ok: false, message: '账号不存在' }
  await updateKugouAdminState(state => { state.dispatch.limits[id] = limit })
  return { ok: true, message: '账号限额已保存' }
}

export const setKugouAccountEnabled = async (id, enabled) => {
  if (!(await candidates()).some(a => a.id === id)) return { ok: false, message: '账号不存在' }
  await updateKugouAdminState(state => {
    state.dispatch.disabled = state.dispatch.disabled.filter(value => value !== id)
    if (!enabled) state.dispatch.disabled.push(id)
  })
  return { ok: true, message: enabled ? '已参与调度' : '已暂停调度' }
}

export const selectKugouAccount = async (pool, { exclude = [], consume = true } = {}) => {
  const accounts = (await candidates()).filter(a => a.platform === getKugouPoolPlatform(pool)).map(a => ({ ...a, pool }))
  const { dispatch: settings } = await readKugouAdminState()
  const valid = accounts.filter(a => !exclude.includes(a.id) && !settings.disabled.includes(a.id) && !(a.sessionStatus?.status === 'invalid' && a.sessionStatus.token === kugouAuthSummary(a.cookie).token))
  // No awaits after this point: checking and reserving quota is atomic in Node.
  const counters = currentUsage()
  const available = valid.map(account => ({
    account, limit: accountLimit(account, settings), count: 0, last: 0, ...counters.get(account.id)
  })).filter(a => !consume || a.limit <= 0 || a.count < a.limit)
  available.sort((a, b) => {
    if (settings.mode === 'priority') {
      const preferred = Number(b.account.userId === settings.preferredUserId) - Number(a.account.userId === settings.preferredUserId)
      if (preferred) return preferred
    }
    return a.count - b.count || a.last - b.last || a.account.id.localeCompare(b.account.id)
  })
  const selected = available[0]
  if (!selected) return { configured: accounts.length > 0, exhausted: true }
  counters.set(selected.account.id, { count: selected.count + (consume ? 1 : 0), last: ++sequence })
  return { configured: true, ...selected.account }
}
