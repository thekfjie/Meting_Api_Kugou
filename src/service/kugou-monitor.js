import { getKugouAccountStatus } from '../utils/kugou-account-status.js'

const describePool = (pool, account, traffic) => {
  const currentMinute = traffic?.perMinute?.[pool] || 0
  const remainingMinute = traffic?.remainingPerMinute?.[pool] || 0
  const lastRequestAt = traffic?.lastRequestAt?.[pool] || null
  const exemptRequests = traffic?.exempt?.[pool] || 0
  const blockedRequests = traffic?.blocked?.[pool] || 0
  const routeName = mapPoolName(pool)
  const withTraffic = (payload) => ({
    ...payload,
    currentMinute,
    remainingMinute,
    lastRequestAt,
    exemptRequests,
    blockedRequests
  })

  if ((account.load?.maxPerMinute || 0) > 0 && remainingMinute <= 0) {
    return withTraffic({
      label: 'Minute exhausted',
      tone: 'warn',
      detail: `${routeName} 本分钟真实上游请求额度已用尽，新的未缓存解析会在下一分钟恢复。`
    })
  }

  if (pool === 'internal') {
    if (account.valid === false) {
      return withTraffic({
        label: 'Unavailable',
        tone: 'bad',
        detail: 'Internal 基础游客服务探活失败，当前匿名解析不可用。'
      })
    }

    if (account.vipState === 'preview') {
      return withTraffic({
        label: 'Preview only',
        tone: 'warn',
        detail: 'Internal 基础游客服务可用，但 VIP 探针当前只返回试听片段。'
      })
    }

    if (account.vipState === 'full') {
      return withTraffic({
        label: 'Full access',
        tone: 'good',
        detail: 'Internal 基础游客服务当前可返回完整播放链接。'
      })
    }

    if (account.vipState === 'blocked') {
      return withTraffic({
        label: 'Guest only',
        tone: 'warn',
        detail: 'Internal 基础游客服务可用，但 VIP 探针当前没有可用播放链接。'
      })
    }

    if (account.vipState === 'untested') {
      return withTraffic({
        label: 'Available',
        tone: 'good',
        detail: 'Internal 基础游客服务可用，当前未启用 VIP 探针。'
      })
    }
  }

  if (account.mode === 'anonymous') {
    return withTraffic({
      label: 'Unavailable',
      tone: 'warn',
      detail: `${routeName} 当前没有可用的专属账号，已退回公开通道。`
    })
  }

  if (account.valid === false) {
    return withTraffic({
      label: 'Unavailable',
      tone: 'bad',
      detail: `${routeName} 的基础探活未通过。`
    })
  }

  if (account.vipState === 'full') {
    return withTraffic({
      label: 'Full access',
      tone: 'good',
      detail: `${routeName} 的 VIP 探针当前可完整播放。`
    })
  }

  if (account.vipState === 'preview') {
    return withTraffic({
      label: 'Preview only',
      tone: 'warn',
      detail: `${routeName} 的 VIP 探针当前只返回试听片段。`
    })
  }

  if (account.vipState === 'blocked') {
    return withTraffic({
      label: 'Probe issue',
      tone: 'warn',
      detail: `${routeName} 的基础探活正常，但 VIP 探针歌曲没有返回可用播放链接。`
    })
  }

  if (account.vipState === 'untested') {
    return withTraffic({
      label: 'Available',
      tone: 'good',
      detail: `${routeName} 的基础探活正常，当前未启用 VIP 探针。`
    })
  }

  return withTraffic({
    label: 'Check needed',
    tone: 'warn',
    detail: mapVipReason(account.vipReason)
  })
}

const mapStatusReason = (reason) => {
  const map = {
    'missing-cookie': '未配置对应 Cookie',
    'missing-required-fields': 'Cookie 关键字段不完整',
    'songinfo-probe-failed': '基础探活失败',
    'upstream-basic-probe-failed': 'Upstream 基础探活失败',
    'anonymous-probe-failed': '匿名基础探活失败',
    'legacy-anonymous-meting': '原生 Meting 游客探活',
    ok: '状态正常',
    'anonymous-fallback': '匿名通道'
  }
  return map[reason] || reason || '未知状态'
}

const mapVipReason = (reason) => {
  const map = {
    'resolved-url-full': 'Resolved URL 指向完整播放链接',
    'resolved-url-preview': 'Resolved URL 指向试听片段',
    'resolved-url-direct': 'Resolved URL 返回可直连播放地址',
    'vip-hash-unset': '未设置 VIP 探针歌曲',
    'vip-probe-no-data': 'VIP 探针无返回',
    'vip-probe-no-url': 'VIP 探针未返回播放链接',
    'preview-only': 'VIP 探针只返回试听片段',
    'duration-match': '时长已命中全曲',
    'duration-preview': '时长判定为试听片段',
    'vip-probe-ambiguous': 'VIP 结果不明确',
    'not-tested': '尚未检测',
    ok: '状态正常'
  }
  return map[reason] || reason || '未知状态'
}

const mapVipState = (state) => {
  const map = {
    anonymous: 'Public access',
    blocked: 'No playable link',
    full: 'Full access',
    preview: 'Preview only',
    untested: 'Untested',
    unknown: 'Inconclusive',
    unreachable: 'No probe response'
  }
  return map[state] || state || '未知状态'
}

const mapBoolean = (value, yes, no, unknown = '未适用') => {
  if (value === null || value === undefined) return unknown
  return value ? yes : no
}

const formatLoad = (load) => {
  if (!load) return '-'
  const usage = load.usagePercent === null || load.usagePercent === undefined
    ? '-'
    : `${load.usagePercent}%`
  return `${load.currentPerMinute || 0}/${load.maxPerMinute || 0} (${usage})`
}

const buildDiagnostics = (pool, account) => {
  return {
    basicProbe: mapBoolean(account.valid, 'Pass', 'Fail', 'Untested'),
    routeEligible: mapBoolean(account.routeEligible, 'Yes', 'No', 'Unknown'),
    statusReason: mapStatusReason(account.statusReason),
    vipState: mapVipState(account.vipState),
    vipReason: mapVipReason(account.vipReason),
    load: formatLoad(account.load),
    pool: mapPoolName(pool)
  }
}

const mapPoolName = (pool) => {
  if (pool === 'premium') return 'Pro'
  if (pool === 'general') return 'Normal (CK)'
  if (pool === 'internal') return 'Internal (Guest)'
  return pool || 'Unknown'
}

export default async (c) => {
  const force = c.req.query('refresh') === '1'
  const data = await getKugouAccountStatus(force)
  const premiumAccount = data.accounts?.premium || {}
  const generalAccount = data.accounts?.general || {}
  const internalAccount = data.accounts?.internal || {}
  const pro = {
    ...describePool('premium', premiumAccount, data.traffic || {}),
    diagnostics: buildDiagnostics('premium', premiumAccount)
  }
  const normal = {
    ...describePool('general', generalAccount, data.traffic || {}),
    diagnostics: buildDiagnostics('general', generalAccount)
  }
  const internal = {
    ...describePool('internal', internalAccount, data.traffic || {}),
    diagnostics: buildDiagnostics('internal', internalAccount)
  }
  c.header('cache-control', 'no-store')

  return c.json({
    checkedAt: data.checkedAt,
    ttlSeconds: data.ttlSeconds,
    summary: {
      currentMinute: data.traffic?.perMinute?.total || 0,
      remainingMinute: data.traffic?.remainingPerMinute?.total || 0,
      startedAt: data.traffic?.startedAt || null,
      requests: {
        premium: data.traffic?.requests?.premium || 0,
        general: data.traffic?.requests?.general || 0,
        byKey: data.traffic?.requests?.byKey || 0,
        byReferrer: data.traffic?.requests?.byReferrer || 0,
        fallback: data.traffic?.requests?.fallback || 0
      },
      cache: {
        premiumHit: data.traffic?.cache?.premiumHit || 0,
        premiumMiss: data.traffic?.cache?.premiumMiss || 0,
        generalHit: data.traffic?.cache?.generalHit || 0,
        generalMiss: data.traffic?.cache?.generalMiss || 0
      },
      exempt: {
        premium: data.traffic?.exempt?.premium || 0,
        general: data.traffic?.exempt?.general || 0,
        blogPlaylist: data.traffic?.exempt?.blogPlaylist || 0,
        total: data.traffic?.exempt?.total || 0
      },
      blocked: {
        premium: data.traffic?.blocked?.premium || 0,
        general: data.traffic?.blocked?.general || 0,
        total: data.traffic?.blocked?.total || 0
      }
    },
    pools: {
      pro,
      normal,
      internal
    }
  })
}
