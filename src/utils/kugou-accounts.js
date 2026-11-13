import { readKugouAdminState, updateKugouAdminState } from './kugou-admin-state.js'
import { parseKugouCookie } from './kugou-songinfo.js'
import { kugouAuthSummary } from './kugou-auth-log.js'

export const getKugouAccountId = (cookie, platform) => {
  const parsed = parseKugouCookie(cookie)
  const userId = parsed.KugooID || parsed.userid
  if (!/^[1-9]\d*$/.test(userId || '') || !(parsed.t || parsed.token)) return ''
  return `${parsed.KUGOU_API_PLATFORM || platform}:${userId}`
}

export const saveKugouAccount = async (cookie, platform, profile, sessionStatus) => {
  const id = getKugouAccountId(cookie, platform)
  if (!id) return
  await updateKugouAdminState(state => {
    const previous = state.accounts[id] || {}
    state.accounts[id] = {
      ...previous,
      id,
      platform: id.split(':')[0],
      userId: id.split(':')[1],
      cookie,
      profile: profile || previous.profile || {},
      sessionStatus: sessionStatus || previous.sessionStatus || null,
      updatedAt: new Date().toISOString()
    }
  })
  return id
}

export const getSavedKugouAccount = async id => (await readKugouAdminState()).accounts[id] || null

// Only summaries leave the account store. Raw cookies stay on the server.
export const listKugouAccounts = async () => {
  const state = await readKugouAdminState()
  return Object.values(state.accounts).map(account => ({
    id: account.id,
    platform: account.platform,
    userId: account.userId,
    nickname: account.profile?.nickname || '',
    vipType: account.profile?.vipType || '',
    expireTime: account.profile?.expireTime || '',
    updatedAt: account.updatedAt,
    maintenance: account.maintenance || {},
    auth: kugouAuthSummary(account.cookie),
    sessionStatus: account.sessionStatus?.token === kugouAuthSummary(account.cookie).token ? account.sessionStatus : null
  }))
}
