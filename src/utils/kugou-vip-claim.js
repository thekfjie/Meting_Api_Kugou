import { normalizeKugouCookieForMeting, stringifyCookie } from './admin.js'
import { getKugouVipDay, summarizeKugouMemberships, kugouMembershipChanges } from './kugou-membership.js'
import { fetchKugouVipDetail, performKugouLiteVipListen, performKugouLiteVipClaim } from './kugou-upstream-vip.js'

const safeStep = result => ({
  ok: Boolean(result.ok),
  http: result.status || 0,
  code: result.body?.error_code ?? result.body?.errcode ?? result.body?.status ?? result.code ?? null
})

// Keep the original listen/report reward path for all account and scheduler jobs.
// An existing membership alone is never proof that a new reward was granted.
export const claimKugouLiteVipReward = async (initialCookie, pool, { previousResult, now = Date.now() } = {}) => {
  let cookie = initialCookie
  let vipBody = null
  const evidence = { day: getKugouVipDay(now), kind: 'listen-reward', claim: { state: 'unverified' }, steps: {}, changes: [] }
  const call = async (name, operation) => {
    let response
    try { response = await operation(cookie, pool) } catch (error) { response = { ok: false, code: error.code || 'NETWORK_ERROR' } }
    cookie = normalizeKugouCookieForMeting({ existingCookie: cookie, upstreamCookie: stringifyCookie(response.cookieMap || {}) })
    evidence.steps[name] = safeStep(response)
    return response
  }
  const finish = message => ({ ok: evidence.claim.state === 'confirmed', message, cookie, vipBody, evidence })
  const before = await call('beforeVip', fetchKugouVipDetail)
  if (before.ok) vipBody = before.body
  const memberships = before.ok ? summarizeKugouMemberships(before.body.data, now) : []
  const previous = previousResult?.evidence
  if (previous?.kind === 'listen-reward' && previous.day === evidence.day && ['accepted', 'uncertain'].includes(previous.claim?.state)) {
    evidence.claim = { ...previous.claim, reused: true }
    evidence.steps.claim = previous.steps.claim
    if (before.ok && previous.claim.before) {
      evidence.changes = kugouMembershipChanges(previous.claim.before, memberships)
      if (evidence.changes.length) evidence.claim.state = 'confirmed'
    }
    return finish(evidence.claim.state === 'confirmed' ? '会员权益已更新' : '上次领取尚待核验，未重复提交')
  }
  const listen = await call('listen', performKugouLiteVipListen)
  if (!listen.ok) { evidence.claim.state = 'failed'; return finish('听歌任务未完成，未执行领取') }
  const claim = await call('claim', performKugouLiteVipClaim)
  evidence.claim = { state: claim.ok ? 'accepted' : claim.status ? 'failed' : 'uncertain', before: memberships }
  const reward = claim.body?.data
  const hours = Number(reward?.award_vip_hour)
  const done = Number(reward?.done)
  const total = Number(reward?.total)
  if (claim.ok && hours > 0 && done > 0 && total >= done) {
    evidence.claim.state = 'confirmed'
    evidence.reward = { hours, done, total, remaining: Number(reward.remain) }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const after = await call(`afterVip${attempt + 1}`, fetchKugouVipDetail)
    if (!after.ok) continue
    vipBody = after.body
    if (before.ok) evidence.changes = kugouMembershipChanges(memberships, summarizeKugouMemberships(after.body.data, now))
    if (claim.ok && evidence.changes.length) evidence.claim.state = 'confirmed'
    if (evidence.claim.state !== 'accepted' || evidence.changes.length) break
  }
  return finish(evidence.claim.state === 'confirmed' ? evidence.reward ? `已领取 ${hours} 小时会员时长` : '会员权益已更新' : evidence.claim.state === 'accepted' ? '领取请求已接受，权益待确认' : evidence.claim.state === 'uncertain' ? '领取响应未确认，未重复提交' : '领取未成功')
}
