#!/usr/bin/env node
/**
 * 精确环境对比测试
 * 在本地和服务器上用完全一样的请求参数，排除 UA/headers/Node版本 等因素
 */

const ZLIST_URL = 'https://m3ws.kugou.com/zlist/list?appid=1058&clientver=1014&pagesize=30&page=1&type=0&listid=2&uid=1539898977&share_type=collect&global_collection_id=collection_3_1539898977_2_0&sign=00608de5a78d89eff5f73393214633bb&chain=82g0FbeFZV2'

const HTML_URL = 'https://t1.kugou.com/82g0FbeFZV2'

// 完全模拟 Chrome 浏览器的完整请求头
const CHROME_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="122", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

const sep = () => console.log('─'.repeat(60))

async function testZlistAPI() {
  console.log('\n[Test A] zlist API — pagesize=30 完整 Chrome 请求头')
  console.log('URL:', ZLIST_URL.slice(0, 80) + '...')

  const res = await fetch(ZLIST_URL, { headers: CHROME_HEADERS, redirect: 'follow' })
  const data = await res.json()
  const songs = data?.list?.info || []

  console.log('  Response status:', res.status)
  console.log('  songs:', songs.length)
  console.log('  pagesize_echo:', data?.list?.pagesize ?? '?')
  console.log('  total:', data?.list?.total ?? '?')
  if (songs[0]) console.log('  first:', songs[0].name)

  // 对比：完全不发任何额外 header（裸 fetch）
  console.log('\n[Test B] zlist API — 裸 fetch（无自定义 header）')
  const res2 = await fetch(ZLIST_URL)
  const data2 = await res2.json()
  const songs2 = data2?.list?.info || []
  console.log('  songs:', songs2.length, ', pagesize_echo:', data2?.list?.pagesize ?? '?')

  // 对比：只发 User-Agent
  console.log('\n[Test C] zlist API — 只发 User-Agent')
  const res3 = await fetch(ZLIST_URL, {
    headers: { 'User-Agent': CHROME_HEADERS['User-Agent'] }
  })
  const data3 = await res3.json()
  const songs3 = data3?.list?.info || []
  console.log('  songs:', songs3.length, ', pagesize_echo:', data3?.list?.pagesize ?? '?')
}

async function testHTMLScrape() {
  sep()
  console.log('\n[Test D] HTML 抓取 — 完整 Chrome 请求头')

  const res = await fetch(HTML_URL, { headers: CHROME_HEADERS, redirect: 'follow' })
  const html = await res.text()
  const finalHost = new URL(res.url).hostname

  const patterns = [
    /var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*,\s*\/\//,
    /var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*;/
  ]
  let songCount = 0
  for (const pat of patterns) {
    const m = html.match(pat)
    if (m) { try { songCount = JSON.parse(m[1]).length } catch {} if (songCount) break }
  }

  console.log('  redirect → ', finalHost)
  console.log('  HTML size:', html.length, 'bytes')
  console.log('  dataFromSmarty songs:', songCount)

  // 对比：裸 fetch
  console.log('\n[Test E] HTML 抓取 — 裸 fetch')
  const res2 = await fetch(HTML_URL, { redirect: 'follow' })
  const html2 = await res2.text()
  const finalHost2 = new URL(res2.url).hostname
  let songCount2 = 0
  for (const pat of patterns) {
    const m = html2.match(pat)
    if (m) { try { songCount2 = JSON.parse(m[1]).length } catch {} if (songCount2) break }
  }
  console.log('  redirect → ', finalHost2)
  console.log('  HTML size:', html2.length, 'bytes')
  console.log('  dataFromSmarty songs:', songCount2)
}

async function testZlistPagination() {
  sep()
  console.log('\n[Test F] zlist API 分页 — page=1 vs page=2（pagesize=10）')

  const makeUrl = (page) =>
    `https://m3ws.kugou.com/zlist/list?appid=1058&clientver=1014&pagesize=10&page=${page}&type=0&listid=2&uid=1539898977&share_type=collect&global_collection_id=collection_3_1539898977_2_0&sign=00608de5a78d89eff5f73393214633bb&chain=82g0FbeFZV2`

  for (const page of [1, 2]) {
    const res = await fetch(makeUrl(page), { headers: CHROME_HEADERS })
    const data = await res.json()
    const songs = data?.list?.info || []
    console.log(`  page=${page}: ${songs.length} songs, first_hash=${songs[0]?.hash?.slice(0, 16) || 'none'}`)
  }
}

async function testOutboundIP() {
  sep()
  console.log('\n[Test G] 出口 IP 检测')
  try {
    const res = await fetch('https://httpbin.org/ip', { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    console.log('  出口 IP:', data.origin)
  } catch {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
      const data = await res.json()
      console.log('  出口 IP:', data.ip)
    } catch {
      console.log('  ❌ 无法检测出口 IP')
    }
  }
}

async function main() {
  console.log('🔬 精确环境对比测试')
  console.log(`   Platform: ${process.platform} | Node: ${process.version}`)
  console.log(`   Time: ${new Date().toISOString()}`)
  sep()

  await testOutboundIP()
  await testZlistAPI()
  await testHTMLScrape()
  await testZlistPagination()

  sep()
  console.log('\n✅ 测试完成 — 对比两端结果判断是 IP 还是环境问题')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
