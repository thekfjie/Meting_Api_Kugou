import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  clearCookiePool,
  clearSessionCookie,
  copyCookiePool,
  createAdminSession,
  hasAdminPassword,
  maskText,
  moveCookiePool,
  parseSimpleCookie,
  requireAdminAuth,
  setSessionCookie,
  verifyAdminPassword
} from '../utils/admin.js'
import {
  activateKugouAccount,
  checkKugouPoolSession,
  applyKugouPoolCookieMap,
  claimAllKugouLiteVip,
  claimKugouLiteVip,
  getKugouPoolLabel,
  refreshKugouPool
} from '../utils/kugou-admin-actions.js'
import {
  getKugouAdminPoolState,
  getKugouAdminSession,
  setKugouAdminSession
} from '../utils/kugou-admin-state.js'
import { inspectCookieSource, readCookieFile, readCookiePoolFile } from '../utils/cookie.js'
import {
  checkKugouQrLogin,
  fetchKugouQrLogin,
  hasKugouUpstreamAuth,
  loginKugouCellphone,
  registerKugouDevice,
  sendKugouCaptcha
} from '../utils/kugou-upstream-auth.js'
import {
  getKugouPoolPlatform,
  getKugouPoolUpstreamProcessName,
  getKugouPoolUpstreamUrl,
  shouldAutoClaimKugouPool,
  listKugouUpstreamProcessNames
} from '../utils/kugou-upstream-runtime.js'
import { getKugouUpstreamTrace } from '../utils/kugou-upstream-status.js'
import {
  readRequestSummaries
} from '../utils/request-summary-log.js'
import kugouMonitorService from './kugou-monitor.js'
import { page, loginPage, publicPage, adminAsset } from '../views/admin.js'
import { kugouAuthSummary } from '../utils/kugou-auth-log.js'
import { getKugouAccountId, getSavedKugouAccount, saveKugouAccount, listKugouAccounts } from '../utils/kugou-accounts.js'

const execFileAsync = promisify(execFile)
const pm2Bin = process.env.PM2_BIN || (process.platform === 'win32' ? 'pm2.cmd' : 'pm2')
const normalizePool = pool => pool === 'general' ? 'general' : 'premium'
const qrLabel = status => ({ 0: '二维码已过期', 1: '等待扫码', 2: '等待确认', 4: '授权成功，可以保存' }[Number(status)] || '状态暂不可用')

const root = (base) => `${base}/manage`
const loginPath = (base) => `${root(base)}/login`
const wantsJson = (c) => (
  c.req.query('format') === 'json' ||
  (
    String(c.req.header('accept') || '').toLowerCase().includes('application/json') &&
    !String(c.req.header('accept') || '').toLowerCase().includes('text/html')
  )
)

const getBasePath = (c) => {
  const path = c.req.path
  const musicIndex = path.indexOf('/music/manage')
  if (musicIndex !== -1) return `${path.slice(0, musicIndex)}/music`

  const apiIndex = path.indexOf('/api/manage')
  if (apiIndex !== -1) return `${path.slice(0, apiIndex)}/api`

  return ''
}

const flashCookie = 'meting_admin_flash'

const redirect = (c, location) => {
  c.header('Location', location)
  return c.body(null, 302)
}

const getForm = async (c) => {
  const body = await c.req.parseBody()
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, String(Array.isArray(value) ? value[0] : value)])
  )
}

const getCookie = (c, name) => {
  const raw = c.req.header('cookie') || ''
  for (const part of raw.split(';')) {
    const item = part.trim()
    const idx = item.indexOf('=')
    if (idx !== -1 && item.slice(0, idx).trim() === name) {
      return item.slice(idx + 1).trim()
    }
  }
  return ''
}

const setFlash = (c, message) => {
  c.header('Set-Cookie', `${flashCookie}=${encodeURIComponent(message)}; Path=/; SameSite=Lax`)
}

const consumeFlash = (c) => {
  const value = getCookie(c, flashCookie)
  if (value) {
    c.header('Set-Cookie', `${flashCookie}=; Path=/; SameSite=Lax; Max-Age=0`)
  }
  return value ? decodeURIComponent(value) : ''
}

const respond = (c, basePath, payload, message = '') => (
  wantsJson(c)
    ? c.json(payload)
    : (message && setFlash(c, message), redirect(c, root(basePath)))
)

const needAuth = (c, basePath) => {
  if (!hasAdminPassword()) return c.html('<h1>ADMIN_PASSWORD 未配置</h1>', 500)
  if (!requireAdminAuth(c)) return redirect(c, loginPath(basePath))
  return null
}

const pm2 = async (args) => {
  try {
    const cmd = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/c', pm2Bin, ...args], opts: { windowsHide: true } }
      : { file: pm2Bin, args, opts: {} }
    const result = await execFileAsync(cmd.file, cmd.args, cmd.opts)
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
  } catch (error) {
    return { ok: false, stdout: error.stdout || '', stderr: error.stderr || error.message || 'pm2 failed' }
  }
}

const pm2Status = async () => {
  const result = await pm2(['jlist'])
  if (!result.ok) return []
  try {
    return JSON.parse(result.stdout)
  } catch {
    return []
  }
}

const monitor = async (force = false) => {
  const headers = new Headers()
  return kugouMonitorService({
    req: {
      query: (key) => {
        if (!key) return force ? { refresh: '1' } : {}
        return key === 'refresh' && force ? '1' : undefined
      }
    },
    header: (name, value) => headers.set(name, value),
    json: payload => payload
  })
}

const qrState = async (pool) => getKugouAdminSession('qrLogin', pool)
const setQrState = async (value) => setKugouAdminSession('qrLogin', value ? { ...value, expiresAt: value.expiresAt || Date.now() + 5 * 60 * 1000 } : null)
const smsState = async (pool) => getKugouAdminSession('smsLogin', pool)
const setSmsState = async (value) => setKugouAdminSession('smsLogin', value ? { ...value, expiresAt: Date.now() + 10 * 60 * 1000 } : null)

const poolView = async (pool) => {
  const normalizedPool = normalizePool(pool)
  const [activeCookie, fileCookie, sourceInfo, state] = await Promise.all([
    readCookieFile('kugou', normalizedPool),
    readCookiePoolFile('kugou', normalizedPool),
    inspectCookieSource('kugou', normalizedPool),
    getKugouAdminPoolState(normalizedPool)
  ])

  const active = parseSimpleCookie(activeCookie)
  const file = parseSimpleCookie(fileCookie)
  const account = state.account?.userId && active.KugooID && state.account.userId !== active.KugooID ? {} : state.account || {}
  const platform = getKugouPoolPlatform(normalizedPool)

  return {
    pool: normalizedPool,
    label: getKugouPoolLabel(normalizedPool),
    platform,
    autoClaim: shouldAutoClaimKugouPool(normalizedPool),
    auth: kugouAuthSummary(activeCookie),
    accountId: getKugouAccountId(activeCookie, platform),
    processName: getKugouPoolUpstreamProcessName(normalizedPool),
    upstreamUrl: getKugouPoolUpstreamUrl(normalizedPool),
    sourceInfo,
    filePath: sourceInfo.filePath || '',
    activeConfigured: Boolean(activeCookie),
    fileConfigured: Boolean(fileCookie),
    token: maskText(active.t || file.t),
    userId: account.userId || active.KugooID || file.KugooID || '',
    nickname: account.nickname || '',
    vipType: account.vipType || active.vip_type || file.vip_type || '',
    vipLevel: account.vipLevel || '',
    expireTime: account.expireTime || '',
    dfid: maskText(active.dfid || active.kg_dfid || file.dfid || file.kg_dfid),
    mid: maskText(active.KUGOU_API_MID || active.mid || active.kg_mid || file.KUGOU_API_MID || file.mid || file.kg_mid),
    state,
    warnings: sourceInfo.source === 'env'
      ? ['当前运行时优先使用环境变量，文件池写入不会立刻生效；如需使用后台写入的登录态，请先移除环境变量覆盖。']
      : []
  }
}

export default async (c) => {
  const basePath = getBasePath(c)
  const asset = adminAsset(c.req.path.split('/assets/')[1])
  if (asset && c.req.method === 'GET') {
    c.header('Content-Type', asset[0])
    c.header('Cache-Control', 'public, max-age=300')
    return c.body(asset[1])
  }
  c.header('Cache-Control', 'no-store')

  if (c.req.method === 'GET' && c.req.path.endsWith('/login')) {
    if (requireAdminAuth(c)) return redirect(c, root(basePath))
    return c.html(loginPage({ message: consumeFlash(c), basePath }))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/login')) {
    const form = await getForm(c)
    if (!verifyAdminPassword(form.password || '')) {
      setFlash(c, '后台密码错误')
      return redirect(c, loginPath(basePath))
    }
    setSessionCookie(c, createAdminSession())
    return redirect(c, root(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/logout')) {
    clearSessionCookie(c)
    return redirect(c, loginPath(basePath))
  }

  if (c.req.method === 'GET' && c.req.path.endsWith('/manage/monitor') && !requireAdminAuth(c)) {
    return c.html(publicPage({ basePath, mon: await monitor() }))
  }

  const denied = needAuth(c, basePath)
  if (denied) return denied

  if (c.req.method === 'POST' && c.req.path.endsWith('/accounts/activate')) {
    const form = await getForm(c)
    const result = await activateKugouAccount(normalizePool(form.pool), form.id)
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/session/check')) {
    const form = await getForm(c)
    const results = []
    for (const pool of form.pool === 'all' ? ['premium', 'general'] : [normalizePool(form.pool)]) {
      results.push(await checkKugouPoolSession(pool))
    }
    const ok = results.every(result => result.ok)
    return respond(c, basePath, { ok, results, message: ok ? '登录校验通过' : '校验已完成，请查看各池状态' }, ok ? '登录校验通过' : '部分登录态需要检查')
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pm2')) {
    const form = await getForm(c)
    const result = await pm2(form.action === 'restart-update'
      ? ['restart', form.name, '--update-env']
      : ['restart', form.name]
    )
    return respond(c, basePath, result, result.ok ? `已执行 PM2 操作：${form.name}` : `PM2 操作失败：${result.stderr || result.stdout}`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/clear')) {
    const form = await getForm(c)
    const pool = normalizePool(form.pool)
    try {
      await clearCookiePool(pool)
      return respond(c, basePath, { ok: true, pool }, `${getKugouPoolLabel(pool)}文件已清空`)
    } catch (error) {
      return respond(c, basePath, { ok: false, message: error.message }, `清空失败：${error.message || '未知错误'}`)
    }
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/copy')) {
    const form = await getForm(c)
    const fromPool = normalizePool(form.fromPool)
    const toPool = normalizePool(form.toPool)
    if (fromPool === toPool) {
      return respond(c, basePath, { ok: false }, '源池和目标池不能相同')
    }
    try {
      await copyCookiePool(fromPool, toPool)
      return respond(c, basePath, { ok: true }, `${getKugouPoolLabel(fromPool)}已复制到${getKugouPoolLabel(toPool)}`)
    } catch (error) {
      return respond(c, basePath, { ok: false, message: error.message }, `复制失败：${error.message || '未知错误'}`)
    }
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/move')) {
    const form = await getForm(c)
    const fromPool = normalizePool(form.fromPool)
    const toPool = normalizePool(form.toPool)
    if (fromPool === toPool) {
      return respond(c, basePath, { ok: false }, '源池和目标池不能相同')
    }
    try {
      await moveCookiePool(fromPool, toPool)
      return respond(c, basePath, { ok: true }, `${getKugouPoolLabel(fromPool)}已迁移到${getKugouPoolLabel(toPool)}`)
    } catch (error) {
      return respond(c, basePath, { ok: false, message: error.message }, `迁移失败：${error.message || '未知错误'}`)
    }
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/start')) {
    const form = await getForm(c)
    const pool = normalizePool(form.pool)
    const device = await registerKugouDevice(pool)
    const login = await fetchKugouQrLogin(pool, device?.cookieMap || {})
    if (!login) {
      return respond(c, basePath, { ok: false, pool }, '生成二维码失败')
    }
    await setQrState({ ...login, pool, cookieMap: device?.cookieMap || {}, status: 1 })
    return respond(c, basePath, { ok: true, pool, login }, `${getKugouPoolLabel(pool)}二维码已生成`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/check')) {
    const form = await getForm(c)
    const state = await qrState(form.pool ? normalizePool(form.pool) : undefined)
    if (!state) {
      return respond(c, basePath, { ok: false }, '请先生成二维码')
    }
    const pool = normalizePool(state.pool)
    const result = await checkKugouQrLogin(state.key, pool, state.cookieMap || {})
    await setQrState({
      ...state,
      ...result,
      pool,
      cookieMap: {
        ...(state.cookieMap || {}),
        ...(result.cookieMap || {})
      }
    })
    return respond(c, basePath, { ...result, pool }, `${getKugouPoolLabel(pool)}：${qrLabel(result.status)}`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/apply')) {
    const form = await getForm(c)
    const state = await qrState(form.pool ? normalizePool(form.pool) : undefined)
    if (!state || Number(state.status) !== 4) {
      return respond(c, basePath, { ok: false }, '二维码登录尚未完成，不能写入池')
    }
    const pool = normalizePool(state.pool)
    const result = await applyKugouPoolCookieMap(pool, state.cookieMap || {}, { trigger: 'qr-login', activate: form.activate !== '0' })
    if (result.ok) await setKugouAdminSession('qrLogin', null, pool)
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/refresh')) {
    const form = await getForm(c)
    const result = await refreshKugouPool(normalizePool(form.pool), { trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/status/refresh')) {
    const refreshed = await monitor(true)
    return respond(c, basePath, refreshed, '已强制刷新 VIP 探针')
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/vip/claim')) {
    const form = await getForm(c)
    const result = await claimKugouLiteVip(normalizePool(form.pool), { trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/vip/claim-all')) {
    const result = await claimAllKugouLiteVip({ trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/send')) {
    const form = await getForm(c)
    if (!form.mobile) {
      return respond(c, basePath, { ok: false }, '请先输入手机号')
    }
    const pool = normalizePool(form.pool)
    const device = await registerKugouDevice(pool)
    const result = await sendKugouCaptcha({
      mobile: form.mobile,
      cookieMap: device.cookieMap || {},
      pool
    })
    await setSmsState({
      mobile: form.mobile,
      pool,
      cookieMap: result.cookieMap || device.cookieMap || {}
    })
    return respond(c, basePath, { ...result, pool }, `${getKugouPoolLabel(pool)}：${result.body?.msg || result.body?.message || '验证码已发送'}`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/login')) {
    const form = await getForm(c)
    const state = await smsState(form.pool ? normalizePool(form.pool) : undefined)
    if (!state?.mobile || !form.code) {
      return respond(c, basePath, { ok: false }, '请先发送验证码并填写短信验证码')
    }
    const pool = normalizePool(state.pool || form.pool)
    const result = await loginKugouCellphone({
      mobile: state.mobile,
      code: form.code,
      cookieMap: state.cookieMap || {},
      pool
    })
    const applied = await applyKugouPoolCookieMap(pool, result.cookieMap || {}, { trigger: 'sms-login', activate: form.activate !== '0' })
    if (applied.ok) await setKugouAdminSession('smsLogin', null, pool)
    return respond(c, basePath, applied, applied.message)
  }

  const flash = consumeFlash(c)
  const [procs, premium, general, mon, qr, sms, logs] = await Promise.all([
    pm2Status(),
    poolView('premium'),
    poolView('general'),
    monitor(),
    Promise.all(['premium', 'general'].map(pool => qrState(pool))),
    Promise.all(['premium', 'general'].map(pool => smsState(pool))),
    readRequestSummaries(30)
  ])

  const pools = [premium, general]
  for (const item of pools) {
    if (item.accountId && !(await getSavedKugouAccount(item.accountId))) {
      await saveKugouAccount(await readCookieFile('kugou', item.pool), item.platform, item.state.account, item.state.sessionStatus)
    }
  }
  const accounts = await listKugouAccounts()
  const warnings = []
  if (!hasKugouUpstreamAuth()) {
    warnings.push('当前没有配置 Kugou upstream URL；请至少配置默认版或 Lite 版 upstream，管理动作和 Lite 领取才会生效。')
  }
  if (pools.some(item => item.sourceInfo.source === 'env')) {
    warnings.push('当前仍有账号池优先使用环境变量 Cookie；后台写入的文件池不会立刻接管请求。')
  }
  if (!pools.some(item => item.platform === 'lite')) {
    warnings.push('当前没有任何池运行在 Lite 平台；Lite 自动领取和手动领取都不会执行。')
  }

  return c.html(page({
    flash,
    basePath,
    procs,
    pools,
    mon,
    qrSessions: { premium: qr[0], general: qr[1] },
    smsSessions: { premium: sms[0], general: sms[1] },
    accounts,
    trace: getKugouUpstreamTrace(),
    warnings,
    logs,
    quickProcessNames: ['meting-api', ...listKugouUpstreamProcessNames()]
  }))
}
