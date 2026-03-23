import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { readCookieFile } from '../utils/cookie.js'
import kugouMonitorService from './kugou-monitor.js'
import {
  clearSessionCookie,
  createAdminSession,
  hasAdminPassword,
  maskText,
  normalizeKugouCookieForMeting,
  parseSimpleCookie,
  requireAdminAuth,
  setSessionCookie,
  verifyAdminPassword,
  writeCookiePool
} from '../utils/admin.js'
import {
  checkKugouQrLogin,
  fetchKugouLoginProfile,
  fetchKugouQrLogin,
  hasKugouUpstreamAuth,
  loginKugouCellphone,
  registerKugouDevice,
  sendKugouCaptcha,
  refreshKugouLogin
} from '../utils/kugou-upstream-auth.js'

const execFileAsync = promisify(execFile)
const pm2Bin = 'C:\\Users\\Kfjie\\AppData\\Roaming\\npm\\pm2.cmd'
const qrState = new Map()
const smsState = new Map()

const escapeHtml = (value = '') => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const redirect = (c, location) => {
  c.header('Location', location)
  return c.body(null, 302)
}

const getForm = async (c) => {
  const body = await c.req.parseBody()
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(Array.isArray(value) ? value[0] : value)]))
}

const setFlash = (c, message) => {
  c.header('Set-Cookie', `meting_admin_flash=${encodeURIComponent(message)}; Path=/; SameSite=Lax`)
}

const getCookie = (c, name) => {
  const cookieHeader = c.req.header('cookie') || ''
  for (const part of cookieHeader.split(';')) {
    const item = part.trim()
    const idx = item.indexOf('=')
    if (idx === -1) continue
    if (item.slice(0, idx).trim() === name) return item.slice(idx + 1).trim()
  }
  return ''
}

const consumeFlash = (c) => {
  const value = getCookie(c, 'meting_admin_flash')
  if (value) {
    c.header('Set-Cookie', 'meting_admin_flash=; Path=/; SameSite=Lax; Max-Age=0')
  }
  return value ? decodeURIComponent(value) : ''
}

const runPm2 = async (args) => {
  try {
    const result = await execFileAsync('cmd.exe', ['/c', pm2Bin, ...args], { windowsHide: true })
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || 'pm2 failed'
    }
  }
}

const getPm2Status = async () => {
  const result = await runPm2(['jlist'])
  if (!result.ok) return []
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    return []
  }
}

const summarizePool = async (pool) => {
  const cookie = await readCookieFile('kugou', pool)
  const parsed = parseSimpleCookie(cookie)
  return {
    pool,
    configured: Boolean(cookie),
    token: maskText(parsed.t),
    userId: parsed.KugooID || '',
    dfid: maskText(parsed.dfid || parsed.kg_dfid),
    mid: maskText(parsed.mid || parsed.kg_mid),
    vipType: parsed.vip_type || ''
  }
}

const readMonitorData = async () => {
  const headers = new Headers()
  const response = await kugouMonitorService({
    req: { query: () => ({}) },
    header: (name, value) => headers.set(name, value),
    json: (payload) => payload
  })
  return response
}

const getLoginState = () => {
  const item = qrState.get('kugou')
  if (!item) return null
  if (item.expiresAt < Date.now()) {
    qrState.delete('kugou')
    return null
  }
  return item
}

const setLoginState = (data) => {
  qrState.set('kugou', {
    ...data,
    expiresAt: Date.now() + 5 * 60 * 1000
  })
}

const getSmsState = () => {
  const item = smsState.get('kugou')
  if (!item) return null
  if (item.expiresAt < Date.now()) {
    smsState.delete('kugou')
    return null
  }
  return item
}

const setSmsState = (data) => {
  smsState.set('kugou', {
    ...data,
    expiresAt: Date.now() + 10 * 60 * 1000
  })
}

const describeProfile = (profile, pools) => {
  const premiumUser = pools.find(item => item.pool === 'premium')?.userId || ''
  const generalUser = pools.find(item => item.pool === 'general')?.userId || ''
  const currentUser = String(profile?.detail?.data?.userid || profile?.detail?.data?.user_id || '')
  let poolOwner = '-'
  if (currentUser && currentUser === premiumUser) poolOwner = 'premium'
  else if (currentUser && currentUser === generalUser) poolOwner = 'general'

  const vipData = profile?.vip?.data || {}
  return {
    userId: currentUser || '-',
    nickname: profile?.detail?.data?.nickname || profile?.detail?.data?.uname || '-',
    poolOwner,
    vipType: vipData.vip_type || vipData.type || '-',
    vipLevel: vipData.vip_level || vipData.level || '-',
    expiresAt: vipData.expire_time || vipData.vip_end_time || vipData.expire || '-'
  }
}

const renderLoginPage = (message = '') => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meting Admin</title>
  <style>
    body{margin:0;font-family:Georgia,serif;background:linear-gradient(135deg,#f4efe6,#ddd5c7);color:#2b241c;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{width:min(420px,92vw);background:rgba(255,250,244,.95);border:1px solid #c9baa6;border-radius:18px;padding:28px;box-shadow:0 20px 50px rgba(58,44,28,.16)}
    h1{margin:0 0 8px;font-size:28px}
    p{margin:0 0 18px;color:#6b5a49}
    input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid #c7b8a4;background:#fffdf9;margin:10px 0 14px}
    button{width:100%;padding:12px 14px;border:0;border-radius:12px;background:#2f5d50;color:#fff;font-weight:700;cursor:pointer}
    .msg{margin:0 0 12px;padding:10px 12px;border-radius:10px;background:#f6e6dc;color:#8a3f12}
  </style>
</head>
<body>
  <form class="card" method="post" action="/admin/login">
    <h1>Admin</h1>
    <p>输入后台密码进入管理页。</p>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
    <input type="password" name="password" placeholder="后台密码" autocomplete="current-password">
    <button type="submit">登录</button>
  </form>
</body>
</html>`

const renderAdminPage = ({ flash, basePath, pm2, pools, monitor, loginState, smsState, profile, profileSummary, upstreamPlatform }) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meting Admin</title>
  <style>
    :root{--bg:#f5efe4;--panel:#fffaf2;--line:#d8c9b5;--text:#2f261d;--muted:#6f6358;--brand:#24594f;--warn:#8b3f1f}
    *{box-sizing:border-box} body{margin:0;font-family:Georgia,serif;background:radial-gradient(circle at top,#f9f4ed,#eadfce 58%,#e1d1be);color:var(--text)}
    .wrap{max-width:1180px;margin:0 auto;padding:24px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px}
    .title{font-size:34px;margin:0}.sub{color:var(--muted);margin-top:6px}
    .btn,.smallbtn{display:inline-block;border:0;border-radius:12px;background:var(--brand);color:#fff;padding:10px 14px;text-decoration:none;cursor:pointer}
    .smallbtn{padding:8px 10px;font-size:13px}.ghost{background:#8a7457}.danger{background:#8a3f1f}
    .flash{margin:0 0 18px;padding:12px 14px;border-radius:12px;background:#edf7f1;border:1px solid #b8d7c3}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
    .card{background:rgba(255,250,242,.96);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 14px 38px rgba(58,44,28,.08)}
    h2{margin:0 0 12px;font-size:21px} h3{margin:16px 0 10px;font-size:16px}
    p,li{color:var(--muted)} code{background:#f2e7d8;padding:2px 6px;border-radius:6px}
    table{width:100%;border-collapse:collapse;font-size:14px} th,td{padding:8px 6px;border-bottom:1px solid #eee0cf;text-align:left;vertical-align:top}
    input,select,textarea{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#fffdfa}
    textarea{min-height:86px;resize:vertical} .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.muted{color:var(--muted);font-size:13px}.mono{font-family:Consolas,monospace}
    .qr{max-width:220px;border-radius:12px;border:1px solid var(--line);background:#fff;padding:10px}.split{display:grid;grid-template-columns:1.3fr .7fr;gap:16px}.list{margin:0;padding-left:18px}
    @media (max-width:880px){.split{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1 class="title">Meting Admin</h1>
        <div class="sub">统一查看 Kugou 双池、上游登录状态与 PM2 进程。</div>
      </div>
      <form method="post" action="${basePath}/admin/logout"><button class="ghost btn" type="submit">退出登录</button></form>
    </div>
    ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}
    <div class="grid">
      <section class="card">
        <h2>运行状态</h2>
        <table><thead><tr><th>进程</th><th>状态</th><th>内存</th><th>操作</th></tr></thead><tbody>
          ${pm2.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.pm2_env?.status || '-')}</td><td>${Math.round((item.monit?.memory || 0) / 1024 / 1024)} MB</td><td><form method="post" action="${basePath}/admin/pm2"><input type="hidden" name="name" value="${escapeHtml(item.name)}"><input type="hidden" name="action" value="restart"><button class="smallbtn" type="submit">重启</button></form></td></tr>`).join('')}
        </tbody></table>
        <div class="actions">
          <form method="post" action="${basePath}/admin/pm2"><input type="hidden" name="name" value="meting-api"><input type="hidden" name="action" value="restart-update"><button class="smallbtn" type="submit">重载 Meting 环境</button></form>
          <form method="post" action="${basePath}/admin/pm2"><input type="hidden" name="name" value="kugou-upstream"><input type="hidden" name="action" value="restart-update"><button class="smallbtn" type="submit">重载 Upstream 环境</button></form>
        </div>
      </section>
      <section class="card">
        <h2>双号池</h2>
        <table><thead><tr><th>池</th><th>已配置</th><th>User</th><th>Token</th><th>VIP</th></tr></thead><tbody>
          ${pools.map(item => `<tr><td>${item.pool}</td><td>${item.configured ? '是' : '否'}</td><td>${escapeHtml(item.userId || '-')}</td><td class="mono">${escapeHtml(item.token || '-')}</td><td>${escapeHtml(item.vipType || '-')}</td></tr>`).join('')}
        </tbody></table>
        <div class="muted">保留原来的 premium/general 双池逻辑。管理页登录成功后，可把新的上游登录态写回任意池文件。</div>
      </section>
      <section class="card split" style="grid-column:1/-1">
        <div>
          <h2>Kugou 登录</h2>
          <p>当前上游启用方式：<code>${escapeHtml(upstreamPlatform || 'default')}</code>。根据 KuGouMusicApi 文档，登录支持密码、短信验证码、酷狗二维码、微信开放平台；其中密码登录文档明确标注“可能需要验证，不推荐”。更稳的是二维码登录或短信验证码登录。</p>
          <ul class="list">
            <li>当前部署是 <code>platform=lite</code>，也就是概念版链路</li>
            <li>刷新登录用 <code>/login/token</code>，不是永久登录</li>
            <li>登录成功后，页面可直接把会话写入 <code>premium</code> 或 <code>general</code> 池</li>
          </ul>
          <div class="actions">
            <form method="post" action="${basePath}/admin/kugou/qr/start"><button class="btn" type="submit">生成酷狗二维码</button></form>
            <form method="post" action="${basePath}/admin/kugou/qr/check"><button class="ghost btn" type="submit">检查扫码状态</button></form>
            <form method="post" action="${basePath}/admin/kugou/refresh"><button class="smallbtn" type="submit">刷新 premium 登录态</button></form>
            <form method="post" action="${basePath}/admin/kugou/refresh"><input type="hidden" name="pool" value="general"><button class="smallbtn" type="submit">刷新 general 登录态</button></form>
          </div>
          ${profileSummary ? `<h3>当前账号概览</h3><table><tbody><tr><th>User ID</th><td>${escapeHtml(profileSummary.userId)}</td></tr><tr><th>昵称</th><td>${escapeHtml(profileSummary.nickname)}</td></tr><tr><th>当前池</th><td>${escapeHtml(profileSummary.poolOwner)}</td></tr><tr><th>VIP 类型</th><td>${escapeHtml(profileSummary.vipType)}</td></tr><tr><th>VIP 等级</th><td>${escapeHtml(profileSummary.vipLevel)}</td></tr><tr><th>到期时间</th><td>${escapeHtml(profileSummary.expiresAt)}</td></tr></tbody></table>` : '<div class="muted">尚未获取用户资料。</div>'}
          ${profile ? `<details><summary class="muted">查看原始账号数据</summary><pre class="mono">${escapeHtml(JSON.stringify(profile, null, 2))}</pre></details>` : ''}
          <h3>短信验证码登录</h3>
          <form method="post" action="${basePath}/admin/kugou/captcha/send">
            <label>手机号</label>
            <input name="mobile" placeholder="输入手机号" value="${escapeHtml(smsState?.mobile || '')}">
            <button class="smallbtn" type="submit">发送验证码</button>
          </form>
          <form method="post" action="${basePath}/admin/kugou/captcha/login" style="margin-top:10px">
            <label>验证码</label>
            <input name="code" placeholder="输入短信验证码">
            <label>写入池</label>
            <select name="pool"><option value="premium">premium</option><option value="general">general</option></select>
            <button class="btn" type="submit" style="margin-top:10px">验证码登录并写入</button>
          </form>
        </div>
        <div>
          ${loginState ? `<h3>二维码登录</h3><img class="qr" src="${escapeHtml(loginState.base64)}" alt="qr"><p class="muted">扫码后点“检查扫码状态”。状态 key：${escapeHtml(loginState.key)}</p><form method="post" action="${basePath}/admin/kugou/qr/apply"><label>写入池</label><select name="pool"><option value="premium">premium</option><option value="general">general</option></select><button class="btn" type="submit" style="margin-top:10px">写入登录态</button></form>` : '<div class="muted">还没有生成二维码。</div>'}
        </div>
      </section>
      <section class="card" style="grid-column:1/-1">
        <h2>Kugou 监控</h2>
        <pre class="mono">${escapeHtml(JSON.stringify(monitor, null, 2))}</pre>
      </section>
    </div>
  </div>
</body>
</html>`

const getProfileSummary = async () => {
  const premiumCookie = await readCookieFile('kugou', 'premium')
  const generalCookie = premiumCookie ? '' : await readCookieFile('kugou', 'general')
  const cookie = premiumCookie || generalCookie
  if (!cookie || !hasKugouUpstreamAuth()) return null
  const profile = await fetchKugouLoginProfile(cookie)
  return profile
}

const getUpstreamPlatform = async () => {
  try {
    const envPath = resolve(process.cwd(), '../KuGouMusicApi/.env')
    const content = await readFile(envPath, 'utf8')
    const line = content.split(/\r?\n/).find(item => item.startsWith('platform=')) || ''
    return line.slice('platform='.length).trim() || 'default'
  } catch (error) {
    return 'default'
  }
}

const ensureAuth = (c) => {
  if (!hasAdminPassword()) {
    return c.html('<h1>ADMIN_PASSWORD 未配置</h1>', 500)
  }
  if (!requireAdminAuth(c)) {
    return redirect(c, '/admin/login')
  }
  return null
}

const getBasePath = (c) => {
  const prefix = c.req.path.replace(/\/admin(?:\/login)?(?:\/.*)?$/, '')
  return prefix === '/' ? '' : prefix
}

const renderPublicInfoPage = ({ basePath, monitor }) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meting Monitor</title>
  <style>
    body{margin:0;font-family:Georgia,serif;background:linear-gradient(135deg,#f5efe4,#e5d6c2);color:#2f261d}
    .wrap{max-width:980px;margin:0 auto;padding:24px}.card{background:rgba(255,250,242,.96);border:1px solid #d8c9b5;border-radius:18px;padding:18px;box-shadow:0 14px 38px rgba(58,44,28,.08)}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px} .btn{border:0;border-radius:12px;background:#24594f;color:#fff;padding:10px 14px;text-decoration:none}
    pre{white-space:pre-wrap;word-break:break-word;background:#f6ecdf;border-radius:12px;padding:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top"><div><h1>Meting Monitor</h1><p>未登录时只展示基础状态。</p></div><a class="btn" href="${basePath}/admin/login">后台登录</a></div>
    <div class="card"><pre>${escapeHtml(JSON.stringify(monitor, null, 2))}</pre></div>
  </div>
</body>
</html>`

export default async (c) => {
  const basePath = getBasePath(c)

  if (c.req.method === 'GET' && c.req.path.endsWith('/login')) {
    return c.html(renderLoginPage(consumeFlash(c)))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/login')) {
    const form = await getForm(c)
    if (!verifyAdminPassword(form.password || '')) {
      setFlash(c, '密码错误')
      return redirect(c, `${basePath}/admin/login`)
    }
    setSessionCookie(c, createAdminSession())
    return redirect(c, `${basePath}/admin`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/logout')) {
    clearSessionCookie(c)
    return redirect(c, `${basePath}/admin/login`)
  }

  if (c.req.method === 'GET' && c.req.path.endsWith('/admin') && !requireAdminAuth(c)) {
    const monitor = await readMonitorData()
    return c.html(renderPublicInfoPage({ basePath, monitor }))
  }

  const denied = ensureAuth(c)
  if (denied) return denied

  if (c.req.method === 'POST' && c.req.path.endsWith('/pm2')) {
    const form = await getForm(c)
    const args = form.action === 'restart-update'
      ? ['restart', form.name, '--update-env']
      : ['restart', form.name]
    const result = await runPm2(args)
    setFlash(c, result.ok ? `已执行 PM2 操作: ${form.name}` : `PM2 操作失败: ${result.stderr || result.stdout}`)
    return redirect(c, `${basePath}/admin`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/start')) {
    const login = await fetchKugouQrLogin()
    if (!login) {
      setFlash(c, '生成二维码失败')
      return redirect(c, `${basePath}/admin`)
    }
    const device = await registerKugouDevice()
    setLoginState({ ...login, cookieMap: device?.cookieMap || {}, token: '', userid: '' })
    setFlash(c, '二维码已生成')
    return redirect(c, `${basePath}/admin`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/check')) {
    const state = getLoginState()
    if (!state) {
      setFlash(c, '请先生成二维码')
      return redirect(c, `${basePath}/admin`)
    }
    const result = await checkKugouQrLogin(state.key)
    setLoginState({
      ...state,
      ...result,
      cookieMap: {
        ...(state.cookieMap || {}),
        ...(result.cookieMap || {})
      },
      base64: state.base64,
      url: state.url,
      key: state.key
    })
    const map = { 0: '二维码已过期', 1: '等待扫码', 2: '已扫码待确认', 4: '已登录成功，可写入池' }
    setFlash(c, map[result.status] || `当前状态: ${result.status}`)
    return redirect(c, `${basePath}/admin`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/apply')) {
    const state = getLoginState()
    const form = await getForm(c)
    if (!state || Number(state.status) !== 4) {
      setFlash(c, '登录尚未完成，不能写入池')
      return redirect(c, `${basePath}/admin`)
    }

    const existingCookie = await readCookieFile('kugou', form.pool || 'premium')
    const mergedCookie = normalizeKugouCookieForMeting({
      existingCookie,
      upstreamCookie: Object.entries(state.cookieMap || {}).map(([key, value]) => `${key}=${value}`).join('; ')
    })
    await writeCookiePool(form.pool || 'premium', mergedCookie)
    setFlash(c, `已写入 ${form.pool || 'premium'} 池`)
    return redirect(c, `${basePath}/admin`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/refresh')) {
    const form = await getForm(c)
    const pool = form.pool || 'premium'
    const currentCookie = await readCookieFile('kugou', pool)
    if (!currentCookie) {
      setFlash(c, `${pool} 池没有可刷新的 Cookie`)
      return redirect(c, `${basePath}/admin`)
    }
    const result = await refreshKugouLogin(currentCookie)
    const mergedCookie = normalizeKugouCookieForMeting({
      existingCookie: currentCookie,
      upstreamCookie: Object.entries(result.cookieMap || {}).map(([key, value]) => `${key}=${value}`).join('; ')
    })
    await writeCookiePool(pool, mergedCookie)
    setFlash(c, `${pool} 池登录态已刷新`)
    return redirect(c, `${basePath}/admin`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/send')) {
    const form = await getForm(c)
    if (!form.mobile) {
      setFlash(c, '请先输入手机号')
      return redirect(c, `${basePath}/admin`)
    }
    const device = await registerKugouDevice()
    const result = await sendKugouCaptcha({
      mobile: form.mobile,
      cookieMap: device.cookieMap || {}
    })
    setSmsState({
      mobile: form.mobile,
      cookieMap: result.cookieMap || device.cookieMap || {}
    })
    setFlash(c, `验证码发送结果: ${JSON.stringify(result.body || {})}`)
    return redirect(c, `${basePath}/admin`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/login')) {
    const form = await getForm(c)
    const state = getSmsState()
    if (!state?.mobile || !form.code) {
      setFlash(c, '请先发送验证码并填写验证码')
      return redirect(c, `${basePath}/admin`)
    }
    const result = await loginKugouCellphone({
      mobile: state.mobile,
      code: form.code,
      cookieMap: state.cookieMap || {}
    })
    const existingCookie = await readCookieFile('kugou', form.pool || 'premium')
    const mergedCookie = normalizeKugouCookieForMeting({
      existingCookie,
      upstreamCookie: Object.entries(result.cookieMap || {}).map(([key, value]) => `${key}=${value}`).join('; ')
    })
    await writeCookiePool(form.pool || 'premium', mergedCookie)
    setFlash(c, `验证码登录已写入 ${form.pool || 'premium'} 池`)
    return redirect(c, `${basePath}/admin`)
  }

  const flash = consumeFlash(c)
  const [pm2, premiumPool, generalPool, monitor, profile, upstreamPlatform] = await Promise.all([
    getPm2Status(),
    summarizePool('premium'),
    summarizePool('general'),
    readMonitorData(),
    getProfileSummary(),
    getUpstreamPlatform()
  ])

  const pools = [premiumPool, generalPool]

  return c.html(renderAdminPage({
    flash,
    basePath,
    pm2,
    pools,
    monitor,
    loginState: getLoginState(),
    smsState: getSmsState(),
    profile,
    profileSummary: describeProfile(profile, pools),
    upstreamPlatform
  }))
}
