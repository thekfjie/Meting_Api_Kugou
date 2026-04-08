import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
  ensureKugouPoolFresh,
  getKugouPoolLabel,
  refreshKugouPool,
  syncKugouPoolProfile
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
import { getKugouUpstreamTrace } from '../utils/kugou-upstream-status.js'
import {
  getRequestSummaryLogPath,
  readRequestSummaries
} from '../utils/request-summary-log.js'
import kugouMonitorService from './kugou-monitor.js'

const execFileAsync = promisify(execFile)
const pm2Bin = process.env.PM2_BIN || (process.platform === 'win32' ? 'pm2.cmd' : 'pm2')
const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const esc = (v = '') => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const txt = (v) => String(v || '').trim()
const time = (v) => { if (!v) return '暂无'; try { return `${fmt.format(new Date(v))} (UTC+8)` } catch { return String(v) } }
const sourceLabel = (v) => v === 'env' ? '环境变量' : (v === 'file' ? '文件池' : '未配置')
const upstreamLabel = (v) => v === 'hit' ? '命中 upstream' : (v === 'fallback-meting' ? 'upstream 失败后回退' : '未命中 / 未尝试')
const qrLabel = (v) => ({ 0: '二维码已过期', 1: '等待扫码', 2: '已扫码等待确认', 4: '登录成功，可写入池' }[Number(v || 0)] || `未知状态 ${v}`)
const platformLabel = (v) => txt(v).toLowerCase() || 'default'
const root = (base) => `${base}/manage`
const loginPath = (base) => `${root(base)}/login`
const wantsJson = (c) => c.req.query('format') === 'json' || (String(c.req.header('accept') || '').toLowerCase().includes('application/json') && !String(c.req.header('accept') || '').toLowerCase().includes('text/html'))
const getBasePath = (c) => {
  const path = c.req.path
  const musicIndex = path.indexOf('/music/manage')
  if (musicIndex !== -1) return path.slice(0, musicIndex) + '/music'
  const apiIndex = path.indexOf('/api/manage')
  if (apiIndex !== -1) return path.slice(0, apiIndex) + '/api'
  return ''
}
const flashCookie = 'meting_admin_flash'

const redirect = (c, location) => { c.header('Location', location); return c.body(null, 302) }
const getForm = async (c) => { const body = await c.req.parseBody(); return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v)])) }
const getCookie = (c, name) => { const raw = c.req.header('cookie') || ''; for (const part of raw.split(';')) { const item = part.trim(); const idx = item.indexOf('='); if (idx !== -1 && item.slice(0, idx).trim() === name) return item.slice(idx + 1).trim() } return '' }
const setFlash = (c, message) => c.header('Set-Cookie', `${flashCookie}=${encodeURIComponent(message)}; Path=/; SameSite=Lax`)
const consumeFlash = (c) => { const value = getCookie(c, flashCookie); if (value) c.header('Set-Cookie', `${flashCookie}=; Path=/; SameSite=Lax; Max-Age=0`); return value ? decodeURIComponent(value) : '' }
const respond = (c, basePath, payload, message = '') => wantsJson(c) ? c.json(payload) : (message && setFlash(c, message), redirect(c, root(basePath)))
const needAuth = (c, basePath) => { if (!hasAdminPassword()) return c.html('<h1>ADMIN_PASSWORD 未配置</h1>', 500); if (!requireAdminAuth(c)) return redirect(c, loginPath(basePath)); return null }

const pm2 = async (args) => {
  try {
    const cmd = process.platform === 'win32' ? { file: 'cmd.exe', args: ['/c', pm2Bin, ...args], opts: { windowsHide: true } } : { file: pm2Bin, args, opts: {} }
    const result = await execFileAsync(cmd.file, cmd.args, cmd.opts)
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
  } catch (error) {
    return { ok: false, stdout: error.stdout || '', stderr: error.stderr || error.message || 'pm2 failed' }
  }
}

const pm2Status = async () => {
  const result = await pm2(['jlist'])
  if (!result.ok) return []
  try { return JSON.parse(result.stdout) } catch { return [] }
}

const monitor = async (force = false) => {
  const headers = new Headers()
  return kugouMonitorService({
    req: { query: () => (force ? { refresh: '1' } : {}) },
    header: (n, v) => headers.set(n, v),
    json: (payload) => payload
  })
}

const upstreamPlatform = async () => {
  try {
    const content = await readFile(resolve(process.cwd(), 'KuGouMusicApi/.env'), 'utf8')
    const line = content.split(/\r?\n/).find(item => item.trim().startsWith('platform=')) || ''
    return line.split('=').slice(1).join('=').trim() || 'default'
  } catch { return 'default' }
}

const qrState = async () => getKugouAdminSession('qrLogin')
const setQrState = async (v) => setKugouAdminSession('qrLogin', v ? { ...v, expiresAt: Date.now() + 5 * 60 * 1000 } : null)
const smsState = async () => getKugouAdminSession('smsLogin')
const setSms = async (v) => setKugouAdminSession('smsLogin', v ? { ...v, expiresAt: Date.now() + 10 * 60 * 1000 } : null)

const poolView = async (pool) => {
  const [activeCookie, fileCookie, sourceInfo, state] = await Promise.all([
    readCookieFile('kugou', pool),
    readCookiePoolFile('kugou', pool),
    inspectCookieSource('kugou', pool),
    getKugouAdminPoolState(pool)
  ])
  const active = parseSimpleCookie(activeCookie)
  const file = parseSimpleCookie(fileCookie)
  const account = state.account || {}
  return {
    pool,
    label: getKugouPoolLabel(pool),
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
    warnings: sourceInfo.source === 'env' ? ['当前运行时优先使用环境变量，文件池写入不会立刻生效；如需使用后台写入的概念版 CK，请先移除环境变量覆盖。'] : []
  }
}

const resultText = (r) => r ? `${r.ok ? '成功' : '失败'} / ${txt(r.message) || '-'} / ${time(r.at)}` : '暂无'

const renderMonitorRefreshSection = (basePath, mon) => `
<section class="card full">
  <h2>探针控制</h2>
  <div class="hint">
    当前 VIP 探针缓存剩余：${esc(String(mon?.cacheRemainingSeconds ?? 0))} 秒
    <br>预计下次重新探测：${esc(time(mon?.nextCheckAt))}
    <br>现在改成固定约 5 分钟并带随机抖动，不再按很短周期重复探测。
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
</section>`

const page = ({ flash, basePath, procs, pools, mon, qr, sms, platform, trace, warnings, logs }) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Meting Kugou 管理页</title><style>
body{margin:0;background:#f5efe6;color:#261d15;font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif} .wrap{max-width:1220px;margin:0 auto;padding:24px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:16px} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{background:#fffaf5;border:1px solid #dcc8b0;border-radius:18px;padding:16px;box-shadow:0 10px 28px rgba(0,0,0,.08)} .full{grid-column:1/-1}
h1,h2,h3{margin:0 0 10px} .sub,.muted{color:#6e5d4c} .flash,.warn,.hint{padding:12px 14px;border-radius:12px;margin-bottom:12px}
.flash{background:#e8f3ef;border:1px solid #c9ded7}.warn{background:#f9e8df;color:#8a3f1b}.hint{background:#f5ece0;color:#6e5d4c}
table{width:100%;border-collapse:collapse;font-size:13px} th,td{padding:8px 6px;border-bottom:1px solid #e4d5c4;text-align:left;vertical-align:top}
form{margin:0} .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px} button{border:0;border-radius:12px;padding:10px 14px;color:#fff;background:#245c51;cursor:pointer;font-weight:600}
.ghost{background:#8a6336}.danger{background:#9a4220} input,select{width:100%;padding:10px 12px;border:1px solid #dcc8b0;border-radius:12px;background:#fff;box-sizing:border-box}
.mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.subcard{padding:12px;border-radius:12px;background:#f5ece0;color:#6e5d4c}
code,pre{font-family:Consolas,monospace} pre{white-space:pre-wrap;word-break:break-word;background:#f9f3eb;padding:12px;border-radius:12px} .qr{max-width:220px;border:1px solid #dcc8b0;border-radius:12px;background:#fff;padding:10px}
</style></head><body><div class="wrap">
<div class="top"><div><h1>Meting Kugou 管理页</h1><div class="sub">先解决可观测性，再做刷新和一键领取。这里只做按需触发，不做 cron。</div></div><form method="post" action="${root(basePath)}/logout"><button class="ghost" type="submit">退出登录</button></form></div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${warnings.map(item => `<div class="warn">${esc(item)}</div>`).join('')}
<div class="grid">
<section class="card"><h2>运行状态</h2><div class="hint">当前 platform：<strong>${esc(platformLabel(platform))}</strong><br>最近 upstream：<strong>${esc(upstreamLabel(trace?.status))}</strong><br>最近记录时间：${esc(time(trace?.at))}<br>最近类型 / 池：${esc(trace?.type || '-')} / ${esc(trace?.pool || '-')}</div><table><thead><tr><th>进程</th><th>状态</th><th>内存</th><th>操作</th></tr></thead><tbody>${procs.length ? procs.map(item => `<tr><td>${esc(item.name)}</td><td>${esc(item.pm2_env?.status || '-')}</td><td>${Math.round((item.monit?.memory || 0) / 1024 / 1024)} MB</td><td><form method="post" action="${root(basePath)}/pm2"><input type="hidden" name="name" value="${esc(item.name)}"><input type="hidden" name="action" value="restart"><button type="submit">重启</button></form></td></tr>`).join('') : '<tr><td colspan="4">未读取到 PM2 进程信息，请确认 Linux 服务器上 `pm2` 在 PATH 中可用。</td></tr>'}</tbody></table><div class="actions"><form method="post" action="${root(basePath)}/pm2"><input type="hidden" name="name" value="meting-api"><input type="hidden" name="action" value="restart-update"><button class="ghost" type="submit">重载 Meting 环境</button></form><form method="post" action="${root(basePath)}/pm2"><input type="hidden" name="name" value="kugou-upstream"><input type="hidden" name="action" value="restart-update"><button class="ghost" type="submit">重载 Upstream 环境</button></form></div></section>
<section class="card"><h2>当前平台与 Cookie 来源</h2><table><thead><tr><th>池</th><th>实际来源</th><th>生效标识</th><th>文件池</th><th>文件路径</th></tr></thead><tbody>${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(sourceLabel(item.sourceInfo.source))}</td><td>${esc(item.sourceInfo.activeKey || '-')}</td><td>${item.fileConfigured ? '已写入' : '空'}</td><td>${esc(item.filePath || '-')}</td></tr>`).join('')}</tbody></table>${pools.flatMap(item => item.warnings.map(message => `<div class="warn" style="margin-top:10px">${esc(item.label)}：${esc(message)}</div>`)).join('')}</section>
<section class="card full"><h2>账号信息</h2><table><thead><tr><th>池</th><th>User ID</th><th>昵称</th><th>VIP 类型</th><th>到期时间</th><th>最近 refresh</th><th>最近 claim</th><th>最近错误</th></tr></thead><tbody>${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(item.userId || '-')}</td><td>${esc(item.nickname || '-')}</td><td>${esc(item.vipType || '-')}</td><td>${esc(item.expireTime || '-')}</td><td>${esc(resultText(item.state?.lastRefreshResult))}</td><td>${esc(resultText(item.state?.lastClaimResult))}</td><td>${esc(item.state?.lastError?.message || '-')}</td></tr>`).join('')}</tbody></table><div class="mini" style="margin-top:10px">${pools.map(item => `<div class="subcard"><strong>${esc(item.label)}</strong><div>Token：${esc(item.token || '-')}</div><div>DFID：${esc(item.dfid || '-')}</div><div>MID：${esc(item.mid || '-')}</div><div>最近资料同步：${esc(time(item.state?.lastProfileAt))}</div></div>`).join('')}</div></section>
<section class="card"><h2>二维码登录 / 短信登录</h2><div class="hint">二维码和短信状态已落盘到 <code>${esc(getKugouAdminStatePath())}</code>，进程重启后不会直接丢。</div><h3>二维码登录</h3><div class="actions"><form method="post" action="${root(basePath)}/kugou/qr/start"><button type="submit">生成二维码</button></form><form method="post" action="${root(basePath)}/kugou/qr/check"><button class="ghost" type="submit">检查扫码状态</button></form></div>${qr ? `<div style="margin-top:10px"><div class="hint">${esc(qrLabel(qr.status))}<br>过期时间：${esc(time(qr.expiresAt))}</div>${qr.base64 ? `<img class="qr" src="${esc(qr.base64)}" alt="qr">` : ''}<form method="post" action="${root(basePath)}/kugou/qr/apply" style="margin-top:10px"><label>写入到</label><select name="pool"><option value="premium">专业池</option><option value="general">普通池</option></select><button type="submit" style="margin-top:10px">写入登录态</button></form></div>` : '<div class="muted">当前没有待使用的二维码会话。</div>'}<h3 style="margin-top:14px">短信登录</h3><form method="post" action="${root(basePath)}/kugou/captcha/send"><label>手机号</label><input name="mobile" placeholder="输入手机号" value="${esc(sms?.mobile || '')}"><button class="ghost" type="submit" style="margin-top:10px">发送验证码</button></form><form method="post" action="${root(basePath)}/kugou/captcha/login" style="margin-top:10px"><label>验证码</label><input name="code" placeholder="输入短信验证码"><label style="display:block;margin-top:10px">写入到</label><select name="pool"><option value="premium">专业池</option><option value="general">普通池</option></select><button type="submit" style="margin-top:10px">验证码登录并写入</button></form></section>
<section class="card"><h2>登录态刷新</h2><div class="hint">打开页面时会按懒刷新策略自动 refresh；这里只保留手动刷新按钮。</div><div class="actions"><form method="post" action="${root(basePath)}/kugou/refresh"><input type="hidden" name="pool" value="premium"><button type="submit">刷新专业池</button></form><form method="post" action="${root(basePath)}/kugou/refresh"><input type="hidden" name="pool" value="general"><button class="ghost" type="submit">刷新普通池</button></form></div><table style="margin-top:10px"><thead><tr><th>池</th><th>上次 refresh</th><th>结果</th></tr></thead><tbody>${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(time(item.state?.lastRefreshAt))}</td><td>${esc(resultText(item.state?.lastRefreshResult))}</td></tr>`).join('')}</tbody></table></section>
<section class="card full"><h2>领取概念版会员</h2><div class="hint">这里只做“一键领取 + 懒刷新登录态”。手动接口触发时，在 URL 后面加 <code>?format=json</code> 可直接拿 JSON。</div><div class="actions"><form method="post" action="${root(basePath)}/kugou/vip/claim"><input type="hidden" name="pool" value="premium"><button type="submit">领取专业池 Lite VIP</button></form><form method="post" action="${root(basePath)}/kugou/vip/claim"><input type="hidden" name="pool" value="general"><button class="ghost" type="submit">领取普通池 Lite VIP</button></form><form method="post" action="${root(basePath)}/kugou/vip/claim-all"><button class="danger" type="submit">两个池都执行</button></form></div><table style="margin-top:10px"><thead><tr><th>池</th><th>上次 claim</th><th>结果</th></tr></thead><tbody>${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(time(item.state?.lastClaimAt))}</td><td>${esc(resultText(item.state?.lastClaimResult))}</td></tr>`).join('')}</tbody></table></section>
<section class="card"><h2>池文件操作</h2><div class="hint">这里只影响文件池，不会自动清理环境变量覆盖。</div><div class="actions"><form method="post" action="${root(basePath)}/pool/clear"><input type="hidden" name="pool" value="premium"><button class="danger" type="submit">清空专业池</button></form><form method="post" action="${root(basePath)}/pool/clear"><input type="hidden" name="pool" value="general"><button class="danger" type="submit">清空普通池</button></form></div><form method="post" action="${root(basePath)}/pool/copy" style="margin-top:10px"><label>复制</label><div class="actions"><select name="fromPool"><option value="premium">专业池</option><option value="general">普通池</option></select><select name="toPool"><option value="general">普通池</option><option value="premium">专业池</option></select><button type="submit">复制</button></div></form><form method="post" action="${root(basePath)}/pool/move" style="margin-top:10px"><label>迁移</label><div class="actions"><select name="fromPool"><option value="premium">专业池</option><option value="general">普通池</option></select><select name="toPool"><option value="general">普通池</option><option value="premium">专业池</option></select><button class="ghost" type="submit">迁移</button></div></form></section>
<section class="card"><h2>监控概览</h2><div class="hint">最近检查：${esc(time(mon?.checkedAt))}<br>缓存 TTL：${esc(String(mon?.ttlSeconds || 0))} 秒<br>本分钟剩余额度：${esc(String(mon?.summary?.remainingMinute ?? 0))}</div><div class="mini">${[{ key: 'pro', title: '专业池' }, { key: 'normal', title: '普通池' }, { key: 'internal', title: '游客池' }].map(({ key, title }) => { const d = mon?.pools?.[key] || {}; const g = d.diagnostics || {}; return `<div class="subcard"><strong>${esc(title)}</strong><div>状态：${esc(d.label || '-')}</div><div>说明：${esc(d.detail || '-')}</div><div>最近请求：${esc(time(d.lastRequestAt))}</div><div>基础探活：${esc(g.basicProbe || '-')}</div><div>VIP 能力：${esc(g.vipState || '-')}</div></div>` }).join('')}</div></section>
${renderMonitorRefreshSection(basePath, mon)}
${renderRequestLogsSection(logs)}
<section class="card full"><h2>调试信息</h2><details><summary class="muted">展开查看原始状态</summary><div class="mini" style="margin-top:10px"><div><h3>最近 upstream</h3><pre>${esc(JSON.stringify(trace || null, null, 2))}</pre></div><div><h3>Cookie 池视图</h3><pre>${esc(JSON.stringify(pools, null, 2))}</pre></div><div><h3>监控 JSON</h3><pre>${esc(JSON.stringify(mon, null, 2))}</pre></div><div><h3>状态文件路径</h3><pre>${esc(getKugouAdminStatePath())}</pre></div></div></details></section>
</div></div></body></html>`

const loginPage = ({ message = '', basePath = '/music' }) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Meting 管理页登录</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5efe6;font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif} .card{width:min(420px,92vw);background:#fffaf5;border:1px solid #dcc8b0;border-radius:20px;padding:28px;box-shadow:0 18px 40px rgba(0,0,0,.1)} input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #dcc8b0;border-radius:12px;margin:12px 0 16px} button{width:100%;padding:12px 14px;border:0;border-radius:12px;background:#245c51;color:#fff;font-weight:700} .msg{padding:12px 14px;border-radius:12px;background:#f9e8df;color:#8a3f1b;margin-bottom:12px}</style></head><body><form class="card" method="post" action="${loginPath(basePath)}"><h1>Meting 管理页</h1><p>输入后台密码后进入 Kugou 管理页面。</p>${message ? `<div class="msg">${esc(message)}</div>` : ''}<input type="password" name="password" placeholder="后台密码"><button type="submit">登录</button><p>公开监控页：<code>${esc(`${basePath}/manage/monitor`)}</code></p></form></body></html>`

const publicPage = ({ basePath, mon, platform, trace }) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Meting 公开监控</title><style>body{margin:0;background:#f5efe6;font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#261d15}.wrap{max-width:980px;margin:0 auto;padding:24px}.card{background:#fffaf5;border:1px solid #dcc8b0;border-radius:18px;padding:18px}.btn{display:inline-block;padding:10px 14px;border-radius:12px;background:#245c51;color:#fff;text-decoration:none}.hint{padding:12px 14px;border-radius:12px;background:#f5ece0;color:#6e5d4c;margin-bottom:12px}</style></head><body><div class="wrap"><div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px"><div><h1>Meting 公开监控</h1><div class="hint">当前 platform：${esc(platformLabel(platform))}<br>最近 upstream：${esc(upstreamLabel(trace?.status))}<br>最近记录时间：${esc(time(trace?.at))}</div></div><a class="btn" href="${loginPath(basePath)}">管理员登录</a></div><div class="card"><pre>${esc(JSON.stringify(mon, null, 2))}</pre></div></div></body></html>`

export default async (c) => {
  const basePath = getBasePath(c)

  if (c.req.method === 'GET' && c.req.path.endsWith('/login')) return c.html(loginPage({ message: consumeFlash(c), basePath }))
  if (c.req.method === 'POST' && c.req.path.endsWith('/login')) {
    const form = await getForm(c)
    if (!verifyAdminPassword(form.password || '')) { setFlash(c, '后台密码错误'); return redirect(c, loginPath(basePath)) }
    setSessionCookie(c, createAdminSession())
    return redirect(c, root(basePath))
  }
  if (c.req.method === 'POST' && c.req.path.endsWith('/logout')) { clearSessionCookie(c); return redirect(c, loginPath(basePath)) }
  if (c.req.method === 'GET' && c.req.path.endsWith('/manage/login') && requireAdminAuth(c)) return redirect(c, root(basePath))

  if (c.req.method === 'GET' && (c.req.path.endsWith('/manage') || c.req.path.endsWith('/manage/monitor')) && !requireAdminAuth(c)) {
    const [mon, platform] = await Promise.all([monitor(), upstreamPlatform()])
    return c.html(publicPage({ basePath, mon, platform, trace: getKugouUpstreamTrace() }))
  }

  const denied = needAuth(c, basePath)
  if (denied) return denied

  if (c.req.method === 'POST' && c.req.path.endsWith('/pm2')) {
    const form = await getForm(c)
    const result = await pm2(form.action === 'restart-update' ? ['restart', form.name, '--update-env'] : ['restart', form.name])
    return respond(c, basePath, result, result.ok ? `已执行 PM2 操作：${form.name}` : `PM2 操作失败：${result.stderr || result.stdout}`)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/clear')) {
    const form = await getForm(c); const pool = form.pool === 'general' ? 'general' : 'premium'
    try { await clearCookiePool(pool); return respond(c, basePath, { ok: true, pool }, `${getKugouPoolLabel(pool)}文件已清空`) } catch (error) { return respond(c, basePath, { ok: false, message: error.message }, `清空失败：${error.message || '未知错误'}`) }
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/copy')) {
    const form = await getForm(c); const fromPool = form.fromPool === 'general' ? 'general' : 'premium'; const toPool = form.toPool === 'general' ? 'general' : 'premium'
    if (fromPool === toPool) return respond(c, basePath, { ok: false }, '源池和目标池不能相同')
    try { await copyCookiePool(fromPool, toPool); return respond(c, basePath, { ok: true }, `${getKugouPoolLabel(fromPool)}已复制到${getKugouPoolLabel(toPool)}`) } catch (error) { return respond(c, basePath, { ok: false, message: error.message }, `复制失败：${error.message || '未知错误'}`) }
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/pool/move')) {
    const form = await getForm(c); const fromPool = form.fromPool === 'general' ? 'general' : 'premium'; const toPool = form.toPool === 'general' ? 'general' : 'premium'
    if (fromPool === toPool) return respond(c, basePath, { ok: false }, '源池和目标池不能相同')
    try { await moveCookiePool(fromPool, toPool); return respond(c, basePath, { ok: true }, `${getKugouPoolLabel(fromPool)}已迁移到${getKugouPoolLabel(toPool)}`) } catch (error) { return respond(c, basePath, { ok: false, message: error.message }, `迁移失败：${error.message || '未知错误'}`) }
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/start')) {
    const login = await fetchKugouQrLogin()
    if (!login) return respond(c, basePath, { ok: false }, '生成二维码失败')
    const device = await registerKugouDevice()
    await setQrState({ ...login, cookieMap: device?.cookieMap || {}, status: 1 })
    return respond(c, basePath, { ok: true, login }, '二维码已生成')
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/check')) {
    const state = await qrState()
    if (!state) return respond(c, basePath, { ok: false }, '请先生成二维码')
    const result = await checkKugouQrLogin(state.key)
    await setQrState({ ...state, ...result, cookieMap: { ...(state.cookieMap || {}), ...(result.cookieMap || {}) } })
    return respond(c, basePath, result, qrLabel(result.status))
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/apply')) {
    const form = await getForm(c); const state = await qrState()
    if (!state || Number(state.status) !== 4) return respond(c, basePath, { ok: false }, '二维码登录尚未完成，不能写入池')
    const result = await applyKugouPoolCookieMap(form.pool || 'premium', state.cookieMap || {}, { trigger: 'qr-login' })
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/refresh')) {
    const form = await getForm(c); const result = await refreshKugouPool(form.pool || 'premium', { trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/status/refresh')) {
    const refreshed = await monitor(true)
    return respond(c, basePath, refreshed, '已强制刷新 VIP 探针')
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/vip/claim')) {
    const form = await getForm(c); const result = await claimKugouLiteVip(form.pool || 'premium', { trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/vip/claim-all')) {
    const result = await claimAllKugouLiteVip({ trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/send')) {
    const form = await getForm(c)
    if (!form.mobile) return respond(c, basePath, { ok: false }, '请先输入手机号')
    const device = await registerKugouDevice()
    const result = await sendKugouCaptcha({ mobile: form.mobile, cookieMap: device.cookieMap || {} })
    await setSms({ mobile: form.mobile, cookieMap: result.cookieMap || device.cookieMap || {} })
    return respond(c, basePath, result, result.body?.msg || result.body?.message || '验证码已发送')
  }

  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/login')) {
    const form = await getForm(c); const state = await smsState()
    if (!state?.mobile || !form.code) return respond(c, basePath, { ok: false }, '请先发送验证码并填写短信验证码')
    const result = await loginKugouCellphone({ mobile: state.mobile, code: form.code, cookieMap: state.cookieMap || {} })
    const applied = await applyKugouPoolCookieMap(form.pool || 'premium', result.cookieMap || {}, { trigger: 'sms-login' })
    return respond(c, basePath, applied, applied.message)
  }

  await Promise.allSettled([ensureKugouPoolFresh('premium', { trigger: 'page-open' }), ensureKugouPoolFresh('general', { trigger: 'page-open' })])
  await Promise.allSettled([syncKugouPoolProfile('premium'), syncKugouPoolProfile('general')])

  const flash = consumeFlash(c)
  const [procs, premium, general, mon, qr, sms, platform, logs] = await Promise.all([
    pm2Status(),
    poolView('premium'),
    poolView('general'),
    monitor(),
    qrState(),
    smsState(),
    upstreamPlatform(),
    readRequestSummaries(30)
  ])
  const pools = [premium, general]
  const trace = getKugouUpstreamTrace()
  const warnings = []
  if (!hasKugouUpstreamAuth()) warnings.push('当前没有配置 METING_KUGOU_UPSTREAM_URL，Kugou 管理动作和概念版领取都不会生效。')
  if (platformLabel(platform) !== 'lite') warnings.push('KuGouMusicApi/.env 中的 platform 不是 lite。即使页面显示有登录态，也不代表运行时正在走概念版链路。')
  if (platformLabel(platform) === 'lite' && pools.some(item => item.sourceInfo.source === 'env')) warnings.push('虽然 platform=lite，但当前运行时仍优先吃环境变量 Cookie；后台写入的文件池不会立刻接管请求。')
  return c.html(page({ flash, basePath, procs, pools, mon, qr, sms, platform, trace, warnings, logs }))
}
