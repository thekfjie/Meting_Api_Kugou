import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const logPath = resolve(process.cwd(), 'data', 'request-summary-log.json')
const MAX_ENTRIES = 200

let cachedEntries = null
let writeQueue = Promise.resolve()

const normalizeEntry = (entry = {}) => ({
  at: entry.at || new Date().toISOString(),
  path: String(entry.path || ''),
  server: String(entry.server || ''),
  type: String(entry.type || ''),
  id: String(entry.id || ''),
  requestId: String(entry.requestId || ''),
  pool: String(entry.pool || ''),
  cache: entry.cache === 'hit' ? 'hit' : 'miss',
  upstream: String(entry.upstream || ''),
  referer: String(entry.referer || ''),
  items: Array.isArray(entry.items)
    ? entry.items.map(item => String(item || '').trim()).filter(Boolean).slice(0, 5)
    : []
})

const loadEntries = async () => {
  if (cachedEntries) return cachedEntries

  try {
    const raw = await readFile(logPath, 'utf8')
    const parsed = JSON.parse(raw)
    cachedEntries = Array.isArray(parsed)
      ? parsed.map(normalizeEntry).slice(0, MAX_ENTRIES)
      : []
  } catch (error) {
    cachedEntries = []
  }

  return cachedEntries
}

const persistEntries = async (entries) => {
  cachedEntries = entries.slice(0, MAX_ENTRIES)
  await mkdir(dirname(logPath), { recursive: true })
  await writeFile(logPath, JSON.stringify(cachedEntries, null, 2), 'utf8')
}

export async function recordRequestSummary (entry) {
  const entries = await loadEntries()
  const nextEntries = [normalizeEntry(entry), ...entries].slice(0, MAX_ENTRIES)

  writeQueue = writeQueue
    .catch(() => {})
    .then(() => persistEntries(nextEntries))
    .catch(() => {})

  await writeQueue
}

export async function readRequestSummaries (limit = 30) {
  const entries = await loadEntries()
  return entries.slice(0, Math.max(1, limit))
}

export function getRequestSummaryLogPath () {
  return logPath
}
