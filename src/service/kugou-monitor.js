import { getKugouAccountStatus } from '../utils/kugou-account-status.js'

const describePool = (pool, account, traffic) => {
  const currentMinute = traffic?.perMinute?.[pool] || 0
  const remainingMinute = traffic?.remainingPerMinute?.[pool] || 0
  const lastRequestAt = traffic?.lastRequestAt?.[pool] || null

  if (pool === 'general') {
    if (account.mode === 'anonymous') {
      return {
        label: '匿名可用',
        tone: 'warn',
        detail: '当前未配置普通池 Cookie，已回退到匿名通道',
        currentMinute,
        remainingMinute,
        lastRequestAt
      }
    }

    if (account.valid === false) {
      return {
        label: '普通池异常',
        tone: 'bad',
        detail: mapStatusReason(account.statusReason),
        currentMinute,
        remainingMinute,
        lastRequestAt
      }
    }

    if (account.valid === true) {
      const vipHint = account.vipState && !['anonymous', 'untested'].includes(account.vipState)
        ? `；VIP 探针结果：${mapVipState(account.vipState)}（仅作信息）`
        : ''

      return {
        label: '普通池可用',
        tone: 'good',
        detail: `基础探活正常，可继续承担非会员请求${vipHint}`,
        currentMinute,
        remainingMinute,
        lastRequestAt
      }
    }
  }

  if (account.mode === 'anonymous') {
    return {
      label: '匿名降级',
      tone: 'warn',
      detail: '未配置小号 Cookie，当前使用匿名通道',
      currentMinute,
      remainingMinute,
      lastRequestAt
    }
  }

  if (account.valid === false) {
    return {
      label: '状态异常',
      tone: 'bad',
      detail: mapStatusReason(account.statusReason),
      currentMinute,
      remainingMinute,
      lastRequestAt
    }
  }

  if (account.vipState === 'full') {
    return {
      label: '全曲可播',
      tone: 'good',
      detail: '付费探针当前可完整播放',
      currentMinute,
      remainingMinute,
      lastRequestAt
    }
  }

  if (account.vipState === 'preview') {
    return {
      label: '仅试听',
      tone: 'warn',
      detail: '付费探针当前只返回试听片段',
      currentMinute,
      remainingMinute,
      lastRequestAt
    }
  }

  if (account.vipState === 'blocked') {
    return {
      label: 'VIP 探针异常',
      tone: 'warn',
      detail: '基础探活正常，但 VIP 探针歌曲没有返回可用播放链接；更像是探针问题或歌曲本身限制，不等同于整个大号池失效',
      currentMinute,
      remainingMinute,
      lastRequestAt
    }
  }

  if (account.vipState === 'untested') {
    return {
      label: '未检测',
      tone: 'warn',
      detail: '尚未配置 VIP 探针歌曲',
      currentMinute,
      remainingMinute,
      lastRequestAt
    }
  }

  return {
    label: '待确认',
    tone: 'warn',
    detail: mapVipReason(account.vipReason),
    currentMinute,
    remainingMinute,
    lastRequestAt
  }
}

const mapStatusReason = (reason) => {
  const map = {
    'missing-cookie': '未配置对应 Cookie',
    'missing-required-fields': 'Cookie 关键字段不完整',
    'songinfo-probe-failed': '基础探活失败',
    ok: '状态正常',
    'anonymous-fallback': '匿名通道'
  }
  return map[reason] || reason || '未知状态'
}

const mapVipReason = (reason) => {
  const map = {
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
    anonymous: '匿名通道',
    blocked: '无可用链接',
    full: '全曲可播',
    preview: '仅试听',
    untested: '未检测',
    unknown: '结果不明确',
    unreachable: '探针无返回'
  }
  return map[state] || state || '未知状态'
}

const mapMode = (mode) => {
  const map = {
    anonymous: '匿名',
    cookie: 'Cookie'
  }
  return map[mode] || mode || '未知'
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
    mode: mapMode(account.mode),
    cookie: mapBoolean(account.configured, '已配置', '未配置'),
    requiredFields: account.mode === 'anonymous'
      ? '未适用'
      : mapBoolean(account.requiredFields, '完整', '不完整'),
    basicProbe: mapBoolean(account.valid, '通过', '失败', '未检测'),
    routeEligible: mapBoolean(account.routeEligible, '可参与', '不可参与', '未确定'),
    statusReason: mapStatusReason(account.statusReason),
    vipState: mapVipState(account.vipState),
    vipReason: mapVipReason(account.vipReason),
    load: formatLoad(account.load),
    pool: pool === 'premium' ? '大号池' : '小号池 / 普通池'
  }
}

export default async (c) => {
  const force = c.req.query('refresh') === '1'
  const data = await getKugouAccountStatus(force)
  const premiumAccount = data.accounts?.premium || {}
  const generalAccount = data.accounts?.general || {}
  c.header('cache-control', 'no-store')

  return c.json({
    checkedAt: data.checkedAt,
    ttlSeconds: data.ttlSeconds,
    auth: {
      premiumKeyConfigured: Boolean(data.auth?.premiumKeyConfigured),
      premiumByReferrerAllowed: Boolean(data.auth?.premiumByReferrerAllowed),
      allowHostsCount: Array.isArray(data.auth?.allowHosts) ? data.auth.allowHosts.length : 0
    },
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
      }
    },
    pools: {
      premium: {
        ...describePool('premium', premiumAccount, data.traffic || {}),
        diagnostics: buildDiagnostics('premium', premiumAccount)
      },
      general: {
        ...describePool('general', generalAccount, data.traffic || {}),
        diagnostics: buildDiagnostics('general', generalAccount)
      }
    }
  })
}
