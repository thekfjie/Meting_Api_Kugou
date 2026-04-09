import { readFile, watch } from 'node:fs/promises'
import { resolve } from 'node:path'
import config from '../config.js'

const hashSet = new Set()
const DATA_FILES = ['kugou_playlist.yml', 'liked_playlist.yml']

const getDataDir = () => resolve(process.cwd(), config.meting.kugou.blogDataDir)

const loadHashes = async () => {
  const pattern = /^\s*hash:\s*([A-Fa-f0-9]+)\s*$/gm
  const next = new Set()
  const dataDir = getDataDir()

  for (const file of DATA_FILES) {
    try {
      const content = await readFile(resolve(dataDir, file), 'utf-8')
      let match
      while ((match = pattern.exec(content)) !== null) {
        next.add(match[1].toUpperCase())
      }
    } catch (error) {
      // 文件不存在时跳过，不影响启动
    }
  }

  hashSet.clear()
  for (const h of next) hashSet.add(h)
  console.log(`[whitelist] 已加载 ${hashSet.size} 条博客歌单 hash`)
}

// 启动时加载
loadHashes().catch(() => {})

// 监听文件变更，自动热更新
let watcher = null
const startWatcher = async () => {
  try {
    const dataDir = getDataDir()
    watcher = watch(dataDir)
    for await (const event of watcher) {
      if (event.filename && DATA_FILES.some(f => event.filename.endsWith(f))) {
        await loadHashes()
      }
    }
  } catch (error) {
    // 监听失败不影响正常运行
  }
}

if (!watcher) {
  startWatcher().catch(() => {})
}

/**
 * 检查歌曲 hash 是否在博客歌单白名单中
 * @param {string} hash - 酷狗歌曲 hash
 * @returns {boolean}
 */
export function isHashInBlogPlaylist (hash) {
  if (!hash) return false
  return hashSet.has(hash.toUpperCase())
}

/**
 * 获取当前白名单大小（供管理页面使用）
 * @returns {number}
 */
export function getBlogPlaylistSize () {
  return hashSet.size
}
