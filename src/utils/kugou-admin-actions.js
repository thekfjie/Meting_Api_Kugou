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
  refreshKugouLogin
} from './kugou-upstream-auth.js'
import { setKugouAdminPoolState } from './kugou-admin-state.js'
import { isKugouPoolLite, shouldAutoClaimKugouPool } from './kugou-upstream-runtime.js'
import {
  fetchKugouVipDetail,
  performKugouLiteVipClaim,
  performKugouLiteVipListen
} from './kugou-upstream-vip.js'

const KUGOU_POOLS = ['premium', 'general']

const nowIso = () => new Date().toISOString()
const normalizePool = pool => (pool === 'general' ? 'general' : 'premium')
const normalizeText = value => String(value || '').trim()

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
  if (!response?.body) return false
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

const persistPoolCookie = async ({ pool, activeCookie = '', cookieMap = {}, profile = null }) => {
  const baseCookie = await getPoolPersistBaseCookie(pool, activeCookie)
  const upstreamCookie = buildCookieUpdatePayload({
    existingCookie: activeCookie || baseCookie,
    cookieMap,
    profile
  })
  const nextCookie = normalizeKugouCookieForMeting({
    existingCookie: baseCookie,
    upstreamCookie
  })
  await writeCookiePool(pool, nextCookie)
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
    hasActiveVip
  }
}

export const syncKugouPoolProfile = async (pool, { record = true } = {}) => {
  const normalizedPool = normalizePool(pool)
  const at = nowIso()

  if (!hasKugouUpstreamAuth()) {
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
  const ok = Boolean(account.userId || account.vipType || account.expireTime)

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

  return {
    ok,
    pool: normalizedPool,
    at,
    profile,
    account
  }
}

export const applyKugouPoolCookieMap = async (pool, cookieMap = {}, { trigger = 'manual' } = {}) => {
  const normalizedPool = normalizePool(pool)
  const at = nowIso()
  const sourceInfo = await inspectCookieSource('kugou', normalizedPool)

  if (!cookieMap || Object.keys(cookieMap).length === 0) {
    const result = buildErrorResult({
      action: 'write',
      pool: normalizedPool,
      trigger,
      at,
      message: '没有可写入的登录态',
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
  await persistPoolCookie({
    pool: normalizedPool,
    activeCookie,
    cookieMap
  })

  const profileResult = await syncKugouPoolProfile(normalizedPool)

  await setKugouAdminPoolState(normalizedPool, {
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
}

export const refreshKugouPool = async (pool, { trigger = 'manual' } = {}) => {
  const normalizedPool = normalizePool(pool)
  const at = nowIso()
  const sourceInfo = await inspectCookieSource('kugou', normalizedPool)

  if (!hasKugouUpstreamAuth()) {
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
    const response = await refreshKugouLogin(activeCookie, normalizedPool)
    if (!isRefreshSuccess(response)) {
      throw new Error(extractMessage(response.body) || 'upstream 未返回新的登录态')
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
}

export const claimKugouLiteVip = async (pool, { trigger = 'manual' } = {}) => {
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

  if (!hasKugouUpstreamAuth()) {
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
}

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
