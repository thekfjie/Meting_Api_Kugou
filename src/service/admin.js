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
  applyKugouPoolCookieMap,
  claimAllKugouLiteVip,
  claimKugouLiteVip,
  getKugouPoolLabel,
  refreshKugouPool
} from '../utils/kugou-admin-actions.js'
import {
  getKugouAdminPoolState,
  getKugouAdminSession,
  getKugouAdminStatePath,
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
  listKugouPoolPlatforms,
  listKugouUpstreamProcessNames
} from '../utils/kugou-upstream-runtime.js'
import { getKugouUpstreamTrace } from '../utils/kugou-upstream-status.js'
import {
  getRequestSummaryLogPath,
  readRequestSummaries
} from '../utils/request-summary-log.js'
import kugouMonitorService from './kugou-monitor.js'

const execFileAsync = promisify(execFile)
const pm2Bin = process.env.PM2_BIN || (process.platform === 'win32' ? 'pm2.cmd' : 'pm2')
const fmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

const esc = (value = '') => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const txt = (value) => String(value || '').trim()
const normalizePool = (pool) => (pool === 'general' ? 'general' : 'premium')

const sourceLabel = (value) => {
  if (value === 'env') return '环境变量'
  if (value === 'file') return '文件池'
  return '未配置'
}

const upstreamLabel = (value) => {
  if (value === 'hit') return '命中 upstream'
  if (value === 'fallback-meting') return 'upstream 失败后回退'
  return '未命中 / 未尝试'
}

const qrLabel = (value) => ({
  0: '二维码已过期',
  1: '等待扫码',
  2: '已扫码，等待确认',
  4: '登录成功，可写入池'
}[Number(value || 0)] || `未知状态 ${value}`)

const platformLabel = (value) => (txt(value).toLowerCase() === 'lite' ? 'lite' : 'default')
const platformDisplayLabel = (value) => (platformLabel(value) === 'lite' ? 'Lite（概念版）' : 'Default（普通版）')

const time = (value) => {
  if (!value) return '暂无'
  try {
    return `${fmt.format(new Date(value))} (UTC+8)`
  } catch {
    return String(value)
  }
}

const resultText = (result) => (
  result
    ? `${result.ok ? '成功' : '失败'} / ${txt(result.message) || '-'} / ${time(result.at)}`
    : '暂无'
)

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

const qrState = async () => getKugouAdminSession('qrLogin')
const setQrState = async (value) => setKugouAdminSession('qrLogin', value ? { ...value, expiresAt: Date.now() + 5 * 60 * 1000 } : null)
const smsState = async () => getKugouAdminSession('smsLogin')
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
  const account = state.account || {}
  const platform = getKugouPoolPlatform(normalizedPool)

  return {
    pool: normalizedPool,
    label: getKugouPoolLabel(normalizedPool),
    platform,
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

const buildPlatformSummary = (pools) => pools.map(item => `${item.label}=${platformDisplayLabel(item.platform)}`).join(' / ')
const buildConfiguredPlatformSummary = () => listKugouPoolPlatforms().map(item => `${getKugouPoolLabel(item.pool)}=${platformDisplayLabel(item.platform)}`).join(' / ')

const quickReloadLabel = (name) => {
  if (name === 'meting-api') return '重载 API 环境'
  if (name === 'kugou-upstream') return '重载默认版 upstream'
  if (name === 'kugou-upstream-lite') return '重载 Lite upstream'
  return `重载 ${name}`
}

const themeScript = '<script>(function(){try{var t=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t)}catch(e){}})()</script>'
const toggleScript = '<script>(function(){const btn=document.getElementById("theme-toggle");const icon=document.getElementById("theme-icon");const getTheme=()=>document.documentElement.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");const updateIcon=(t)=>{if(icon)icon.innerHTML=t==="dark"?\'<path d="M12 3a6.364 6.364 0 0 0 9 9 9 9 0 1 1-9-9Z"/>\':\'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>\'};if(btn){updateIcon(getTheme());btn.addEventListener("click",()=>{const n=getTheme()==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",n);localStorage.setItem("theme",n);updateIcon(n)})}})()</script>'
const darkVars = '--bg: #09090b; --bg-card: #18181b; --text-main: #fafafa; --text-sub: #a1a1aa; --border: #27272a; --primary: #fafafa; --primary-hover: #e4e4e7; --primary-text: #09090b; --danger: #ef4444; --danger-hover: #f87171; --flash-bg: #14532d; --flash-text: #86efac; --flash-border: #166534; --warn-bg: #7f1d1d; --warn-text: #fca5a5; --warn-border: #991b1b; --hint-bg: #27272a; --hint-text: #d4d4d8; --ring: rgba(250, 250, 250, 0.2);'

const commonStyle = `
:root {
  --bg: #f8fafc;
  --bg-card: #ffffff;
  --text-main: #0f172a;
  --text-sub: #64748b;
  --border: #e2e8f0;
  --primary: #0f172a;
  --primary-hover: #334155;
  --primary-text: #ffffff;
  --danger: #ef4444;
  --danger-hover: #b91c1c;
  --flash-bg: #dcfce7;
  --flash-text: #166534;
  --flash-border: #bbf7d0;
  --warn-bg: #fef2f2;
  --warn-text: #991b1b;
  --warn-border: #fecaca;
  --hint-bg: #f1f5f9;
  --hint-text: #475569;
  --ring: rgba(15, 23, 42, 0.15);
  --radius: 16px;
  --font: "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
:root[data-theme="dark"] { ${darkVars} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${darkVars} } }
body { margin:0; background:var(--bg); color:var(--text-main); font:14px/1.6 var(--font); transition:background .3s,color .3s; -webkit-font-smoothing:antialiased; overflow-y:scroll; }
.wrap { max-width:1200px; margin:0 auto; padding:40px 24px; }
.card { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:24px; box-shadow:0 1px 3px rgba(0,0,0,.05); transition:transform .2s,box-shadow .2s; overflow:hidden; }
.card:hover { box-shadow:0 10px 40px -10px rgba(0,0,0,.08); }
h1,h2,h3 { margin:0 0 16px; font-weight:600; color:var(--text-main); letter-spacing:-0.02em; }
h1 { font-size:24px; }
h2 { font-size:18px; }
h3 { font-size:15px; margin-top:20px; }
.sub,.muted { color:var(--text-sub); font-size:13px; }
.flash,.warn,.hint { padding:12px 16px; border-radius:8px; margin-bottom:16px; font-size:13px; line-height:1.55; border:1px solid transparent; }
.flash { background:var(--flash-bg); color:var(--flash-text); border-color:var(--flash-border); }
.warn { background:var(--warn-bg); color:var(--warn-text); border-color:var(--warn-border); }
.hint { background:var(--hint-bg); color:var(--hint-text); }
button, .btn { border:none; border-radius:8px; padding:8px 16px; color:var(--primary-text); background:var(--primary); cursor:pointer; font-weight:500; font-size:13px; transition:all .2s; display:inline-flex; align-items:center; justify-content:center; text-decoration:none; box-sizing:border-box; }
button:hover, .btn:hover { background:var(--primary-hover); transform:translateY(-1px); }
button:active, .btn:active { transform:translateY(0); }
button:focus-visible, input:focus-visible, select:focus-visible { outline:none; box-shadow:0 0 0 3px var(--ring); }
button:disabled { opacity:.45; cursor:not-allowed; transform:none; }
.ghost { background:transparent; color:var(--text-main); border:1px solid var(--border); }
.ghost:hover { background:var(--hint-bg); color:var(--text-main); }
.danger { background:var(--danger); color:#fff; }
.danger:hover { background:var(--danger-hover); }
.theme-btn { border-radius:50%; padding:8px; width:36px; height:36px; display:inline-flex; align-items:center; justify-content:center; }
input, select { width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--text-main); box-sizing:border-box; font-family:inherit; font-size:14px; transition:border-color .2s,box-shadow .2s; }
input:focus, select:focus { outline:none; border-color:var(--primary); }
label { display:block; font-size:13px; font-weight:500; color:var(--text-main); margin:12px 0 6px; }
label:first-child { margin-top:0; }
code, pre { font-family:"JetBrains Mono", Consolas, monospace; font-size:13px; }
code { background:var(--hint-bg); padding:3px 6px; border-radius:4px; color:var(--text-main); word-break:break-all; }
pre { white-space:pre-wrap; word-break:break-word; background:var(--bg); padding:16px; border-radius:8px; border:1px solid var(--border); overflow-x:auto; color:var(--text-sub); }
.table-wrap { overflow-x:auto; margin-top:8px; }
`

const pageStyle = commonStyle + `
.top { display:flex; justify-content:space-between; align-items:center; margin-bottom:32px; gap:16px; }
.top-title { display:flex; flex-direction:column; gap:4px; }
.top-actions { display:flex; gap:12px; align-items:center; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(380px,1fr)); gap:24px; }
.full { grid-column:1/-1; }
table { width:100%; border-collapse:collapse; font-size:13px; min-width:600px; }
th,td { padding:12px 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:middle; white-space:nowrap; }
th { color:var(--text-sub); font-weight:500; font-size:12px; }
tr:last-child td { border-bottom:none; }
form { margin:0; }
.actions { display:flex; gap:12px; flex-wrap:wrap; margin-top:16px; }
.mini { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
.subcard { padding:16px; border-radius:12px; background:var(--bg); border:1px solid var(--border); }
.subcard strong { display:block; margin-bottom:8px; font-size:14px; color:var(--text-main); font-weight:600; }
.subcard div { color:var(--text-sub); font-size:13px; margin-bottom:4px; }
.qr { max-width:200px; border:1px solid var(--border); border-radius:12px; background:#fff; padding:12px; display:block; }
.split-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.split-actions form { display:flex; }
.split-actions button { width:100%; }
details { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px 16px; margin-top:16px; }
summary { cursor:pointer; font-weight:500; color:var(--text-main); user-select:none; }
.form-row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
.form-row > * { flex:1; min-width:160px; }
@media (max-width: 768px) {
  .wrap { padding:20px 16px; }
  .grid { grid-template-columns:1fr; gap:16px; }
  .top { flex-direction:column; align-items:flex-start; }
  .top-actions { width:100%; justify-content:space-between; }
  .card { padding:16px; border-radius:12px; box-sizing:border-box; }
  .actions { flex-direction:column; align-items:stretch; gap:12px; }
  .actions form { width:100%; display:flex; }
  .actions form button { width:100%; flex:1; justify-content:center; }
  .split-actions { grid-template-columns:1fr; }
  .form-row { flex-direction:column; align-items:stretch; }
  .form-row > * { width:100%; box-sizing:border-box; }
  .mini { grid-template-columns:1fr; gap:12px; }
  .qr { width:100%; max-width:none; box-sizing:border-box; }
}
`

const loginStyle = commonStyle + `
body { min-height:100vh; display:flex; align-items:center; justify-content:center; }
.card { width:min(400px, 90vw); padding:32px; box-sizing:border-box; }
input { margin:12px 0 24px; }
button { width:100%; padding:12px 16px; font-weight:600; }
.msg { padding:12px 16px; border-radius:8px; background:var(--warn-bg); color:var(--warn-text); margin-bottom:16px; border:1px solid var(--warn-border); font-size:13px; }
p { margin:16px 0 0; font-size:13px; color:var(--text-sub); }
`

const publicStyle = commonStyle + `
.header-row { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:32px; gap:16px; flex-wrap:wrap; }
.top-actions { display:flex; gap:12px; align-items:center; }
@media (max-width: 768px) {
  .wrap { padding:24px 16px; }
  .header-row { flex-direction:column; align-items:stretch; }
  .top-actions { width:100%; justify-content:space-between; }
  .card { padding:16px; border-radius:12px; }
}
`

const renderMonitorRefreshSection = (basePath, mon) => `
<section class="card full">
  <h2>探针控制</h2>
  <div class="hint">
    当前 VIP 探针缓存剩余：${esc(String(mon?.cacheRemainingSeconds ?? 0))} 秒
    <br>预计下次重新探测：${esc(time(mon?.nextCheckAt))}
    <br>默认采用约 5 分钟并带随机抖动的缓存窗口，避免过于频繁地重复探测。
  </div>
  <div class="actions">
    <form method="post" action="${root(basePath)}/kugou/status/refresh">
      <button type="submit">强制刷新 VIP 探针</button>
    </form>
  </div>
</section>`

const renderRequestLogsSection = (logs) => `
<section class="card full">
  <h2>最近请求摘要</h2>
  <div class="hint">
    这里只展示整理后的最近请求，不展示原始日志。
    <br>摘要文件：<code>${esc(getRequestSummaryLogPath())}</code>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>时间</th>
          <th>入口</th>
          <th>请求</th>
          <th>链路</th>
          <th>结果摘要</th>
        </tr>
      </thead>
      <tbody>
        ${logs.length
          ? logs.map(item => `<tr><td>${esc(time(item.at))}</td><td>${esc(item.path || '-')}</td><td>${esc([item.server, item.type, item.id].filter(Boolean).join(' / ') || '-')}</td><td>${esc([item.pool || '-', item.cache || '-', item.upstream || '-'].join(' / '))}</td><td>${esc((item.items || []).join(' | ') || '-')}</td></tr>`).join('')
          : '<tr><td colspan="5">暂无请求摘要</td></tr>'}
      </tbody>
    </table>
  </div>
</section>`

const page = ({
  flash,
  basePath,
  procs,
  pools,
  mon,
  qr,
  sms,
  platformSummary,
  trace,
  warnings,
  logs,
  quickProcessNames
}) => {
  const litePools = pools.filter(item => item.platform === 'lite')
  const autoClaimHint = litePools.length
    ? `当前 Lite 池：${litePools.map(item => item.label).join(' / ')}。这些池会按计划自动领取，也支持手动领取。`
    : '当前没有任何池配置为 Lite 平台；领取入口会保留，但不会执行。'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meting Kugou 管理页</title>
  <style>${pageStyle}</style>
  ${themeScript}
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="top-title">
        <h1>Meting Kugou 管理页</h1>
        <div class="sub">保持旧版简洁布局，同时兼容默认版与 Lite 双 upstream 运行。</div>
      </div>
      <div class="top-actions">
        <button id="theme-toggle" class="ghost theme-btn" aria-label="切换主题">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" id="theme-icon"></svg>
        </button>
        <form method="post" action="${root(basePath)}/logout">
          <button class="ghost" type="submit">退出登录</button>
        </form>
      </div>
    </div>
    ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
    ${warnings.map(item => `<div class="warn">${esc(item)}</div>`).join('')}
    <div class="grid">
      <section class="card">
        <h2>运行状态</h2>
        <div class="hint">
          当前池平台：<strong>${esc(platformSummary)}</strong>
          <br>最近 upstream：<strong>${esc(upstreamLabel(trace?.status))}</strong>
          <br>最近记录时间：${esc(time(trace?.at))}
          <br>最近类型 / 池：${esc(trace?.type || '-')} / ${esc(trace?.pool || '-')}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>进程</th>
                <th>状态</th>
                <th>内存</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${procs.length
                ? procs.map(item => `<tr><td>${esc(item.name)}</td><td>${esc(item.pm2_env?.status || '-')}</td><td>${Math.round((item.monit?.memory || 0) / 1024 / 1024)} MB</td><td><form method="post" action="${root(basePath)}/pm2"><input type="hidden" name="name" value="${esc(item.name)}"><input type="hidden" name="action" value="restart"><button type="submit">重启</button></form></td></tr>`).join('')
                : '<tr><td colspan="4">未读取到 PM2 进程信息，请确认服务器上的 <code>pm2</code> 可用。</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="actions">
          ${quickProcessNames.map(name => `<form method="post" action="${root(basePath)}/pm2"><input type="hidden" name="name" value="${esc(name)}"><input type="hidden" name="action" value="restart-update"><button class="ghost" type="submit">${esc(quickReloadLabel(name))}</button></form>`).join('')}
        </div>
      </section>
      <section class="card">
        <h2>平台与 Cookie 来源</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>池</th>
                <th>平台</th>
                <th>实际来源</th>
                <th>进程</th>
                <th>文件路径</th>
              </tr>
            </thead>
            <tbody>
              ${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(platformDisplayLabel(item.platform))}</td><td>${esc(sourceLabel(item.sourceInfo.source))}</td><td>${esc(item.processName || '-')}</td><td><code>${esc(item.filePath || '-')}</code></td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${pools.flatMap(item => item.warnings.map(message => `<div class="warn" style="margin-top:16px">${esc(item.label)}：${esc(message)}</div>`)).join('')}
      </section>
      <section class="card full">
        <h2>账号信息</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>账号池</th>
                <th>平台</th>
                <th>用户 ID</th>
                <th>昵称</th>
                <th>VIP 类型</th>
                <th>到期时间</th>
                <th>下次自动刷新</th>
                <th>下次自动领取</th>
              </tr>
            </thead>
            <tbody>
              ${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(platformDisplayLabel(item.platform))}</td><td>${esc(item.userId || '-')}</td><td>${esc(item.nickname || '-')}</td><td>${esc(item.vipType || '-')}</td><td>${esc(item.expireTime || '-')}</td><td>${esc(time(item.state?.nextRefreshAt))}</td><td>${esc(time(item.state?.nextClaimAt))}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="mini" style="margin-top:16px">
          ${pools.map(item => `<div class="subcard"><strong>${esc(item.label)}</strong><div>Token：${esc(item.token || '-')}</div><div>DFID：${esc(item.dfid || '-')}</div><div>MID：${esc(item.mid || '-')}</div><div>上游：<code>${esc(item.upstreamUrl || '-')}</code></div><div>最近资料同步：${esc(time(item.state?.lastProfileAt))}</div></div>`).join('')}
        </div>
      </section>
      <section class="card">
        <h2>二维码 / 短信登录</h2>
        <div class="hint">临时登录状态会持久化到 <code>${esc(getKugouAdminStatePath())}</code>，避免进程重启后丢失。</div>
        <h3>二维码登录</h3>
        <div class="split-actions">
          <form method="post" action="${root(basePath)}/kugou/qr/start">
            <input type="hidden" name="pool" value="premium">
            <button type="submit">为专业池生成二维码</button>
          </form>
          <form method="post" action="${root(basePath)}/kugou/qr/start">
            <input type="hidden" name="pool" value="general">
            <button class="ghost" type="submit">为普通池生成二维码</button>
          </form>
        </div>
        <div class="actions">
          <form method="post" action="${root(basePath)}/kugou/qr/check">
            <button class="ghost" type="submit">检查二维码状态</button>
          </form>
        </div>
        ${qr
          ? `<div style="margin-top:16px"><div class="hint">当前二维码池：<strong>${esc(getKugouPoolLabel(qr.pool || 'premium'))}</strong><br>状态：${esc(qrLabel(qr.status))}<br>过期时间：${esc(time(qr.expiresAt))}</div>${qr.base64 ? `<img class="qr" src="${esc(qr.base64)}" alt="qr">` : ''}<form method="post" action="${root(basePath)}/kugou/qr/apply" style="margin-top:16px"><button type="submit">写入${esc(getKugouPoolLabel(qr.pool || 'premium'))}</button></form></div>`
          : '<div class="muted" style="margin-top:16px">当前没有待写入的二维码会话。</div>'}
        <h3>短信验证登录</h3>
        <form method="post" action="${root(basePath)}/kugou/captcha/send">
          <label>手机号</label>
          <input name="mobile" placeholder="请输入手机号" value="${esc(sms?.mobile || '')}">
          <label>目标账号池</label>
          <select name="pool">
            <option value="premium">专业池</option>
            <option value="general"${sms?.pool === 'general' ? ' selected' : ''}>普通池</option>
          </select>
          <button class="ghost" type="submit" style="margin-top:12px">发送验证码</button>
        </form>
        <form method="post" action="${root(basePath)}/kugou/captcha/login" style="margin-top:16px">
          <label>短信验证码</label>
          <input name="code" placeholder="输入 6 位验证码">
          ${sms?.pool ? `<div class="hint" style="margin-top:12px">当前短信会话池：<strong>${esc(getKugouPoolLabel(sms.pool))}</strong>。登录后会直接写入这个池，避免串号。</div>` : '<div class="hint" style="margin-top:12px">请先发送验证码，再完成登录写入。</div>'}
          <button type="submit" style="margin-top:12px">登录并写入池</button>
        </form>
      </section>
      <section class="card">
        <h2>登录态刷新</h2>
        <div class="hint">自动 refresh 已启用，后台会按随机时间计划执行；这里保留强制手动刷新。</div>
        <div class="actions">
          <form method="post" action="${root(basePath)}/kugou/refresh">
            <input type="hidden" name="pool" value="premium">
            <button type="submit">刷新专业池</button>
          </form>
          <form method="post" action="${root(basePath)}/kugou/refresh">
            <input type="hidden" name="pool" value="general">
            <button class="ghost" type="submit">刷新普通池</button>
          </form>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>池分区</th>
                <th>上次刷新</th>
                <th>刷新结果</th>
              </tr>
            </thead>
            <tbody>
              ${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(time(item.state?.lastRefreshAt))}</td><td>${esc(resultText(item.state?.lastRefreshResult))}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card full">
        <h2>Lite 会员领取</h2>
        <div class="hint">${esc(autoClaimHint)}<br>只会对 Lite 池执行领取；普通版池会直接跳过。</div>
        <div class="actions">
          ${pools.map(item => `<form method="post" action="${root(basePath)}/kugou/vip/claim"><input type="hidden" name="pool" value="${esc(item.pool)}"><button type="submit"${item.platform === 'lite' ? '' : ' disabled'} class="${item.pool === 'general' ? 'ghost' : ''}">领取${esc(item.label)} Lite 会员</button></form>`).join('')}
          <form method="post" action="${root(basePath)}/kugou/vip/claim-all">
            <button class="danger" type="submit"${litePools.length ? '' : ' disabled'}>批量执行</button>
          </form>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>池分区</th>
                <th>平台</th>
                <th>上次领取</th>
                <th>领取结果</th>
              </tr>
            </thead>
            <tbody>
              ${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(platformDisplayLabel(item.platform))}</td><td>${esc(time(item.state?.lastClaimAt))}</td><td>${esc(resultText(item.state?.lastClaimResult))}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>池文件操作</h2>
        <div class="hint">以下操作仅影响本地文件池配置，不会覆盖环境变量等更高优先级配置。</div>
        <div class="actions">
          <form method="post" action="${root(basePath)}/pool/clear">
            <input type="hidden" name="pool" value="premium">
            <button class="danger" type="submit">清空专业池文件</button>
          </form>
          <form method="post" action="${root(basePath)}/pool/clear">
            <input type="hidden" name="pool" value="general">
            <button class="danger" type="submit">清空普通池文件</button>
          </form>
        </div>
        <form method="post" action="${root(basePath)}/pool/copy" style="margin-top:24px">
          <label>复制配置</label>
          <div class="form-row">
            <select name="fromPool">
              <option value="premium">从专业池</option>
              <option value="general">从普通池</option>
            </select>
            <select name="toPool">
              <option value="general">到普通池</option>
              <option value="premium">到专业池</option>
            </select>
            <button type="submit">执行复制</button>
          </div>
        </form>
        <form method="post" action="${root(basePath)}/pool/move" style="margin-top:24px">
          <label>迁移配置</label>
          <div class="form-row">
            <select name="fromPool">
              <option value="premium">从专业池</option>
              <option value="general">从普通池</option>
            </select>
            <select name="toPool">
              <option value="general">到普通池</option>
              <option value="premium">到专业池</option>
            </select>
            <button class="ghost" type="submit">执行迁移</button>
          </div>
        </form>
      </section>
      <section class="card">
        <h2>监控状态</h2>
        <div class="hint">
          最新探测：${esc(time(mon?.checkedAt))}
          <br>缓存有效期：${esc(String(mon?.ttlSeconds || 0))} 秒
          <br>分钟剩余额度：${esc(String(mon?.summary?.remainingMinute ?? 0))}
        </div>
        <div class="mini" style="margin-top:16px">
          ${[{ key: 'pro', title: '专业池探针' }, { key: 'normal', title: '普通池探针' }, { key: 'internal', title: '游客池探针' }].map(({ key, title }) => {
            const detail = mon?.pools?.[key] || {}
            const diagnostics = detail.diagnostics || {}
            return `<div class="subcard"><strong>${esc(title)}</strong><div>状态：${esc(detail.label || '-')}</div><div>说明：${esc(detail.detail || '-')}</div><div>基础探活：${esc(diagnostics.basicProbe || '-')}</div><div>VIP 探针：${esc(diagnostics.vipState || '-')}</div><div>最后请求：${esc(time(detail.lastRequestAt))}</div></div>`
          }).join('')}
        </div>
      </section>
      ${renderMonitorRefreshSection(basePath, mon)}
      ${renderRequestLogsSection(logs)}
      <section class="card full">
        <h2>调试信息</h2>
        <details>
          <summary>展开查看运行时状态数据</summary>
          <div class="mini" style="margin-top:16px">
            <div><h3>上游链路</h3><pre>${esc(JSON.stringify(trace || null, null, 2))}</pre></div>
            <div><h3>账号池状态</h3><pre>${esc(JSON.stringify(pools, null, 2))}</pre></div>
            <div><h3>监控快照</h3><pre>${esc(JSON.stringify(mon, null, 2))}</pre></div>
            <div><h3>状态文件</h3><pre>${esc(getKugouAdminStatePath())}</pre></div>
          </div>
        </details>
      </section>
    </div>
  </div>
  ${toggleScript}
</body>
</html>`
}

const loginPage = ({ message = '', basePath = '/music' }) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>系统登录 - Meting</title>
  <style>${loginStyle}</style>
  ${themeScript}
</head>
<body style="position:relative">
  <div style="position:absolute; top:24px; right:24px;">
    <button id="theme-toggle" class="ghost theme-btn" aria-label="切换主题">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" id="theme-icon"></svg>
    </button>
  </div>
  <form class="card" method="post" action="${loginPath(basePath)}">
    <h1>系统访问验证</h1>
    <p style="margin-bottom:24px;">验证管理员密码后进入管理页。</p>
    ${message ? `<div class="msg">${esc(message)}</div>` : ''}
    <label>安全密码</label>
    <input type="password" name="password" placeholder="请输入密码">
    <button type="submit">登录系统</button>
    <p>公开监控页：<a href="${esc(`${basePath}/manage/monitor`)}" style="color:var(--primary);text-decoration:none;font-weight:500;">/manage/monitor</a></p>
  </form>
  ${toggleScript}
</body>
</html>`

const publicPage = ({ basePath, mon, platformSummary, trace }) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meting 公共状态展示</title>
  <style>${publicStyle}</style>
  ${themeScript}
</head>
<body>
  <div class="wrap">
    <div class="header-row">
      <div>
        <h1>网络与服务状态矩阵</h1>
        <div class="hint" style="margin:0;">
          当前池平台：<strong>${esc(platformSummary)}</strong>
          <br>上游链路：<strong>${esc(upstreamLabel(trace?.status))}</strong>
          <br>最后更新：${esc(time(trace?.at))}
        </div>
      </div>
      <div class="top-actions">
        <button id="theme-toggle" class="ghost theme-btn" aria-label="切换主题">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" id="theme-icon"></svg>
        </button>
        <a class="btn" href="${loginPath(basePath)}">进入管理控制台</a>
      </div>
    </div>
    <div class="card">
      <pre>${esc(JSON.stringify(mon, null, 2))}</pre>
    </div>
  </div>
  ${toggleScript}
</body>
</html>`

export default async (c) => {
  const basePath = getBasePath(c)

  if (c.req.method === 'GET' && c.req.path.endsWith('/login')) {
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

  if (c.req.method === 'GET' && c.req.path.endsWith('/manage/login') && requireAdminAuth(c)) {
    return redirect(c, root(basePath))
  }

  if (c.req.method === 'GET' && (c.req.path.endsWith('/manage') || c.req.path.endsWith('/manage/monitor')) && !requireAdminAuth(c)) {
    const mon = await monitor()
    return c.html(publicPage({
      basePath,
      mon,
      platformSummary: buildConfiguredPlatformSummary(),
      trace: getKugouUpstreamTrace()
    }))
  }

  const denied = needAuth(c, basePath)
  if (denied) return denied

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
    const login = await fetchKugouQrLogin(pool)
    if (!login) {
      return respond(c, basePath, { ok: false, pool }, '生成二维码失败')
    }
    const device = await registerKugouDevice(pool)
    await setQrState({ ...login, pool, cookieMap: device?.cookieMap || {}, status: 1 })
    return respond(c, basePath, { ok: true, pool, login }, `${getKugouPoolLabel(pool)}二维码已生成`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/check')) {
    const state = await qrState()
    if (!state) {
      return respond(c, basePath, { ok: false }, '请先生成二维码')
    }
    const pool = normalizePool(state.pool)
    const result = await checkKugouQrLogin(state.key, pool)
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
    const state = await qrState()
    if (!state || Number(state.status) !== 4) {
      return respond(c, basePath, { ok: false }, '二维码登录尚未完成，不能写入池')
    }
    const pool = normalizePool(state.pool)
    const result = await applyKugouPoolCookieMap(pool, state.cookieMap || {}, { trigger: 'qr-login' })
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
    const state = await smsState()
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
    const applied = await applyKugouPoolCookieMap(pool, result.cookieMap || {}, { trigger: 'sms-login' })
    return respond(c, basePath, applied, applied.message)
  }

  const flash = consumeFlash(c)
  const [procs, premium, general, mon, qr, sms, logs] = await Promise.all([
    pm2Status(),
    poolView('premium'),
    poolView('general'),
    monitor(),
    qrState(),
    smsState(),
    readRequestSummaries(30)
  ])

  const pools = [premium, general]
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
    qr,
    sms,
    platformSummary: buildPlatformSummary(pools),
    trace: getKugouUpstreamTrace(),
    warnings,
    logs,
    quickProcessNames: ['meting-api', ...listKugouUpstreamProcessNames()]
  }))
}
