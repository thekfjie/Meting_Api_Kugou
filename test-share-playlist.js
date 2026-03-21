#!/usr/bin/env node
/**
 * Kugou Share Playlist Debug Tool
 *
 * 用法: node test-share-playlist.js
 *
 * 对比本地 vs 服务器上酷狗分享歌单 API 的行为差异。
 * 仅用于调试，不影响生产环境。
 */

const SHARE_CODE = '82g0FbeFZV2'
const T1_URL = `https://t1.kugou.com/${SHARE_CODE}`
const TIMEOUT_MS = 10000

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const log = (label, ...args) => console.log(`\n[${ label }]`, ...args)
const sep = () => console.log('\n' + '─'.repeat(60))

async function timedFetch(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const start = Date.now()
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' })
    const elapsed = Date.now() - start
    return { res, elapsed }
  } catch (err) {
    return { err: err.message || String(err), elapsed: Date.now() - start }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Test 1: Redirect behavior ───
async function testRedirect() {
  sep()
  log('Test 1', '重定向行为 — 看 t1.kugou.com 跳转到哪')

  for (const [label, ua] of [['Desktop UA', DESKTOP_UA], ['Mobile UA', MOBILE_UA]]) {
    const { res, err, elapsed } = await timedFetch(T1_URL, { headers: { 'user-agent': ua } })
    if (err) {
      console.log(`  ${label}: ERROR ${err} (${elapsed}ms)`)
      continue
    }
    const finalUrl = res.url
    const urlObj = new URL(finalUrl)
    const hasParams = urlObj.searchParams.has('global_collection_id') && urlObj.searchParams.has('sign')
    console.log(`  ${label}: → ${urlObj.hostname}${urlObj.pathname}`)
    console.log(`    global_collection_id: ${urlObj.searchParams.get('global_collection_id') || '❌ 缺失'}`)
    console.log(`    sign: ${urlObj.searchParams.get('sign') || '❌ 缺失'}`)
    console.log(`    可用于 zlist API: ${hasParams ? '✅ 是' : '❌ 否'}  (${elapsed}ms)`)
  }
}

// ─── Test 2: m3ws zlist API — pagesize ───
async function testZlistPagesize() {
  sep()
  log('Test 2', 'm3ws.kugou.com zlist API — pagesize 是否生效')

  // First get params via mobile redirect
  const { res: redirectRes } = await timedFetch(T1_URL, { headers: { 'user-agent': MOBILE_UA } })
  if (!redirectRes) { console.log('  ❌ 无法获取重定向 URL'); return }

  const redirectUrl = new URL(redirectRes.url)
  const baseParams = {}
  for (const k of ['type', 'listid', 'uid', 'share_type', 'global_collection_id', 'sign', 'chain']) {
    const v = redirectUrl.searchParams.get(k)
    if (v) baseParams[k] = v
  }

  if (!baseParams.sign) { console.log('  ❌ 重定向 URL 缺少 sign 参数'); return }

  for (const ps of [10, 30, 50, 100]) {
    const url = new URL('https://m3ws.kugou.com/zlist/list')
    url.searchParams.set('appid', '1058')
    url.searchParams.set('clientver', '1014')
    url.searchParams.set('pagesize', String(ps))
    url.searchParams.set('page', '1')
    for (const [k, v] of Object.entries(baseParams)) url.searchParams.set(k, v)

    const { res, err, elapsed } = await timedFetch(url.toString(), { headers: { 'user-agent': DESKTOP_UA } })
    if (err || !res?.ok) { console.log(`  pagesize=${ps}: ERROR (${elapsed}ms)`); continue }

    const data = await res.json()
    const songs = data?.list?.info || []
    const echoPs = data?.list?.pagesize ?? '?'
    const total = data?.list?.total ?? '?'
    console.log(`  请求 pagesize=${ps} → 实际返回 ${songs.length} 首, echo_pagesize=${echoPs}, total=${total}  (${elapsed}ms)`)
  }
}

// ─── Test 3: m3ws zlist API — pagination ───
async function testZlistPagination() {
  sep()
  log('Test 3', 'm3ws.kugou.com zlist API — 分页是否返回不同歌曲')

  const { res: redirectRes } = await timedFetch(T1_URL, { headers: { 'user-agent': MOBILE_UA } })
  if (!redirectRes) return

  const redirectUrl = new URL(redirectRes.url)
  const baseParams = {}
  for (const k of ['type', 'listid', 'uid', 'share_type', 'global_collection_id', 'sign', 'chain']) {
    const v = redirectUrl.searchParams.get(k)
    if (v) baseParams[k] = v
  }

  const pageHashes = []
  for (const page of [1, 2, 3]) {
    const url = new URL('https://m3ws.kugou.com/zlist/list')
    url.searchParams.set('appid', '1058')
    url.searchParams.set('clientver', '1014')
    url.searchParams.set('pagesize', '10')
    url.searchParams.set('page', String(page))
    for (const [k, v] of Object.entries(baseParams)) url.searchParams.set(k, v)

    const { res, err } = await timedFetch(url.toString(), { headers: { 'user-agent': DESKTOP_UA } })
    if (err || !res?.ok) { console.log(`  page=${page}: ERROR`); continue }

    const data = await res.json()
    const songs = data?.list?.info || []
    const firstHash = songs[0]?.hash?.slice(0, 12) || 'none'
    const lastName = songs[songs.length - 1]?.name?.slice(0, 20) || 'none'
    pageHashes.push(firstHash)
    console.log(`  page=${page}: ${songs.length} 首, first_hash=${firstHash}..., last_name="${lastName}"`)
  }

  const allSame = pageHashes.every(h => h === pageHashes[0])
  console.log(`  结论: ${allSame ? '❌ 每页返回相同歌曲 (分页无效)' : '✅ 每页返回不同歌曲 (分页有效)'}`)
}

// ─── Test 4: HTML scraping ───
async function testHtmlScraping() {
  sep()
  log('Test 4', 'HTML 抓取 — dataFromSmarty 有多少首歌')

  const { res, err, elapsed } = await timedFetch(T1_URL, { headers: { 'user-agent': DESKTOP_UA } })
  if (err || !res?.ok) { console.log(`  ❌ 获取失败 (${elapsed}ms)`); return }

  const html = await res.text()
  const patterns = [
    /var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*,\s*\/\//,
    /var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*;/
  ]

  let songs = []
  for (const pat of patterns) {
    const m = html.match(pat)
    if (m) {
      try { songs = JSON.parse(m[1]) } catch {}
      if (songs.length) break
    }
  }

  console.log(`  HTML 大小: ${html.length} bytes`)
  console.log(`  dataFromSmarty 歌曲数: ${songs.length}`)
  if (songs.length > 0) {
    console.log(`  第一首: ${songs[0]?.song_name || songs[0]?.name || '?'} — ${songs[0]?.author_name || '?'}`)
    console.log(`  最后一首: ${songs[songs.length - 1]?.song_name || songs[songs.length - 1]?.name || '?'}`)
  }
  console.log(`  (${elapsed}ms)`)
}

// ─── Test 5: mobilecdn collect API ───
async function testMobileCdn() {
  sep()
  log('Test 5', 'mobilecdn.kugou.com 收藏 API')

  const endpoints = [
    ['collect/song/list', 'http://mobilecdn.kugou.com/api/v3/collect/song/list?collectid=2&userid=1539898977&page=1&pagesize=30'],
    ['special/song (share code)', `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${SHARE_CODE}&area_code=1&page=1&plat=2&pagesize=-1&version=8990`],
  ]

  for (const [label, url] of endpoints) {
    const { res, err, elapsed } = await timedFetch(url, { headers: { 'user-agent': DESKTOP_UA } })
    if (err) { console.log(`  ${label}: ERROR ${err} (${elapsed}ms)`); continue }

    const text = await res.text()
    const isJson = text.startsWith('{') || text.startsWith('[')
    if (!isJson) {
      console.log(`  ${label}: 非 JSON 响应 "${text.slice(0, 50)}" (${elapsed}ms)`)
      continue
    }

    try {
      const data = JSON.parse(text)
      const info = data?.data?.info || data?.data || []
      const songCount = Array.isArray(info) ? info.length : '?'
      console.log(`  ${label}: status=${data?.status}, songs=${songCount} (${elapsed}ms)`)
    } catch {
      console.log(`  ${label}: JSON 解析失败 (${elapsed}ms)`)
    }
  }
}

// ─── Summary ───
async function main() {
  console.log('🔍 酷狗分享歌单调试工具')
  console.log(`   分享码: ${SHARE_CODE}`)
  console.log(`   环境: ${process.platform} | Node ${process.version}`)
  console.log(`   时间: ${new Date().toISOString()}`)

  await testRedirect()
  await testZlistPagesize()
  await testZlistPagination()
  await testHtmlScraping()
  await testMobileCdn()

  sep()
  log('完成', '将以上输出发给开发者对比本地 vs 服务器差异')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
