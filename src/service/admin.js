import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectCookieSource, readCookieFile } from '../utils/cookie.js'
import kugouMonitorService from './kugou-monitor.js'
import {
  clearCookiePool,
  copyCookiePool,
  clearSessionCookie,
  createAdminSession,
  hasAdminPassword,
  maskText,
  moveCookiePool,
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
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/c', pm2Bin, ...args], options: { windowsHide: true } }
      : { file: 'pm2', args, options: {} }
    const result = await execFileAsync(command.file, command.args, command.options)
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
  const sourceInfo = await inspectCookieSource('kugou', pool)
  const parsed = parseSimpleCookie(cookie)
  return {
    pool,
    configured: Boolean(cookie),
    token: maskText(parsed.t),
    userId: parsed.KugooID || '',
    dfid: maskText(parsed.dfid || parsed.kg_dfid),
    mid: maskText(parsed.mid || parsed.kg_mid),
    vipType: parsed.vip_type || '',
    source: sourceInfo.source,
    activeKey: sourceInfo.activeKey,
    filePath: sourceInfo.filePath,
    fallbackOrder: sourceInfo.fallbackOrder
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

const buildManageRoot = (basePath) => `${basePath}/manage`
const buildManageLogin = (basePath) => `${buildManageRoot(basePath)}/login`

const operationGuide = [
  '先访问公开监控页，确认当前池状态与剩余额度。',
  '进入登录页后，优先使用二维码登录；手机验证码适合作为备用方案。',
  '登录成功后，把登录态写入 premium 或 general 池，再刷新一次对应池以确认可续期。',
  '如果某个池失效，可先复制到另一个池做备份，再执行清空或迁移。'
]

const buttonHelp = [
  ['生成酷狗二维码', '向上游申请新的二维码登录会话，扫码后再检查状态。'],
  ['检查扫码状态', '轮询二维码状态，出现“已登录成功，可写入池”后再写入。'],
  ['刷新 premium/general 登录态', '调用 /login/token 尝试延长现有登录态，不会更换账号。'],
  ['发送验证码', '先给指定手机号触发短信验证码，下方再填写验证码登录。'],
  ['验证码登录并写入', '使用短信验证码直接登录，并把登录态写入选中的池。'],
  ['清空池', '删除该池当前 CK 文件，适合彻底下线一个账号。'],
  ['复制/迁移池', '复制会保留源池，迁移会把源池移动到目标池。']
]

const renderLoginPage = ({ message = '', basePath = '/music' }) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meting Admin</title>
  <style>
    :root{--bg:#f4efe6;--bg2:#ddd5c7;--panel:rgba(255,250,244,.95);--line:#c9baa6;--text:#2b241c;--muted:#6b5a49;--brand:#2f5d50;--warn-bg:#f6e6dc;--warn:#8a3f12;--code:#f2e7d8}
    @media (prefers-color-scheme: dark){:root{--bg:#0f1618;--bg2:#162126;--panel:rgba(18,26,29,.96);--line:#314249;--text:#eaf0ed;--muted:#b7c4be;--brand:#5fb29c;--warn-bg:#40261d;--warn:#ffcab2;--code:#203139}}
    body{margin:0;font-family:Georgia,serif;background:linear-gradient(135deg,var(--bg),var(--bg2));color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{width:min(460px,92vw);background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.18)}
    h1{margin:0 0 8px;font-size:28px} p{margin:0 0 18px;color:var(--muted)}
    input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--text);margin:10px 0 14px}
    button{width:100%;padding:12px 14px;border:0;border-radius:12px;background:var(--brand);color:#fff;font-weight:700;cursor:pointer}
    .msg{margin:0 0 12px;padding:10px 12px;border-radius:10px;background:var(--warn-bg);color:var(--warn)}
    .note{margin-top:14px;padding:12px 14px;border-radius:12px;background:var(--code);color:var(--muted);font-size:13px}
  </style>
</head>
<body>
  <form class="card" method="post" action="${buildManageLogin(basePath)}">
    <h1>Admin</h1>
    <p>输入后台密码进入管理页。登录成功后可管理 CK 池、二维码登录、短信验证码登录和 PM2 进程。</p>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
    <input type="password" name="password" placeholder="后台密码" autocomplete="current-password">
    <button type="submit">登录</button>
    <div class="note">监控页无需登录：<code>${escapeHtml(`${basePath}/manage/monitor`)}</code></div>
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
    :root{--bg:#f5efe4;--bg2:#eadfce;--bg3:#e1d1be;--panel:rgba(255,250,242,.96);--line:#d8c9b5;--text:#2f261d;--muted:#6f6358;--brand:#24594f;--brand-soft:#dce9e5;--warn:#8b3f1f;--warn-soft:#f4e2d7;--code:#f2e7d8}
    @media (prefers-color-scheme: dark){:root{--bg:#0d1418;--bg2:#132028;--bg3:#182831;--panel:rgba(18,28,33,.96);--line:#2b3e47;--text:#ecf3f0;--muted:#b1c0bb;--brand:#4fae96;--brand-soft:#17352f;--warn:#ffcab0;--warn-soft:#3d241c;--code:#20313a}}
    *{box-sizing:border-box} body{margin:0;font-family:Georgia,serif;background:radial-gradient(circle at top,var(--bg),var(--bg2) 58%,var(--bg3));color:var(--text)}
    .wrap{max-width:1180px;margin:0 auto;padding:24px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px}
    .title{font-size:34px;margin:0}.sub{color:var(--muted);margin-top:6px}
    .btn,.smallbtn{display:inline-block;border:0;border-radius:12px;background:var(--brand);color:#fff;padding:10px 14px;text-decoration:none;cursor:pointer}
    .smallbtn{padding:8px 10px;font-size:13px}.ghost{background:#8a7457}.danger{background:#8a3f1f}
    .flash{margin:0 0 18px;padding:12px 14px;border-radius:12px;background:var(--brand-soft);border:1px solid var(--line)}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 14px 38px rgba(0,0,0,.12)}
    h2{margin:0 0 12px;font-size:21px} h3{margin:16px 0 10px;font-size:16px}
    p,li{color:var(--muted)} code{background:var(--code);padding:2px 6px;border-radius:6px}
    table{width:100%;border-collapse:collapse;font-size:14px} th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
    input,select,textarea{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--text)}
    textarea{min-height:86px;resize:vertical} .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.muted{color:var(--muted);font-size:13px}.mono{font-family:Consolas,monospace}
    .qr{max-width:220px;border-radius:12px;border:1px solid var(--line);background:#fff;padding:10px}.split{display:grid;grid-template-columns:1.3fr .7fr;gap:16px}.list{margin:0;padding-left:18px}
    .guide{padding-left:18px;margin:0}.guide li{margin:6px 0}.help{margin:0;padding-left:18px}.help li{margin:6px 0}.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--code);font-size:12px;color:var(--muted)}
    .hint{padding:12px 14px;border-radius:12px;background:var(--code);color:var(--muted);font-size:13px}.warnbox{padding:12px 14px;border-radius:12px;background:var(--warn-soft);color:var(--warn);font-size:13px}
    .stack{display:grid;gap:10px}.sourcebox{padding:12px 14px;border-radius:12px;background:var(--code);color:var(--muted);font-size:13px}
    @media (max-width:880px){.split{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1 class="title">Meting Admin</h1>
        <div class="sub">统一查看 Kugou 双池、上游登录状态与 PM2 进程。当前入口属于 API 服务本体页面，不是独立后台站。</div>
      </div>
      <form method="post" action="${buildManageRoot(basePath)}/logout"><button class="ghost btn" type="submit">退出登录</button></form>
    </div>
    ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}
    <div class="grid">
      <section class="card" style="grid-column:1/-1">
        <h2>使用步骤</h2>
        <ol class="guide">
          ${operationGuide.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
        </ol>
        <div class="hint" style="margin-top:12px">公开监控页：<code>${escapeHtml(`${basePath}/manage/monitor`)}</code>；登录页：<code>${escapeHtml(`${basePath}/manage/login`)}</code>。按钮触发的操作都直接作用在当前 API 项目的 cookie 目录与 PM2 进程上。</div>
      </section>
      <section class="card">
        <h2>运行状态</h2>
        <div class="muted">这里只展示当前 API 进程与内置 upstream 进程。重启按钮会立即调用 PM2 执行对应操作。</div>
        <table><thead><tr><th>进程</th><th>状态</th><th>内存</th><th>操作</th></tr></thead><tbody>
          ${pm2.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.pm2_env?.status || '-')}</td><td>${Math.round((item.monit?.memory || 0) / 1024 / 1024)} MB</td><td><form method="post" action="${buildManageRoot(basePath)}/pm2"><input type="hidden" name="name" value="${escapeHtml(item.name)}"><input type="hidden" name="action" value="restart"><button class="smallbtn" type="submit">重启</button></form></td></tr>`).join('')}
        </tbody></table>
        <div class="actions">
          <form method="post" action="${buildManageRoot(basePath)}/pm2"><input type="hidden" name="name" value="meting-api"><input type="hidden" name="action" value="restart-update"><button class="smallbtn" type="submit">重载 Meting 环境</button></form>
          <form method="post" action="${buildManageRoot(basePath)}/pm2"><input type="hidden" name="name" value="kugou-upstream"><input type="hidden" name="action" value="restart-update"><button class="smallbtn" type="submit">重载 Upstream 环境</button></form>
        </div>
      </section>
      <section class="card">
        <h2>双号池</h2>
        <div class="muted">池状态来自 cookie/kugou-premium 和 cookie/kugou-general。如果 .env 仍设置了 METING_COOKIE_KUGOU*，运行时会优先读环境变量。</div>
        <table><thead><tr><th>池</th><th>已配置</th><th>User</th><th>Token</th><th>VIP</th></tr></thead><tbody>
          ${pools.map(item => `<tr><td>${item.pool}</td><td>${item.configured ? '是' : '否'}</td><td>${escapeHtml(item.userId || '-')}</td><td class="mono">${escapeHtml(item.token || '-')}</td><td>${escapeHtml(item.vipType || '-')}</td></tr>`).join('')}
        </tbody></table>
        <div class="muted">保留原来的 premium/general 双池逻辑。管理页登录成功后，可把新的上游登录态写回任意池文件。</div>
        <div class="stack" style="margin-top:12px">
          ${pools.map(item => `<div class="sourcebox"><strong>${escapeHtml(item.pool)}</strong><br>当前来源：${escapeHtml(item.source)}${item.activeKey ? ` (${escapeHtml(item.activeKey)})` : ''}<br>文件路径：${escapeHtml(item.filePath || '-')}<br>优先级：${escapeHtml((item.fallbackOrder || []).join(' -> ') || '-')}</div>`).join('')}
        </div>
        <h3>池文件操作</h3>
        <div class="warnbox">清空会直接删除对应池的 CK 文件；迁移会把源池移动到目标池；复制会保留源池。</div>
        <div class="actions">
          <form method="post" action="${buildManageRoot(basePath)}/pool/clear" onsubmit="return confirm('确认清空 premium 池？这会删除对应 CK 文件。')"><input type="hidden" name="pool" value="premium"><button class="danger smallbtn" type="submit">清空 premium</button></form>
          <form method="post" action="${buildManageRoot(basePath)}/pool/clear" onsubmit="return confirm('确认清空 general 池？这会删除对应 CK 文件。')"><input type="hidden" name="pool" value="general"><button class="danger smallbtn" type="submit">清空 general</button></form>
        </div>
        <form method="post" action="${buildManageRoot(basePath)}/pool/copy" style="margin-top:12px" onsubmit="return confirm('确认复制池？源池会保留，目标池将被覆盖。')">
          <div class="actions">
            <select name="fromPool"><option value="premium">premium</option><option value="general">general</option></select>
            <select name="toPool"><option value="general">general</option><option value="premium">premium</option></select>
            <button class="smallbtn" type="submit">复制到目标池</button>
          </div>
        </form>
        <form method="post" action="${buildManageRoot(basePath)}/pool/move" style="margin-top:10px" onsubmit="return confirm('确认迁移池？源池会被移动到目标池，源池原文件将消失。')">
          <div class="actions">
            <select name="fromPool"><option value="premium">premium</option><option value="general">general</option></select>
            <select name="toPool"><option value="general">general</option><option value="premium">premium</option></select>
            <button class="ghost smallbtn" type="submit">迁移到目标池</button>
          </div>
        </form>
      </section>
      <section class="card split" style="grid-column:1/-1">
        <div>
          <h2>Kugou 登录</h2>
          <p>当前上游启用方式：<code>${escapeHtml(upstreamPlatform || 'default')}</code>。根据 KuGouMusicApi 文档，登录支持密码、短信验证码、酷狗二维码、微信开放平台；其中密码登录文档明确标注“可能需要验证，不推荐”。更稳的是二维码登录或短信验证码登录。</p>
          <ul class="list">
            <li>当前部署是 platform=lite，也就是概念版链路</li>
            <li>刷新登录用 /login/token，不是永久登录</li>
            <li>登录成功后，页面可直接把会话写入 premium 或 general 池</li>
            <li>[Pasted ~4 lines] 表示这里的原始返回可能被 CLI 截断，不影响后台实际操作逻辑</li>
          </ul>
          <h3>按钮说明</h3>
          <ul class="help">
            ${buttonHelp.map(([label, desc]) => `<li><strong>${escapeHtml(label)}</strong>：${escapeHtml(desc)}</li>`).join('')}
          </ul>
          <div class="actions">
            <form method="post" action="${buildManageRoot(basePath)}/kugou/qr/start"><button class="btn" type="submit">生成酷狗二维码</button></form>
            <form method="post" action="${buildManageRoot(basePath)}/kugou/qr/check"><button class="ghost btn" type="submit">检查扫码状态</button></form>
            <form method="post" action="${buildManageRoot(basePath)}/kugou/refresh"><button class="smallbtn" type="submit">刷新 premium 登录态</button></form>
            <form method="post" action="${buildManageRoot(basePath)}/kugou/refresh"><input type="hidden" name="pool" value="general"><button class="smallbtn" type="submit">刷新 general 登录态</button></form>
          </div>
          ${profileSummary ? `<h3>当前账号概览</h3><table><tbody><tr><th>User ID</th><td>${escapeHtml(profileSummary.userId)}</td></tr><tr><th>昵称</th><td>${escapeHtml(profileSummary.nickname)}</td></tr><tr><th>当前池</th><td>${escapeHtml(profileSummary.poolOwner)}</td></tr><tr><th>VIP 类型</th><td>${escapeHtml(profileSummary.vipType)}</td></tr><tr><th>VIP 等级</th><td>${escapeHtml(profileSummary.vipLevel)}</td></tr><tr><th>到期时间</th><td>${escapeHtml(profileSummary.expiresAt)}</td></tr></tbody></table>` : '<div class="muted">尚未获取用户资料。</div>'}
          ${profile ? `<details><summary class="muted">查看原始账号数据</summary><pre class="mono">${escapeHtml(JSON.stringify(profile, null, 2))}</pre></details>` : ''}
          <h3>短信验证码登录</h3>
          <form method="post" action="${buildManageRoot(basePath)}/kugou/captcha/send">
            <label>手机号</label>
            <input name="mobile" placeholder="输入手机号" value="${escapeHtml(smsState?.mobile || '')}">
            <button class="smallbtn" type="submit">发送验证码</button>
          </form>
          <form method="post" action="${buildManageRoot(basePath)}/kugou/captcha/login" style="margin-top:10px">
            <label>验证码</label>
            <input name="code" placeholder="输入短信验证码">
            <label>写入池</label>
            <select name="pool"><option value="premium">premium</option><option value="general">general</option></select>
            <button class="btn" type="submit" style="margin-top:10px">验证码登录并写入</button>
          </form>
        </div>
        <div>
          ${loginState ? `<h3>二维码登录</h3><span class="badge">5 分钟内有效</span><img class="qr" src="${escapeHtml(loginState.base64)}" alt="qr"><p class="muted">扫码后点“检查扫码状态”。状态 key：${escapeHtml(loginState.key)}</p><form method="post" action="${buildManageRoot(basePath)}/kugou/qr/apply"><label>写入池</label><select name="pool"><option value="premium">premium</option><option value="general">general</option></select><button class="btn" type="submit" style="margin-top:10px">写入登录态</button></form>` : '<div class="muted">还没有生成二维码。</div>'}
        </div>
      </section>
      <section class="card" style="grid-column:1/-1">
        <h2>Kugou 监控</h2>
        <div class="muted">这里展示的就是公开监控页里的基础 JSON 内容，便于登录后继续比对。</div>
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
    const envPath = resolve(process.cwd(), 'KuGouMusicApi/.env')
    const content = await readFile(envPath, 'utf8')
    const line = content.split(/\r?\n/).find(item => item.startsWith('platform=')) || ''
    return line.slice('platform='.length).trim() || 'default'
  } catch (error) {
    return 'default'
  }
}

const ensureAuth = (c, basePath) => {
  if (!hasAdminPassword()) {
    return c.html('<h1>ADMIN_PASSWORD 未配置</h1>', 500)
  }
  if (!requireAdminAuth(c)) {
    return redirect(c, buildManageLogin(basePath))
  }
  return null
}

const getBasePath = (c) => {
  if (c.req.path.startsWith('/music/manage')) return '/music'
  if (c.req.path.startsWith('/api/manage')) return '/api'
  const prefix = c.req.path.replace(/\/(?:music|api)\/manage(?:\/login|\/monitor)?(?:\/.*)?$/, '')
  return prefix === '/' ? '' : prefix
}

const renderPublicInfoPage = ({ basePath, monitor }) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meting Monitor</title>
  <style>
    :root{--bg:#f5efe4;--bg2:#e5d6c2;--panel:rgba(255,250,242,.96);--line:#d8c9b5;--text:#2f261d;--muted:#6f6358;--brand:#24594f;--code:#f6ecdf}
    @media (prefers-color-scheme: dark){:root{--bg:#0d1418;--bg2:#152028;--panel:rgba(18,28,33,.96);--line:#2b3e47;--text:#ecf3f0;--muted:#b1c0bb;--brand:#4fae96;--code:#20313a}}
    body{margin:0;font-family:Georgia,serif;background:linear-gradient(135deg,var(--bg),var(--bg2));color:var(--text)}
    .wrap{max-width:980px;margin:0 auto;padding:24px}.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 14px 38px rgba(0,0,0,.12)}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px} .btn{border:0;border-radius:12px;background:var(--brand);color:#fff;padding:10px 14px;text-decoration:none}
    .hint{margin-bottom:16px;padding:12px 14px;border-radius:12px;background:var(--code);color:var(--muted)}
    pre{white-space:pre-wrap;word-break:break-word;background:var(--code);border-radius:12px;padding:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top"><div><h1>Meting Monitor</h1><p>未登录时只展示基础状态。</p></div><a class="btn" href="${buildManageLogin(basePath)}">后台登录</a></div>
    <div class="hint">如果你只想确认号池可用性，看这里就够了；需要二维码登录、短信验证码登录、清空/迁移池、PM2 重启等操作，再进入登录页。</div>
    <div class="card"><pre>${escapeHtml(JSON.stringify(monitor, null, 2))}</pre></div>
  </div>
</body>
</html>`

export default async (c) => {
  const basePath = getBasePath(c)

  if (c.req.method === 'GET' && c.req.path.endsWith('/login')) {
    return c.html(renderLoginPage({ message: consumeFlash(c), basePath }))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/login')) {
    const form = await getForm(c)
    if (!verifyAdminPassword(form.password || '')) {
      setFlash(c, '密码错误')
      return redirect(c, buildManageLogin(basePath))
    }
    setSessionCookie(c, createAdminSession())
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/logout')) {
    clearSessionCookie(c)
    return redirect(c, buildManageLogin(basePath))
  }

  if (c.req.method === 'GET' && c.req.path.endsWith('/manage/login') && requireAdminAuth(c)) {
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'GET' && (c.req.path.endsWith('/manage') || c.req.path.endsWith('/manage/monitor')) && !requireAdminAuth(c)) {
    const monitor = await readMonitorData()
    return c.html(renderPublicInfoPage({ basePath, monitor }))
  }

  const denied = ensureAuth(c, basePath)
  if (denied) return denied

  if (c.req.method === 'POST' && c.req.path.endsWith('/pm2')) {
    const form = await getForm(c)
    const args = form.action === 'restart-update'
      ? ['restart', form.name, '--update-env']
      : ['restart', form.name]
    const result = await runPm2(args)
    setFlash(c, result.ok ? `已执行 PM2 操作: ${form.name}` : `PM2 操作失败: ${result.stderr || result.stdout}`)
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/clear')) {
    const form = await getForm(c)
    const pool = form.pool === 'premium' ? 'premium' : 'general'
    try {
      await clearCookiePool(pool)
      setFlash(c, `${pool} 池已清空（删除对应 CK 文件）`)
    } catch (error) {
      setFlash(c, `清空 ${pool} 池失败：${error.message || '未知错误'}`)
    }
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/copy')) {
    const form = await getForm(c)
    const fromPool = form.fromPool === 'premium' ? 'premium' : 'general'
    const toPool = form.toPool === 'premium' ? 'premium' : 'general'
    if (fromPool === toPool) {
      setFlash(c, '复制失败：源池和目标池不能相同')
      return redirect(c, buildManageRoot(basePath))
    }
    try {
      await copyCookiePool(fromPool, toPool)
      setFlash(c, `已复制 ${fromPool} -> ${toPool}`)
    } catch (error) {
      setFlash(c, `复制失败：${error.message || '未知错误'}`)
    }
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/move')) {
    const form = await getForm(c)
    const fromPool = form.fromPool === 'premium' ? 'premium' : 'general'
    const toPool = form.toPool === 'premium' ? 'premium' : 'general'
    if (fromPool === toPool) {
      setFlash(c, '迁移失败：源池和目标池不能相同')
      return redirect(c, buildManageRoot(basePath))
    }
    try {
      await moveCookiePool(fromPool, toPool)
      setFlash(c, `已迁移 ${fromPool} -> ${toPool}`)
    } catch (error) {
      setFlash(c, `迁移失败：${error.message || '未知错误'}`)
    }
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/start')) {
    const login = await fetchKugouQrLogin()
    if (!login) {
      setFlash(c, '生成二维码失败')
      return redirect(c, buildManageRoot(basePath))
    }
    const device = await registerKugouDevice()
    setLoginState({ ...login, cookieMap: device?.cookieMap || {}, token: '', userid: '' })
    setFlash(c, '二维码已生成')
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/check')) {
    const state = getLoginState()
    if (!state) {
      setFlash(c, '请先生成二维码')
      return redirect(c, buildManageRoot(basePath))
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
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/apply')) {
    const state = getLoginState()
    const form = await getForm(c)
    if (!state || Number(state.status) !== 4) {
      setFlash(c, '登录尚未完成，不能写入池')
      return redirect(c, buildManageRoot(basePath))
    }

    const existingCookie = await readCookieFile('kugou', form.pool || 'premium')
    const mergedCookie = normalizeKugouCookieForMeting({
      existingCookie,
      upstreamCookie: Object.entries(state.cookieMap || {}).map(([key, value]) => `${key}=${value}`).join('; ')
    })
    await writeCookiePool(form.pool || 'premium', mergedCookie)
    setFlash(c, `已写入 ${form.pool || 'premium'} 池`)
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/refresh')) {
    const form = await getForm(c)
    const pool = form.pool || 'premium'
    const currentCookie = await readCookieFile('kugou', pool)
    if (!currentCookie) {
      setFlash(c, `${pool} 池没有可刷新的 Cookie`)
      return redirect(c, buildManageRoot(basePath))
    }
    const result = await refreshKugouLogin(currentCookie)
    const mergedCookie = normalizeKugouCookieForMeting({
      existingCookie: currentCookie,
      upstreamCookie: Object.entries(result.cookieMap || {}).map(([key, value]) => `${key}=${value}`).join('; ')
    })
    await writeCookiePool(pool, mergedCookie)
    setFlash(c, `${pool} 池登录态已刷新`)
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/send')) {
    const form = await getForm(c)
    if (!form.mobile) {
      setFlash(c, '请先输入手机号')
      return redirect(c, buildManageRoot(basePath))
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
    return redirect(c, buildManageRoot(basePath))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/login')) {
    const form = await getForm(c)
    const state = getSmsState()
    if (!state?.mobile || !form.code) {
      setFlash(c, '请先发送验证码并填写验证码')
      return redirect(c, buildManageRoot(basePath))
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
    return redirect(c, buildManageRoot(basePath))
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
