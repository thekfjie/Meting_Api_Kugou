const text = value => String(value ?? '').trim()

export const parseKugouVipTime = value => {
  const valueText = text(value)
  if (!valueText || valueText.startsWith('0000-')) return 0
  const candidate = valueText.replace(' ', 'T')
  const timestamp = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate) ? candidate : `${candidate}+08:00`)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export const getKugouVipDay = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10)

// Concept products are separate from the regular client's VIP/Super VIP.
export const summarizeKugouMemberships = (data = {}, now = Date.now()) => {
  const memberships = new Map()
  const add = (id, name, expires, flag) => {
    const expiresAt = parseKugouVipTime(expires)
    const item = {
      id,
      name,
      expireTime: expiresAt ? text(expires) : '',
      status: expiresAt ? (expiresAt > now ? 'active' : 'expired') : Number(flag) > 0 ? 'active' : 'unknown'
    }
    const previous = memberships.get(id)
    if (!previous || expiresAt > parseKugouVipTime(previous.expireTime)) memberships.set(id, item)
  }
  for (const item of Array.isArray(data.busi_vip) ? data.busi_vip : []) {
    const business = text(item?.busi_type)
    const product = text(item?.product_type)
    if (!business || !product) continue
    add(`${business}/${product}`, business === 'concept' ? `概念 ${product.toUpperCase()}` : `${business}/${product}`, item.vip_end_time, item.is_vip)
  }
  const ordinaryExpire = data.vip_end_time || data.expire_time || data.expire
  if (parseKugouVipTime(ordinaryExpire) || Number(data.is_vip) > 0 || Number(data.vip_type) > 0) {
    add('regular/vip', '普通 VIP', ordinaryExpire, data.is_vip || data.vip_type)
  }
  if (parseKugouVipTime(data.su_vip_end_time)) add('regular/svip', '超级 VIP', data.su_vip_end_time, 0)
  return [...memberships.values()]
}

export const kugouMembershipChanges = (before = [], after = []) => after.flatMap(item => {
  const previous = before.find(entry => entry.id === item.id)
  const expiresAt = parseKugouVipTime(item.expireTime)
  const previousAt = parseKugouVipTime(previous?.expireTime)
  if (expiresAt <= previousAt || item.status !== 'active') return []
  return [{ id: item.id, name: item.name, before: previous?.expireTime || '', after: item.expireTime }]
})
