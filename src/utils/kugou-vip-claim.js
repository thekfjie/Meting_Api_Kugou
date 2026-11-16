import { normalizeKugouCookieForMeting, stringifyCookie } from './admin.js'
import { getKugouVipDay, summarizeKugouMemberships, kugouMembershipChanges } from './kugou-membership.js'
import {
  fetchKugouVipDetail, fetchKugouLiteVipRecord,
  performKugouLiteVipListen, performKugouLiteVipClaim, performKugouLiteVipUpgrade
} from './kugou-upstream-vip.js'

const claimedToday = (record, day) => record?.ok && Array.isArray(record.body?.data?.list) &&
  record.body.data.list.some(item => item.day === day && Number(item.receive_vip) > 0)

const safeStep = result => ({
  ok: Boolean(result.ok),
  http: result.status || 0,
  code: result.body?.error_code ?? result.body?.errcode ?? result.body?.status ?? result.code ?? null
})

// Shared by manual, scheduled, pool and individual-account actions. Successful
// requests and verified rewards are deliberately recorded as different states.
export const claimAndUpgradeKugouLiteVip = async (initialCookie, pool, { previousResult, now = Date.now() } = {}) => {
  let cookie = initialCookie
  let vipBody = null
  const day = getKugouVipDay(now)
  const evidence = { day, claim: { state: 'unverified' }, upgrade: { state: 'skipped' }, steps: {}, changes: [] }
  const call = async (name, operation) => {
    let response
    try { response = await operation(cookie, pool) } catch (error) { response = { ok: false, code: error.code || 'NETWORK_ERROR' } }
    cookie = normalizeKugouCookieForMeting({ existingCookie: cookie, upstreamCookie: stringifyCookie(response.cookieMap || {}) })
    evidence.steps[name] = safeStep(response)
    return response
  }
  const finish = message => ({ ok: evidence.claim.state === 'confirmed' && evidence.upgrade.state === 'confirmed', message, cookie, vipBody, evidence })
  const before = await call('beforeVip', fetchKugouVipDetail)
  if (before.ok) vipBody = before.body
  const records = await call('beforeRecord', fetchKugouLiteVipRecord)
  if (!before.ok || !records.ok || !Array.isArray(records.body?.data?.list)) return finish('暂时无法核验会员或领取记录，未执行领取')
  const beforeMemberships = summarizeKugouMemberships(before.body.data, now)
  evidence.claim.alreadyReceived = Boolean(claimedToday(records, day))
  if (evidence.claim.alreadyReceived) {
    evidence.claim.state = 'confirmed'
  } else {
    const previousClaim = previousResult?.evidence?.day === day ? previousResult.evidence.claim : null
    if (previousClaim && ['accepted', 'uncertain'].includes(previousClaim.state)) {
      evidence.claim = { ...previousClaim, reused: true }
      return finish('领取响应尚待核验，未重复提交；未执行升级')
    }
    if (getKugouVipDay() !== day) return finish('日期已变化，请重新核验当天记录')
    const listen = await call('listen', performKugouLiteVipListen)
    if (!listen.ok) { evidence.claim.state = 'failed'; return finish('听歌任务未完成，未执行领取和升级') }
    if (getKugouVipDay() !== day) return finish('日期已变化，请重新核验当天记录')
    const claim = await call('claim', (cookie, pool) => performKugouLiteVipClaim(cookie, pool, day))
    const afterRecord = await call('claimRecord', fetchKugouLiteVipRecord)
    evidence.claim.state = claimedToday(afterRecord, day) ? 'confirmed' : claim.ok ? 'accepted' : claim.status ? 'failed' : 'uncertain'
    if (evidence.claim.state !== 'confirmed') return finish(claim.ok ? '领取请求已接受，领取记录待确认；未执行升级' : '未确认今日领取成功，未执行升级')
  }

  // Read after the daily claim so its reward cannot be mistaken for an upgrade.
  const upgradeBaseline = evidence.claim.alreadyReceived ? before : await call('upgradeBaseline', fetchKugouVipDetail)
  if (!upgradeBaseline.ok) return finish('今日已领取，暂时无法核验升级前权益；未执行升级')
  vipBody = upgradeBaseline.body
  const previous = previousResult?.evidence?.day === day ? previousResult.evidence.upgrade : null
  const attempted = previous && ['confirmed', 'accepted', 'uncertain'].includes(previous.state)
  const baseline = attempted ? previous.before : summarizeKugouMemberships(upgradeBaseline.body.data, now)
  evidence.upgrade = { state: previous?.state === 'confirmed' ? 'confirmed' : 'skipped', before: baseline || [] }
  let upgrade
  if (attempted) {
    evidence.upgrade.state = previous.state
    evidence.upgrade.reused = true
  } else {
    if (getKugouVipDay() !== day) return finish('今日已领取，日期已变化；未执行升级')
    upgrade = await call('upgrade', performKugouLiteVipUpgrade)
    evidence.upgrade.state = upgrade.ok ? 'accepted' : upgrade.status ? 'failed' : 'uncertain'
  }
  // At most two readbacks; never repeat a reward write on a timeout.
  for (let attempt = 0; attempt < 2; attempt++) {
    const after = await call(`afterVip${attempt + 1}`, fetchKugouVipDetail)
    if (!after.ok) continue
    vipBody = after.body
    const memberships = summarizeKugouMemberships(after.body.data, now)
    evidence.changes = kugouMembershipChanges(beforeMemberships, memberships)
    const upgraded = kugouMembershipChanges(baseline, memberships).filter(item => item.id.startsWith('concept/'))
    if (upgraded.length && ['accepted', 'confirmed'].includes(evidence.upgrade.state)) {
      evidence.upgrade.state = 'confirmed'
      evidence.upgrade.changes = upgraded
      break
    }
    if (evidence.upgrade.state === 'confirmed' || evidence.upgrade.state === 'failed') break
  }
  const prefix = evidence.claim.alreadyReceived ? '今日已领取' : '今日领取已确认'
  return finish(`${prefix}；${evidence.upgrade.state === 'confirmed' ? '升级后权益已更新' : evidence.upgrade.state === 'accepted' ? '升级请求已接受，权益待确认' : evidence.upgrade.state === 'uncertain' ? '升级响应未确认，未重复提交' : '升级未成功'}`)
}
