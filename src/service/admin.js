import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  clearCookiePool,
  clearSessionCookie,
  copyCookiePool,
  createAdminSession,
  hasAdminPassword,
  maskText,
  parseSimpleCookie,
  requireAdminAuth,
  setSessionCookie,
  verifyAdminPassword,
  moveCookiePool
} from '../utils/admin.js'
import {
  applyKugouPoolCookieMap,
  claimAllKugouLiteVip,
  claimKugouLiteVip,
  getKugouPoolLabel,
  refreshKugouPool
} from '../utils/kugou-admin-actions.js'
import { getKugouAdminPoolState, getKugouAdminSession, getKugouAdminStatePath, setKugouAdminSession } from '../utils/kugou-admin-state.js'
import { inspectCookieSource, readCookieFile, readCookiePoolFile } from '../utils/cookie.js'
import { checkKugouQrLogin, fetchKugouQrLogin, hasKugouUpstreamAuth, loginKugouCellphone, registerKugouDevice, sendKugouCaptcha } from '../utils/kugou-upstream-auth.js'
import { getKugouPoolPlatform, listKugouPoolPlatforms } from '../utils/kugou-upstream-runtime.js'
import { getKugouUpstreamTrace } from '../utils/kugou-upstream-status.js'
import { getRequestSummaryLogPath, readRequestSummaries } from '../utils/request-summary-log.js'
import kugouMonitorService from './kugou-monitor.js'

const execFileAsync = promisify(execFile)
const pm2Bin = process.env.PM2_BIN || (process.platform === 'win32' ? 'pm2.cmd' : 'pm2')
const flashCookie = 'meting_admin_flash'
const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const esc = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const txt = value => String(value || '').trim()
const time = value => {
  if (!value) return '暂无'
  try { return `${fmt.format(new Date(value))} (UTC+8)` } catch { return String(value) }
}
const sourceLabel = value => value === 'env' ? '环境变量' : value === 'file' ? '文件池' : '未配置'
const upstreamLabel = value => value === 'hit' ? '命中 upstream' : value === 'fallback-meting' ? 'upstream 回退 Meting' : value === 'miss' ? '未命中 upstream' : '暂无'
const qrLabel = value => ({ 0: '二维码已过期', 1: '等待扫码', 2: '已扫码待确认', 4: '登录成功，可写入池' }[Number(value || 0)] || `未知状态 ${value}`)
const platformMode = value => txt(value).replace(/^['"]+|['"]+$/g, '').toLowerCase() === 'lite' ? 'lite' : 'default'
const platformDisplay = value => platformMode(value) === 'lite' ? 'lite (concept)' : 'default (regular)'
const root = base => `${base}/manage`
const loginPath = base => `${root(base)}/login`
const wantsJson = c => c.req.query('format') === 'json' || (String(c.req.header('accept') || '').toLowerCase().includes('application/json') && !String(c.req.header('accept') || '').toLowerCase().includes('text/html'))
const getBasePath = c => {
  const path = c.req.path
  const musicIndex = path.indexOf('/music/manage')
  if (musicIndex !== -1) return `${path.slice(0, musicIndex)}/music`
  const apiIndex = path.indexOf('/api/manage')
  if (apiIndex !== -1) return `${path.slice(0, apiIndex)}/api`
  return ''
}
const redirect = (c, location) => { c.header('Location', location); return c.body(null, 302) }
const getForm = async c => Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v)]))
const getCookie = (c, name) => {
  for (const part of String(c.req.header('cookie') || '').split(';')) {
    const item = part.trim()
    const idx = item.indexOf('=')
    if (idx !== -1 && item.slice(0, idx).trim() === name) return item.slice(idx + 1).trim()
  }
  return ''
}
const setFlash = (c, message) => c.header('Set-Cookie', `${flashCookie}=${encodeURIComponent(message)}; Path=/; SameSite=Lax`)
const consumeFlash = c => {
  const value = getCookie(c, flashCookie)
  if (value) c.header('Set-Cookie', `${flashCookie}=; Path=/; SameSite=Lax; Max-Age=0`)
  return value ? decodeURIComponent(value) : ''
}
const respond = (c, basePath, payload, message = '') => wantsJson(c) ? c.json(payload) : (message && setFlash(c, message), redirect(c, root(basePath)))
const needAuth = (c, basePath) => {
  if (!hasAdminPassword()) return c.html('<h1>ADMIN_PASSWORD 未配置</h1>', 500)
  if (!requireAdminAuth(c)) return redirect(c, loginPath(basePath))
  return null
}

const pm2 = async args => {
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
const monitor = async (force = false) => kugouMonitorService({
  req: { query: key => key ? (key === 'refresh' && force ? '1' : undefined) : (force ? { refresh: '1' } : {}) },
  header: () => {},
  json: payload => payload
})
const upstreamPlatformSummary = async () => listKugouPoolPlatforms().map(item => `${item.pool}=${platformDisplay(item.platform)}`).join(' / ')
const qrState = async () => getKugouAdminSession('qrLogin')
const setQrState = async value => setKugouAdminSession('qrLogin', value ? { ...value, expiresAt: Date.now() + 5 * 60 * 1000 } : null)
const smsState = async () => getKugouAdminSession('smsLogin')
const setSms = async value => setKugouAdminSession('smsLogin', value ? { ...value, expiresAt: Date.now() + 10 * 60 * 1000 } : null)

const poolView = async pool => {
  const [activeCookie, fileCookie, sourceInfo, state] = await Promise.all([readCookieFile('kugou', pool), readCookiePoolFile('kugou', pool), inspectCookieSource('kugou', pool), getKugouAdminPoolState(pool)])
  const active = parseSimpleCookie(activeCookie)
  const file = parseSimpleCookie(fileCookie)
  const account = state.account || {}
  return {
    pool,
    label: getKugouPoolLabel(pool),
    platform: getKugouPoolPlatform(pool),
    sourceInfo,
    state,
    userId: account.userId || active.KugooID || file.KugooID || '',
    nickname: account.nickname || '',
    vipType: account.vipType || active.vip_type || file.vip_type || '',
    vipLevel: account.vipLevel || '',
    expireTime: account.expireTime || '',
    token: maskText(active.t || file.t),
    dfid: maskText(active.dfid || active.kg_dfid || file.dfid || file.kg_dfid),
    mid: maskText(active.KUGOU_API_MID || active.mid || active.kg_mid || file.KUGOU_API_MID || file.mid || file.kg_mid),
    warnings: sourceInfo.source === 'env' ? ['当前运行时优先使用环境变量，文件池不会立刻接管请求。'] : []
  }
}

const resultText = result => result ? `${result.ok ? '成功' : '失败'} / ${txt(result.message) || '-'} / ${time(result.at)}` : '暂无'
const shell = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;font:14px/1.6 Arial,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f8fb;color:#0f172a}.wrap{max-width:1200px;margin:0 auto;padding:24px 16px 40px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px}.full{grid-column:1/-1}.sub,.muted{color:#64748b;font-size:13px}.flash,.warn,.hint{padding:10px 12px;border-radius:10px;margin-bottom:12px;font-size:13px}.flash{background:#ecfdf5;border:1px solid #bbf7d0;color:#166534}.warn{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}.hint{background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8}.actions{display:flex;gap:10px;flex-wrap:wrap}button,.btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 12px;border-radius:10px;border:0;background:#0f172a;color:#fff;cursor:pointer;text-decoration:none}button.ghost,.btn.ghost{background:#fff;color:#0f172a;border:1px solid #cbd5e1}button.danger{background:#b91c1c}button[disabled]{opacity:.55;cursor:not-allowed}input,select{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box}label{display:block;margin:10px 0 6px;color:#64748b;font-size:13px}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:680px}th,td{padding:9px 8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}th{font-size:12px;color:#64748b}code,pre{font-family:Consolas,monospace}code{background:#f1f5f9;padding:2px 6px;border-radius:6px}pre{background:#0f172a;color:#e2e8f0;border-radius:12px;padding:12px;overflow:auto;font-size:12px}</style></head><body><div class="wrap">${body}</div></body></html>`

const renderLogin = (basePath, message = '') => shell('后台登录', `<div style="min-height:70vh;display:flex;align-items:center;justify-content:center"><form class="card" method="post" action="${loginPath(basePath)}" style="width:min(420px,100%)"><h1>后台登录</h1><div class="sub" style="margin-bottom:12px">输入管理员密码后进入管理页。</div>${message ? `<div class="warn">${esc(message)}</div>` : ''}<label>管理员密码</label><input type="password" name="password" placeholder="请输入 ADMIN_PASSWORD"><button type="submit" style="margin-top:12px;width:100%">登录</button><div class="sub" style="margin-top:12px">公开监控：<a href="${esc(`${basePath}/manage/monitor`)}">${esc(`${basePath}/manage/monitor`)}</a></div></form></div>`)
const renderPublic = ({ basePath, mon, platform, trace }) => shell('Kugou 状态', `<div class="top"><div><h1>Kugou 状态</h1><div class="sub">平台摘要：<strong>${esc(platform)}</strong><br>最近 upstream：<strong>${esc(upstreamLabel(trace?.status))}</strong></div></div><a class="btn" href="${loginPath(basePath)}">进入后台</a></div><div class="card"><div class="hint">上次探测：${esc(time(mon?.checkedAt))}<br>下次探测：${esc(time(mon?.nextCheckAt))}<br>缓存剩余：${esc(String(mon?.cacheRemainingSeconds ?? 0))} 秒</div><pre>${esc(JSON.stringify(mon, null, 2))}</pre></div>`)

const renderPage = ({ flash, basePath, procs, pools, mon, qr, sms, platform, trace, warnings, logs }) => {
  const litePools = pools.filter(item => item.platform === 'lite')
  const pm2Rows = procs.filter(item => ['meting-api', 'kugou-upstream'].includes(item.name))

  return shell('Meting Kugou 管理页', `
    <div class="top"><div><h1>Meting Kugou 管理页</h1><div class="sub">平台摘要：<strong>${esc(platform)}</strong><br>最近 upstream：<strong>${esc(upstreamLabel(trace?.status))}</strong></div></div><div class="actions"><a class="btn ghost" href="${esc(`${basePath}/manage/monitor`)}">公开监控</a><form method="post" action="${root(basePath)}/logout"><button class="ghost" type="submit">退出登录</button></form></div></div>
    ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${warnings.map(item => `<div class="warn">${esc(item)}</div>`).join('')}
    <div class="grid">
      <section class="card"><h2>运行概览</h2><div class="hint">状态文件：<code>${esc(getKugouAdminStatePath())}</code><br>请求摘要：<code>${esc(getRequestSummaryLogPath())}</code></div><pre>${esc(JSON.stringify(trace || null, null, 2))}</pre></section>
      <section class="card"><h2>PM2 进程</h2><div class="table"><table><thead><tr><th>进程</th><th>状态</th><th>内存</th><th>操作</th></tr></thead><tbody>${pm2Rows.length ? pm2Rows.map(item => `<tr><td>${esc(item.name)}</td><td>${esc(item.pm2_env?.status || '-')}</td><td>${esc(item.monit?.memory ? `${Math.round(item.monit.memory / 1024 / 1024)} MB` : '-')}</td><td><div class="actions"><form method="post" action="${root(basePath)}/pm2"><input type="hidden" name="name" value="${esc(item.name)}"><input type="hidden" name="action" value="restart"><button type="submit">重启</button></form><form method="post" action="${root(basePath)}/pm2"><input type="hidden" name="name" value="${esc(item.name)}"><input type="hidden" name="action" value="restart-update"><button class="ghost" type="submit">重载环境</button></form></div></td></tr>`).join('') : '<tr><td colspan="4">未读取到 PM2 信息</td></tr>'}</tbody></table></div></section>
      <section class="card full"><h2>平台与账号池</h2><div class="table"><table><thead><tr><th>池</th><th>平台</th><th>Cookie 来源</th><th>用户 ID</th><th>昵称</th><th>VIP</th><th>到期时间</th><th>Token / DFID / MID</th><th>资料同步</th></tr></thead><tbody>${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(platformDisplay(item.platform))}</td><td>${esc(sourceLabel(item.sourceInfo.source))}</td><td>${esc(item.userId || '-')}</td><td>${esc(item.nickname || '-')}</td><td>${esc([item.vipType || '-', item.vipLevel ? `Lv.${item.vipLevel}` : ''].filter(Boolean).join(' / '))}</td><td>${esc(time(item.expireTime))}</td><td>${esc([item.token || '-', item.dfid || '-', item.mid || '-'].join(' / '))}</td><td>${esc(time(item.state?.lastProfileAt))}</td></tr>`).join('')}</tbody></table></div>${pools.flatMap(item => item.warnings || []).map(item => `<div class="warn" style="margin-top:12px">${esc(item)}</div>`).join('')}</section>
      <section class="card"><h2>登录态刷新</h2><div class="hint">后台自动 refresh 已启用，这里只保留强制手动刷新。</div><div class="actions">${pools.map(item => `<form method="post" action="${root(basePath)}/kugou/refresh"><input type="hidden" name="pool" value="${esc(item.pool)}"><button type="submit"${item.pool === 'general' ? ' class="ghost"' : ''}>刷新${esc(item.label)}</button></form>`).join('')}</div><div class="table"><table><thead><tr><th>池</th><th>上次刷新</th><th>下次自动刷新</th><th>结果</th></tr></thead><tbody>${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(time(item.state?.lastRefreshAt))}</td><td>${esc(time(item.state?.nextRefreshAt))}</td><td>${esc(resultText(item.state?.lastRefreshResult))}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><h2>Lite 领取</h2><div class="hint">${litePools.length ? `Lite 池：${esc(litePools.map(item => item.label).join(' / '))}，支持自动领取和手动领取。` : '当前没有启用 Lite 池，领取按钮会保留但不会执行。'}</div><div class="actions">${pools.map(item => `<form method="post" action="${root(basePath)}/kugou/vip/claim"><input type="hidden" name="pool" value="${esc(item.pool)}"><button type="submit"${item.platform === 'lite' ? '' : ' disabled'}${item.pool === 'general' ? ' class="ghost"' : ''}>领取${esc(item.label)} Lite VIP</button></form>`).join('')}<form method="post" action="${root(basePath)}/kugou/vip/claim-all"><button class="danger" type="submit"${litePools.length ? '' : ' disabled'}>批量执行</button></form></div><div class="table"><table><thead><tr><th>池</th><th>上次领取</th><th>下次自动领取</th><th>结果</th></tr></thead><tbody>${pools.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(time(item.state?.lastClaimAt))}</td><td>${esc(time(item.state?.nextClaimAt))}</td><td>${esc(resultText(item.state?.lastClaimResult))}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card full"><h2>二维码 / 短信登录</h2><div class="grid"><div class="card"><h3>二维码登录</h3><div class="actions"><form method="post" action="${root(basePath)}/kugou/qr/start"><label>目标池</label><select name="pool"><option value="premium">专业池</option><option value="general">普通池</option></select><button type="submit" style="margin-top:10px">生成二维码</button></form><form method="post" action="${root(basePath)}/kugou/qr/check"><button class="ghost" type="submit">检查状态</button></form></div>${qr ? `<div class="hint" style="margin-top:12px">状态：${esc(qrLabel(qr.status))}<br>目标池：${esc(getKugouPoolLabel(qr.pool || 'premium'))}<br>过期时间：${esc(time(qr.expiresAt))}</div>${qr.base64 ? `<img src="${esc(qr.base64)}" alt="qr" style="max-width:220px;border:1px solid #e2e8f0;border-radius:12px;padding:10px;background:#fff">` : ''}<form method="post" action="${root(basePath)}/kugou/qr/apply" style="margin-top:12px"><label>写入到</label><select name="pool"><option value="premium"${qr.pool === 'premium' ? ' selected' : ''}>专业池</option><option value="general"${qr.pool === 'general' ? ' selected' : ''}>普通池</option></select><button type="submit" style="margin-top:10px">写入会话</button></form>` : '<div class="muted" style="margin-top:12px">当前没有二维码会话。</div>'}</div><div class="card"><h3>短信验证码登录</h3><form method="post" action="${root(basePath)}/kugou/captcha/send"><label>手机号</label><input name="mobile" placeholder="请输入手机号" value="${esc(sms?.mobile || '')}"><label>目标池</label><select name="pool"><option value="premium"${sms?.pool === 'premium' ? ' selected' : ''}>专业池</option><option value="general"${sms?.pool === 'general' ? ' selected' : ''}>普通池</option></select><button class="ghost" type="submit" style="margin-top:10px">发送验证码</button></form><form method="post" action="${root(basePath)}/kugou/captcha/login" style="margin-top:12px"><label>验证码</label><input name="code" placeholder="输入 6 位验证码"><label>写入到</label><select name="pool"><option value="premium"${sms?.pool === 'premium' ? ' selected' : ''}>专业池</option><option value="general"${sms?.pool === 'general' ? ' selected' : ''}>普通池</option></select><button type="submit" style="margin-top:10px">登录并写入会话</button></form></div></div></section>
      <section class="card"><h2>池文件操作</h2><div class="actions"><form method="post" action="${root(basePath)}/pool/clear"><input type="hidden" name="pool" value="premium"><button class="danger" type="submit">清空专业池文件</button></form><form method="post" action="${root(basePath)}/pool/clear"><input type="hidden" name="pool" value="general"><button class="danger" type="submit">清空普通池文件</button></form></div><form method="post" action="${root(basePath)}/pool/copy" style="margin-top:12px"><label>复制池文件</label><div class="actions"><select name="fromPool"><option value="premium">从专业池</option><option value="general">从普通池</option></select><select name="toPool"><option value="general">到普通池</option><option value="premium">到专业池</option></select><button type="submit">复制</button></div></form><form method="post" action="${root(basePath)}/pool/move" style="margin-top:12px"><label>迁移池文件</label><div class="actions"><select name="fromPool"><option value="premium">从专业池</option><option value="general">从普通池</option></select><select name="toPool"><option value="general">到普通池</option><option value="premium">到专业池</option></select><button class="ghost" type="submit">迁移</button></div></form></section>
      <section class="card"><h2>VIP 探针</h2><div class="hint">上次探测：${esc(time(mon?.checkedAt))}<br>下次探测：${esc(time(mon?.nextCheckAt))}<br>缓存剩余：${esc(String(mon?.cacheRemainingSeconds ?? 0))} 秒</div><div class="actions"><form method="post" action="${root(basePath)}/kugou/status/refresh"><button type="submit">强制刷新 VIP 探针</button></form></div><pre>${esc(JSON.stringify(mon, null, 2))}</pre></section>
      <section class="card full"><h2>最近请求摘要</h2><div class="hint">这里只展示摘要，不展示原始日志。摘要文件：<code>${esc(getRequestSummaryLogPath())}</code></div><div class="table"><table><thead><tr><th>时间</th><th>入口</th><th>请求</th><th>链路</th><th>结果</th></tr></thead><tbody>${logs.length ? logs.map(item => `<tr><td>${esc(time(item.at))}</td><td>${esc(item.path || '-')}</td><td>${esc([item.server, item.type, item.id].filter(Boolean).join(' / ') || '-')}</td><td>${esc([item.pool || '-', item.cache || '-', item.upstream || '-'].join(' / '))}</td><td>${esc((item.items || []).join(' | ') || '-')}</td></tr>`).join('') : '<tr><td colspan="5">暂无请求摘要</td></tr>'}</tbody></table></div></section>
    </div>`)
}

export default async c => {
  const basePath = getBasePath(c)
  if (c.req.method === 'GET' && c.req.path.endsWith('/login')) return c.html(renderLogin(basePath, consumeFlash(c)))
  if (c.req.method === 'POST' && c.req.path.endsWith('/login')) {
    const form = await getForm(c)
    if (!verifyAdminPassword(form.password || '')) { setFlash(c, '后台密码错误'); return redirect(c, loginPath(basePath)) }
    setSessionCookie(c, createAdminSession())
    return redirect(c, root(basePath))
  }
  if (c.req.method === 'POST' && c.req.path.endsWith('/logout')) { clearSessionCookie(c); return redirect(c, loginPath(basePath)) }
  if (c.req.method === 'GET' && c.req.path.endsWith('/manage/login') && requireAdminAuth(c)) return redirect(c, root(basePath))
  if (c.req.method === 'GET' && (c.req.path.endsWith('/manage') || c.req.path.endsWith('/manage/monitor')) && !requireAdminAuth(c)) {
    const [mon, platform] = await Promise.all([monitor(), upstreamPlatformSummary()])
    return c.html(renderPublic({ basePath, mon, platform, trace: getKugouUpstreamTrace() }))
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
    const form = await getForm(c); const pool = form.pool === 'general' ? 'general' : 'premium'; const login = await fetchKugouQrLogin(pool)
    if (!login) return respond(c, basePath, { ok: false }, '生成二维码失败')
    const device = await registerKugouDevice(pool); await setQrState({ ...login, pool, cookieMap: device?.cookieMap || {}, status: 1 })
    return respond(c, basePath, { ok: true, login }, '二维码已生成')
  }
  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/qr/check')) {
    const state = await qrState()
    if (!state) return respond(c, basePath, { ok: false }, '请先生成二维码')
    const result = await checkKugouQrLogin(state.key, state.pool || 'premium')
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
  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/status/refresh')) return respond(c, basePath, await monitor(true), '已强制刷新 VIP 探针')
  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/vip/claim')) {
    const form = await getForm(c); const result = await claimKugouLiteVip(form.pool || 'premium', { trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }
  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/vip/claim-all')) {
    const result = await claimAllKugouLiteVip({ trigger: 'manual' })
    return respond(c, basePath, result, result.message)
  }
  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/send')) {
    const form = await getForm(c); if (!form.mobile) return respond(c, basePath, { ok: false }, '请先输入手机号')
    const pool = form.pool === 'general' ? 'general' : 'premium'; const device = await registerKugouDevice(pool); const result = await sendKugouCaptcha({ mobile: form.mobile, cookieMap: device.cookieMap || {}, pool })
    await setSms({ mobile: form.mobile, pool, cookieMap: result.cookieMap || device.cookieMap || {} })
    return respond(c, basePath, result, result.body?.msg || result.body?.message || '验证码已发送')
  }
  if (c.req.method === 'POST' && c.req.path.endsWith('/kugou/captcha/login')) {
    const form = await getForm(c); const state = await smsState()
    if (!state?.mobile || !form.code) return respond(c, basePath, { ok: false }, '请先发送验证码并填写短信验证码')
    const pool = form.pool === 'general' ? 'general' : 'premium'; const result = await loginKugouCellphone({ mobile: state.mobile, code: form.code, cookieMap: state.cookieMap || {}, pool }); const applied = await applyKugouPoolCookieMap(pool, result.cookieMap || {}, { trigger: 'sms-login' })
    return respond(c, basePath, applied, applied.message)
  }

  const flash = consumeFlash(c)
  const [procs, premium, general, mon, qr, sms, platform, logs] = await Promise.all([pm2Status(), poolView('premium'), poolView('general'), monitor(), qrState(), smsState(), upstreamPlatformSummary(), readRequestSummaries(30)])
  const pools = [premium, general]
  const warnings = []
  if (!hasKugouUpstreamAuth()) warnings.push('当前没有配置 METING_KUGOU_UPSTREAM_URL，Kugou 管理动作和 Lite 领取都不会生效。')
  if (pools.some(item => item.sourceInfo.source === 'env')) warnings.push('当前有账号池仍优先使用环境变量 Cookie；后台写入的文件池不会立刻生效。')
  if (pools.some(item => item.platform !== 'lite')) warnings.push('当前并非所有池都运行在 Lite 平台；只有 Lite 池会执行自动领取。')
  return c.html(renderPage({ flash, basePath, procs, pools, mon, qr, sms, platform, trace: getKugouUpstreamTrace(), warnings, logs }))
}
