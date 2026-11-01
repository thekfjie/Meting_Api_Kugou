import { serve } from '@hono/node-server'
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { createApp } from './app.js'
import { logger } from './middleware/logger.js'
import config from './config.js'
import { startKugouAutoRefreshScheduler, stopKugouAutoRefreshScheduler } from './utils/kugou-auto-refresh.js'

const app = createApp()
const servers = []
let tlsOptions

if (config.https.enabled) {
  if (!config.https.keyPath || !config.https.certPath) {
    logger.error('HTTPS_ENABLED requires SSL_KEY_PATH and SSL_CERT_PATH')
    process.exit(1)
  }
  try {
    tlsOptions = {
      key: readFileSync(config.https.keyPath),
      cert: readFileSync(config.https.certPath)
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to read SSL certificate files')
    process.exit(1)
  }
}

servers.push(serve({ fetch: app.fetch, port: config.http.port }))
logger.info({ port: config.http.port }, 'HTTP server started')

if (tlsOptions) {
  servers.push(serve({
    fetch: app.fetch,
    port: config.https.port,
    createServer,
    serverOptions: tlsOptions
  }))
  logger.info({ port: config.https.port }, 'HTTPS server started')
}
startKugouAutoRefreshScheduler()

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  stopKugouAutoRefreshScheduler()
  for (const server of servers) server.close()
  const deadline = setTimeout(() => {
    for (const server of servers) server.closeAllConnections()
  }, 10_000)
  deadline.unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
