import {
  normalizeKugouCookieForMeting,
  parseSimpleCookie,
  stringifyCookie,
  writeCookiePool
} from './admin.js'
import { buildNextClaimAt, buildNextRefreshAt } from './kugou-auto-schedule.js'
import { inspectCookieSource, readCookieFile, readCookiePoolFile } from './cookie.js'
import {
  fetchKugouLoginProfile,
  hasKugouUpstreamAuth,
  refreshKugouLogin,
  requestKugouUpstream,
  buildKugouUpstreamAuthCookie
} from './kugou-upstream-auth.js'
import { getKugouAdminPoolState, setKugouAdminPoolState, updateKugouAdminState } from './kugou-admin-state.js'
import { getKugouAccountId, getSavedKugouAccount, saveKugouAccount } from './kugou-accounts.js'
import { getKugouPoolPlatform, isKugouPoolLite, shouldAutoClaimKugouPool } from './kugou-upstream-runtime.js'
import { kugouAuthSummary, logKugouAuth } from './kugou-auth-log.js'
import { summarizeKugouMemberships } from './kugou-membership.js'
import {
  fetchKugouVipDetail,
  performKugouLiteVipClaim,
  performKugouLiteVipListen
} from './kugou-upstream-vip.js'

const KUGOU_POOLS = ['premium', 'general']

const nowIso = () => new Date().toISOString()
const normalizePool = pool => (pool === 'general' ? 'general' : 'premium')
const normalizeText = value => String(value || '').trim()
const poolOperations = new Map()
const withPoolOperation = (pool, action) => {
  const key = normalizePool(pool)
  const operation = (poolOperations.get(key) || Promise.resolve()).then(action)
  poolOperations.set(key, operation.catch(() => {}))
  return operation
}

const hasLoginCredentials = (cookieMap) => {
  return Boolean(cookieMap?.token && !['undefined', 'null'].includes(cookieMap.token) && /^[1-9]\d*$/.test(String(cookieMap.userid || '')))
}

const pickText = (...values) => {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) return normalized
  }
  return ''
}

const parseDateTime = value => {
  const normalized = normalizeText(value)
  if (!normalized) return 0

  const candidate = normalized.includes('T')
    ? normalized
    : normalized.replace(' ', 'T')
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate)
    ? candidate
    : `${candidate}+08:00`
  const parsed = Date.parse(withZone)
  return Number.isFinite(parsed) ? parsed : 0
}

const hasFutureExpire = value => parseDateTime(value) > Date.now()

const extractMessage = body => pickText(
  body?.msg,
  body?.message,
  body?.error,
  body?.err_msg,
  body?.error_msg,
  body?.statusText
)

const isRefreshSuccess = response => {
  if (!response?.body || !hasLoginCredentials(response.cookieMap)) return false
  if (response.body.status !== undefined && response.body.status !== null && response.body.status !== '') {
    return Number(response.body.status) === 1
  }
  return Object.keys(response.cookieMap || {}).length > 0
}

const pickPreferredBusiVip = (vipData = {}) => {
  const entries = Array.isArray(vipData?.busi_vip) ? vipData.busi_vip : []
  if (!entries.length) return null

  return entries
    .map(item => {
      const expiresAt = Math.max(
        parseDateTime(item?.vip_end_time),
        parseDateTime(item?.vip_clearday)
      )

      return {
        item,
        expiresAt,
        active: Number(item?.is_vip || 0) > 0 || expiresAt > Date.now(),
        concept: normalizeText(item?.busi_type).toLowerCase() === 'concept'
      }
    })
    .sort((left, right) => {
      if (Number(right.active) !== Number(left.active)) return Number(right.active) - Number(left.active)
      if (Number(right.concept) !== Number(left.concept)) return Number(right.concept) - Number(left.concept)
      return right.expiresAt - left.expiresAt
    })[0]?.item || null
}

const hasVip = (account = null) => {
  if (!account) return false
  if (typeof account.hasActiveVip === 'boolean') return account.hasActiveVip
  if (hasFutureExpire(account.expireTime)) return true

  const vipTypeText = normalizeText(account.vipType).toLowerCase()
  if (!vipTypeText) return false

  const vipType = Number(vipTypeText)
  if (Number.isFinite(vipType)) return vipType > 0

  return ['vip', 'svip', 'tvip', 'concept', 'lite'].some(keyword => vipTypeText.includes(keyword))
}

const buildErrorResult = ({ action, pool, trigger, at, message, sourceInfo }) => ({
  ok: false,
  action,
  pool,
  trigger,
  at,
  message,
  source: sourceInfo?.source || 'none',
  activeKey: sourceInfo?.activeKey || ''
})

const summarizeStep = step => {
  if (!step) return null
  return {
    ok: Boolean(step.ok),
    message: step.message || '',
    body: step.body || null
  }
}

const buildCookieUpdatePayload = ({ existingCookie = '', cookieMap = {}, profile = null }) => {
  const mergedMap = { ...cookieMap }
  const account = summarizeKugouProfile(profile)
  const current = parseSimpleCookie(existingCookie)

  if (account.userId) mergedMap.userid = account.userId
  if (account.cookieVipType) mergedMap.vip_type = account.cookieVipType
  if (account.vipToken) mergedMap.vip_token = account.vipToken

  if (!mergedMap.token && current.t) mergedMap.token = current.t
  if (!mergedMap.userid && current.KugooID) mergedMap.userid = current.KugooID
  if (!mergedMap.dfid && (current.dfid || current.kg_dfid)) mergedMap.dfid = current.dfid || current.kg_dfid
  if (!mergedMap.KUGOU_API_MID && (current.KUGOU_API_MID || current.mid || current.kg_mid || current.kg_mid_temp)) {
    mergedMap.KUGOU_API_MID = current.KUGOU_API_MID || current.mid || current.kg_mid || current.kg_mid_temp
  }
  if (!mergedMap.KUGOU_API_GUID && current.KUGOU_API_GUID) mergedMap.KUGOU_API_GUID = current.KUGOU_API_GUID
  if (!mergedMap.KUGOU_API_DEV && current.KUGOU_API_DEV) mergedMap.KUGOU_API_DEV = current.KUGOU_API_DEV
  if (!mergedMap.KUGOU_API_MAC && current.KUGOU_API_MAC) mergedMap.KUGOU_API_MAC = current.KUGOU_API_MAC
  if (!mergedMap.KUGOU_API_PLATFORM && current.KUGOU_API_PLATFORM) mergedMap.KUGOU_API_PLATFORM = current.KUGOU_API_PLATFORM

  return stringifyCookie(mergedMap)
}

const getPoolPersistBaseCookie = async (pool, activeCookie = '') => {
  const fileCookie = await readCookiePoolFile('kugou', pool)
  return fileCookie || activeCookie || ''
}

const persistPoolCookie = async ({ pool, activeCookie = '', cookieMap = {}, profile = null, replace = false }) => {
  const baseCookie = replace ? '' : await getPoolPersistBaseCookie(pool, activeCookie)
  const upstreamCookie = buildCookieUpdatePayload({
    existingCookie: replace ? '' : activeCookie || baseCookie,
    cookieMap,
    profile
  })
  const nextCookie = normalizeKugouCookieForMeting({
    existingCookie: baseCookie,
    upstreamCookie
  })
  await writeCookiePool(pool, nextCookie)
  logKugouAuth(pool, 'persist', { before: kugouAuthSummary(activeCookie), after: kugouAuthSummary(nextCookie) })
  return nextCookie
}

const buildClaimSchedulePatch = pool => (
  shouldAutoClaimKugouPool(pool)
    ? { nextClaimAt: buildNextClaimAt() }
    : { nextClaimAt: '' }
)

export const getKugouPoolLabel = pool => {
  if (pool === 'premium') return '专业池'
  if (pool === 'general') return '普通池'
  return pool
}

export const summarizeKugouProfile = (profile = null) => {
  const detailData = profile?.detail?.data || {}
  const vipData = profile?.vip?.data || {}
  const preferredBusiVip = pickPreferredBusiVip(vipData)
  const topLevelExpire = pickText(vipData.expire_time, vipData.vip_end_time, vipData.expire)
  const busiExpire = pickText(preferredBusiVip?.vip_end_time, preferredBusiVip?.vip_clearday)
  const displayVipType = preferredBusiVip
    ? [normalizeText(preferredBusiVip?.busi_type), normalizeText(preferredBusiVip?.product_type)].filter(Boolean).join('/')
    : ''
  const cookieVipType = pickText(vipData.vip_type, vipData.type)
  const hasActiveVip = hasFutureExpire(busiExpire) ||
    hasFutureExpire(topLevelExpire) ||
    Boolean(Number(vipData.is_vip || 0)) ||
    Boolean(Number(preferredBusiVip?.is_vip || 0)) ||
    (() => {
      const numericVipType = Number(cookieVipType)
      return Number.isFinite(numericVipType) && numericVipType > 0
    })()

  return {
    userId: pickText(detailData.userid, detailData.user_id, vipData.userid),
    nickname: pickText(detailData.nickname, detailData.uname),
    vipType: displayVipType || cookieVipType,
    cookieVipType,
    vipLevel: pickText(vipData.vip_level, vipData.level, vipData.svip_level),
    expireTime: hasFutureExpire(busiExpire) ? busiExpire : pickText(topLevelExpire, busiExpire),
    vipToken: pickText(vipData.vip_token, detailData.vip_token),
    vipMode: pickText(preferredBusiVip?.busi_type, preferredBusiVip?.product_type),
    hasActiveVip,
    memberships: summarizeKugouMemberships(vipData)
  }
}

export const syncKugouPoolProfile = async (pool, { record = true } = {}) => {
  const normalizedPool = normalizePool(pool)
  const at = nowIso()

  if (!hasKugouUpstreamAuth(normalizedPool)) {
    return {
      ok: false,
      skipped: true,
      pool: normalizedPool,
      at,
      message: '未配置 Kugou upstream'
    }
  }

  const cookie = await readCookieFile('kugou', normalizedPool)
  if (!cookie) {
    return {
      ok: false,
      skipped: true,
      pool: normalizedPool,
      at,
      message: '当前池没有可用 Cookie'
    }
  }

  const profile = await fetchKugouLoginProfile(cookie, normalizedPool)
  const account = summarizeKugouProfile(profile)
  account.userId = account.userId || parseSimpleCookie(cookie).KugooID || ''
  const ok = Number(profile?.detail?.status) === 1 && Boolean(account.nickname || account.vipType || account.expireTime)

  if (record) {
    await setKugouAdminPoolState(normalizedPool, {
      lastProfileAt: at,
      account,
      lastError: ok
        ? null
        : {
            action: 'profile',
            at,
            message: '拉取账号资料失败'
          }
    })
  }

  if (ok) await saveKugouAccount(cookie, getKugouPoolPlatform(normalizedPool), account)
  return { ok, pool: normalizedPool, at, profile, account }
}

export const applyKugouPoolCookieMap = (pool, cookieMap = {}, { trigger = 'manual', activate = true } = {}) => withPoolOperation(pool, async () => {
  const normalizedPool = normalizePool(pool)
  const at = nowIso()
  const sourceInfo = await inspectCookieSource('kugou', normalizedPool)

  if (!hasLoginCredentials(cookieMap) || (cookieMap.KUGOU_API_PLATFORM && cookieMap.KUGOU_API_PLATFORM !== getKugouPoolPlatform(normalizedPool))) {
    logKugouAuth(normalizedPool, 'write-rejected', { trigger, auth: kugouAuthSummary(stringifyCookie(cookieMap || {})) })
    const result = buildErrorResult({
      action: 'write',
      pool: normalizedPool,
      trigger,
      at,
      message: '登录未成功或版本不匹配，保留原有登录态，请在对应版本重新登录',
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastError: {
        action: 'write',
        at,
        message: result.message
      }
    })

    return result
  }

  const activeCookie = await readCookieFile('kugou', normalizedPool)
  if (!activate) {
    const cookie = normalizeKugouCookieForMeting({ upstreamCookie: stringifyCookie({ ...cookieMap, KUGOU_API_PLATFORM: getKugouPoolPlatform(normalizedPool) }) })
    await saveKugouAccount(cookie, getKugouPoolPlatform(normalizedPool))
    try {
      const profile = summarizeKugouProfile(await fetchKugouLoginProfile(cookie, normalizedPool))
      await saveKugouAccount(cookie, getKugouPoolPlatform(normalizedPool), profile)
    } catch {}
    return { ok: true, pool: normalizedPool, action: 'save', message: '登录态已保存为备用，当前池账号未更换' }
  }
  if (activeCookie) {
    const previous = await getKugouAdminPoolState(normalizedPool)
    await saveKugouAccount(activeCookie, getKugouPoolPlatform(normalizedPool), previous.account, previous.sessionStatus)
  }
  await persistPoolCookie({
    pool: normalizedPool,
    activeCookie,
    cookieMap: { ...cookieMap, KUGOU_API_PLATFORM: getKugouPoolPlatform(normalizedPool) },
    replace: true
  })

  const profileResult = await syncKugouPoolProfile(normalizedPool)

  await setKugouAdminPoolState(normalizedPool, {
    sessionStatus: null,
    nextRefreshAt: buildNextRefreshAt(),
    ...buildClaimSchedulePatch(normalizedPool),
    ...(profileResult.account ? { lastProfileAt: profileResult.at, account: profileResult.account } : {}),
    lastError: null
  })

  return {
    ok: true,
    pool: normalizedPool,
    action: 'write',
    trigger,
    at,
    message: `${getKugouPoolLabel(normalizedPool)}已写入新的登录态`,
    source: sourceInfo.source,
    activeKey: sourceInfo.activeKey,
    account: profileResult.account || null
  }
})

export const activateKugouAccount = (pool, id) => withPoolOperation(pool, async () => {
  const platform = getKugouPoolPlatform(pool)
  const saved = await getSavedKugouAccount(id)
  if (!saved || saved.platform !== platform) return { ok: false, message: '账号版本与目标池不匹配' }
  if ((await inspectCookieSource('kugou', pool)).source === 'env') return { ok: false, message: '当前池由环境变量管理，请先移除 Cookie 覆盖后再切换' }
  let profile
  try {
    const response = await fetchKugouLoginProfile(saved.cookie, pool)
    if (Number(response?.detail?.status) !== 1) return { ok: false, message: '备用账号登录已失效，请重新登录；当前池账号已保留' }
    profile = summarizeKugouProfile(response)
    profile.userId = profile.userId || saved.userId
  } catch {
    return { ok: false, message: '暂时无法验证备用账号，当前池未切换，请稍后重试' }
  }
  const current = await readCookieFile('kugou', pool)
  const state = await getKugouAdminPoolState(pool)
  if (current) await saveKugouAccount(current, platform, state.account, state.sessionStatus)
  await writeCookiePool(pool, saved.cookie)
  await setKugouAdminPoolState(pool, {
    account: profile,
    sessionStatus: saved.sessionStatus || null,
    lastRefreshAt: '',
    lastRefreshResult: null,
    lastClaimAt: '',
    lastClaimResult: null,
    lastProfileAt: '',
    nextRefreshAt: buildNextRefreshAt(),
    ...buildClaimSchedulePatch(pool),
    lastError: null
  })
  await saveKugouAccount(saved.cookie, platform, profile, saved.sessionStatus)
  return { ok: true, pool, message: '当前账号已切换，原账号已保留在账号列表中' }
})

export const checkKugouPoolSession = pool => withPoolOperation(pool, async () => {
  const cookie = await readCookieFile('kugou', pool)
  const auth = kugouAuthSummary(cookie)
  const result = { status: 'unknown', checkedAt: nowIso(), token: auth.token }
  if (!cookie) result.status = 'missing'
  else {
    try {
      const check = async path => {
        const r = await requestKugouUpstream(path, { pool, cookie: buildKugouUpstreamAuthCookie({ cookie }), query: { timestamp: Date.now() } })
        return { http: r?.status, status: r?.body?.status, errorCode: r?.body?.error_code ?? 0 }
      }
      result.profile = await check('/user/detail')
      result.device = await check('/login/device')
      const checks = [result.profile, result.device]
      const valid = checks.every(r => r.http === 200 && Number(r.status) === 1 && Number(r.errorCode) === 0)
      const rejected = checks.some(r => [401, 403].includes(r.http) || (r.http === 200 && (Number(r.status) !== 1 || Number(r.errorCode) !== 0)))
      result.status = valid ? 'valid' : rejected ? 'invalid' : 'unknown'
    } catch (error) { result.error = error.code || 'NETWORK_ERROR' }
  }
  await setKugouAdminPoolState(pool, { sessionStatus: result })
  const state = await getKugouAdminPoolState(pool)
  if (cookie) await saveKugouAccount(cookie, getKugouPoolPlatform(pool), state.account, result)
  return { ok: result.status === 'valid', pool, sessionStatus: result, message: result.status === 'valid' ? '登录状态有效' : result.status === 'invalid' ? '登录校验未通过，请重新登录' : '暂时无法确认登录状态，请稍后重试' }
})

// Additional accounts keep their own credentials and schedules, without moving
// them through the default pool file just to refresh or claim membership.
export const runKugouAccountAction = async (id, action) => {
  const saved = await getSavedKugouAccount(id)
  const pool = KUGOU_POOLS.find(pool => getKugouPoolPlatform(pool) === saved?.platform)
  if (!saved || !pool || !['check', 'refresh', 'claim'].includes(action)) return { ok: false, message: '账号或操作不存在' }
  if (action === 'claim' && saved.platform !== 'lite') return { ok: false, message: '普通版不支持 Lite 领取' }
  return withPoolOperation(pool, async () => {
    const account = await getSavedKugouAccount(id)
    let cookie = account.cookie
    let profile = account.profile
    const at = nowIso()
    const patch = {}
    let ok = false
    let message = ''
    const persist = async () => {
      await saveKugouAccount(cookie, account.platform, profile)
      if (getKugouAccountId(await readCookieFile('kugou', pool), account.platform) === id) {
        await writeCookiePool(pool, cookie)
        await setKugouAdminPoolState(pool, { account: profile })
      }
    }
    try {
      if (action === 'check') {
        const checks = []
        for (const path of ['/user/detail', '/login/device']) {
          const response = await requestKugouUpstream(path, { pool, cookie: buildKugouUpstreamAuthCookie({ cookie }), query: { timestamp: Date.now() } })
          checks.push({ http: response?.status, status: response?.body?.status, errorCode: response?.body?.error_code ?? 0 })
        }
        ok = checks.every(r => r.http === 200 && Number(r.status) === 1 && Number(r.errorCode) === 0)
        const rejected = checks.some(r => [401, 403].includes(r.http) || (r.http === 200 && (Number(r.status) !== 1 || Number(r.errorCode) !== 0)))
        const status = { status: ok ? 'valid' : rejected ? 'invalid' : 'unknown', checkedAt: at, token: kugouAuthSummary(cookie).token, profile: checks[0], device: checks[1] }
        await saveKugouAccount(cookie, account.platform, profile, status)
        if (getKugouAccountId(await readCookieFile('kugou', pool), account.platform) === id) await setKugouAdminPoolState(pool, { sessionStatus: status })
        message = ok ? '登录有效' : '登录校验未通过'
      } else if (action === 'refresh') {
        const response = await refreshKugouLogin(cookie, pool)
        if (!isRefreshSuccess(response) || String(response.cookieMap.userid) !== account.userId) throw new Error('刷新未返回该账号的有效登录态')
        cookie = normalizeKugouCookieForMeting({ existingCookie: cookie, upstreamCookie: buildCookieUpdatePayload({ existingCookie: cookie, cookieMap: response.cookieMap }) })
        await persist()
        try {
          const updated = await fetchKugouLoginProfile(cookie, pool)
          if (Number(updated.detail?.status) === 1) { profile = summarizeKugouProfile(updated); profile.userId = account.userId; await persist() }
        } catch {}
        ok = true
        message = '登录态已刷新'
      } else {
        const before = await fetchKugouLoginProfile(cookie, pool)
        const listen = await performKugouLiteVipListen(cookie, pool)
        const working = normalizeKugouCookieForMeting({ existingCookie: cookie, upstreamCookie: stringifyCookie(listen.cookieMap || {}) })
        const claim = await performKugouLiteVipClaim(working, pool)
        const merged = { ...(listen.cookieMap || {}), ...(claim.cookieMap || {}) }
        const detail = await fetchKugouVipDetail(normalizeKugouCookieForMeting({ existingCookie: working, upstreamCookie: stringifyCookie(merged) }), pool)
        const response = { detail: before.detail, vip: detail.body }
        cookie = normalizeKugouCookieForMeting({ existingCookie: cookie, upstreamCookie: buildCookieUpdatePayload({ existingCookie: cookie, cookieMap: merged, profile: response }) })
        profile = summarizeKugouProfile(response)
        profile.userId = account.userId
        await persist()
        ok = hasVip(profile) || (listen.ok && claim.ok)
        message = ok ? 'Lite 领取已完成' : claim.message || listen.message || '领取未成功'
      }
    } catch (error) { message = error.message || '操作失败' }
    if (action !== 'check') {
      const name = action === 'refresh' ? 'Refresh' : 'Claim'
      patch[`last${name}At`] = at
      patch[`last${name}Result`] = { ok, message, at }
      patch[`next${name}At`] = action === 'refresh' ? buildNextRefreshAt({ retry: !ok }) : buildNextClaimAt()
      await updateKugouAdminState(state => { state.accounts[id].maintenance = { ...state.accounts[id].maintenance, ...patch } })
      if (getKugouAccountId(await readCookieFile('kugou', pool), account.platform) === id) await setKugouAdminPoolState(pool, patch)
    }
    return { ok, message, id, action }
  })
}

export const refreshKugouPool = (pool, { trigger = 'manual' } = {}) => withPoolOperation(pool, async () => {
  const normalizedPool = normalizePool(pool)
  const at = nowIso()
  const sourceInfo = await inspectCookieSource('kugou', normalizedPool)

  if (!hasKugouUpstreamAuth(normalizedPool)) {
    const result = buildErrorResult({
      action: 'refresh',
      pool: normalizedPool,
      trigger,
      at,
      message: '未配置 Kugou upstream，无法刷新登录态',
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastRefreshAt: at,
      nextRefreshAt: '',
      lastRefreshResult: result,
      lastError: {
        action: 'refresh',
        at,
        message: result.message
      }
    })

    return result
  }

  const activeCookie = await readCookieFile('kugou', normalizedPool)
  if (!activeCookie) {
    const result = buildErrorResult({
      action: 'refresh',
      pool: normalizedPool,
      trigger,
      at,
      message: '当前池没有可刷新的 Cookie',
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastRefreshAt: at,
      nextRefreshAt: '',
      lastRefreshResult: result,
      lastError: {
        action: 'refresh',
        at,
        message: result.message
      }
    })

    return result
  }

  try {
    const current = parseSimpleCookie(activeCookie)
    if (current.KUGOU_API_PLATFORM && current.KUGOU_API_PLATFORM !== getKugouPoolPlatform(normalizedPool)) {
      throw new Error('Cookie 与池版本不匹配，请在对应版本重新登录')
    }
    const response = await refreshKugouLogin(activeCookie, normalizedPool)
    if (!isRefreshSuccess(response)) {
      throw new Error(extractMessage(response.body) || 'upstream 未返回新的登录态')
    }
    if (String(response.cookieMap.userid) !== String(current.KugooID)) {
      throw new Error('刷新返回的账号与当前池不一致，已保留原有登录态')
    }

    await persistPoolCookie({
      pool: normalizedPool,
      activeCookie,
      cookieMap: response.cookieMap
    })

    const profileResult = await syncKugouPoolProfile(normalizedPool)
    const result = {
      ok: true,
      pool: normalizedPool,
      action: 'refresh',
      trigger,
      at,
      message: `${getKugouPoolLabel(normalizedPool)}登录态已刷新`,
      source: sourceInfo.source,
      activeKey: sourceInfo.activeKey,
      upstream: {
        status: response.body?.status ?? null,
        message: extractMessage(response.body)
      },
      account: profileResult.account || null
    }

    await setKugouAdminPoolState(normalizedPool, {
      lastRefreshAt: at,
      nextRefreshAt: buildNextRefreshAt(),
      lastRefreshResult: result,
      ...(profileResult.account ? { lastProfileAt: profileResult.at, account: profileResult.account } : {}),
      lastError: null
    })

    return result
  } catch (error) {
    logKugouAuth(normalizedPool, 'refresh-failed', { trigger, auth: kugouAuthSummary(activeCookie) })
    const result = buildErrorResult({
      action: 'refresh',
      pool: normalizedPool,
      trigger,
      at,
      message: error.message || '刷新登录态失败',
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastRefreshAt: at,
      nextRefreshAt: buildNextRefreshAt({ retry: true }),
      lastRefreshResult: result,
      lastError: {
        action: 'refresh',
        at,
        message: result.message
      }
    })

    return result
  }
})

export const claimKugouLiteVip = (pool, { trigger = 'manual' } = {}) => withPoolOperation(pool, async () => {
  const normalizedPool = normalizePool(pool)
  const at = nowIso()
  const sourceInfo = await inspectCookieSource('kugou', normalizedPool)

  if (!isKugouPoolLite(normalizedPool)) {
    const result = buildErrorResult({
      action: 'claim',
      pool: normalizedPool,
      trigger,
      at,
      message: `${getKugouPoolLabel(normalizedPool)}当前是 default (regular) 平台，未启用 Lite 领取`,
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastClaimAt: at,
      ...buildClaimSchedulePatch(normalizedPool),
      lastClaimResult: result,
      lastError: {
        action: 'claim',
        at,
        message: result.message
      }
    })

    return result
  }

  if (!hasKugouUpstreamAuth(normalizedPool)) {
    const result = buildErrorResult({
      action: 'claim',
      pool: normalizedPool,
      trigger,
      at,
      message: '未配置 Kugou upstream，无法领取概念版会员',
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastClaimAt: at,
      ...buildClaimSchedulePatch(normalizedPool),
      lastClaimResult: result,
      lastError: {
        action: 'claim',
        at,
        message: result.message
      }
    })

    return result
  }

  const activeCookie = await readCookieFile('kugou', normalizedPool)
  if (!activeCookie) {
    const result = buildErrorResult({
      action: 'claim',
      pool: normalizedPool,
      trigger,
      at,
      message: '当前池没有可领取的 Cookie',
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastClaimAt: at,
      ...buildClaimSchedulePatch(normalizedPool),
      lastClaimResult: result,
      lastError: {
        action: 'claim',
        at,
        message: result.message
      }
    })

    return result
  }

  try {
    const beforeProfile = await fetchKugouLoginProfile(activeCookie, normalizedPool)
    const beforeAccount = summarizeKugouProfile(beforeProfile)

    const listenStep = await performKugouLiteVipListen(activeCookie, normalizedPool)
    const workingCookie = normalizeKugouCookieForMeting({
      existingCookie: activeCookie,
      upstreamCookie: stringifyCookie(listenStep.cookieMap || {})
    })
    const claimStep = await performKugouLiteVipClaim(workingCookie, normalizedPool)

    const mergedCookieMap = {
      ...(listenStep.cookieMap || {}),
      ...(claimStep.cookieMap || {})
    }

    const vipDetail = await fetchKugouVipDetail(normalizeKugouCookieForMeting({
      existingCookie: activeCookie,
      upstreamCookie: stringifyCookie(mergedCookieMap)
    }), normalizedPool)

    await persistPoolCookie({
      pool: normalizedPool,
      activeCookie,
      cookieMap: mergedCookieMap,
      profile: {
        detail: beforeProfile?.detail || null,
        vip: vipDetail.body || null
      }
    })

    const profileResult = await syncKugouPoolProfile(normalizedPool)
    const afterAccount = profileResult.account || summarizeKugouProfile({
      detail: beforeProfile?.detail || null,
      vip: vipDetail.body || null
    })
    const ok = hasVip(afterAccount) || (listenStep.ok && claimStep.ok)

    let message = `${getKugouPoolLabel(normalizedPool)}已执行 Lite 领取流程`
    if (ok && !hasVip(beforeAccount) && hasVip(afterAccount)) {
      message = `${getKugouPoolLabel(normalizedPool)}已更新为可用 VIP 状态`
    } else if (!ok) {
      message = claimStep.message || listenStep.message || 'Lite 领取流程未成功，请检查上游返回'
    }

    const result = {
      ok,
      pool: normalizedPool,
      action: 'claim',
      trigger,
      at,
      message,
      source: sourceInfo.source,
      activeKey: sourceInfo.activeKey,
      before: beforeAccount,
      after: afterAccount,
      steps: {
        listenSong: summarizeStep(listenStep),
        claimVip: summarizeStep(claimStep),
        vipDetail: summarizeStep(vipDetail)
      }
    }

    await setKugouAdminPoolState(normalizedPool, {
      lastClaimAt: at,
      ...buildClaimSchedulePatch(normalizedPool),
      lastClaimResult: result,
      ...(afterAccount ? { lastProfileAt: profileResult.at, account: afterAccount } : {}),
      lastError: ok
        ? null
        : {
            action: 'claim',
            at,
            message
          }
    })

    return result
  } catch (error) {
    const result = buildErrorResult({
      action: 'claim',
      pool: normalizedPool,
      trigger,
      at,
      message: error.message || '领取概念版会员失败',
      sourceInfo
    })

    await setKugouAdminPoolState(normalizedPool, {
      lastClaimAt: at,
      ...buildClaimSchedulePatch(normalizedPool),
      lastClaimResult: result,
      lastError: {
        action: 'claim',
        at,
        message: result.message
      }
    })

    return result
  }
})

export const claimAllKugouLiteVip = async ({ trigger = 'manual' } = {}) => {
  const at = nowIso()
  const results = []
  const pools = KUGOU_POOLS.filter(pool => isKugouPoolLite(pool))

  if (!pools.length) {
    return {
      ok: false,
      action: 'claim-all',
      at,
      message: '当前没有启用 Lite 池，未执行批量领取',
      results
    }
  }

  for (const pool of pools) {
    results.push(await claimKugouLiteVip(pool, { trigger }))
  }

  const successCount = results.filter(item => item.ok).length

  return {
    ok: successCount === results.length,
    action: 'claim-all',
    at,
    message: successCount === results.length
      ? '全部池的 Lite 领取流程已完成'
      : `已完成 ${successCount}/${results.length} 个池的 Lite 领取流程`,
    results
  }
}
