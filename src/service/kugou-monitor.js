import { getKugouAccountStatus } from '../utils/kugou-account-status.js'

const describePool = (pool, account, traffic) => {
  const currentMinute = traffic?.perMinute?.[pool] || 0
  const remainingMinute = traffic?.remainingPerMinute?.[pool] || 0
  const lastRequestAt = traffic?.lastRequestAt?.[pool] || null

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
      label: '不可用',
      tone: 'bad',
      detail: '付费探针没有返回可用播放链接',
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

export default async (c) => {
  const force = c.req.query('refresh') === '1'
  const data = await getKugouAccountStatus(force)
  c.header('cache-control', 'no-store')

  return c.json({
    checkedAt: data.checkedAt,
    ttlSeconds: data.ttlSeconds,
    summary: {
      currentMinute: data.traffic?.perMinute?.total || 0,
      remainingMinute: data.traffic?.remainingPerMinute?.total || 0
    },
    pools: {
      premium: describePool('premium', data.accounts?.premium || {}, data.traffic || {}),
      general: describePool('general', data.accounts?.general || {}, data.traffic || {})
    }
  })
}
