import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestLogger } from './middleware/logger.js'
import errors from './middleware/errors.js'
import apiService from './service/api.js'
import adminService from './service/admin.js'
import demoService from './service/demo.js'
import kugouMonitorService from './service/kugou-monitor.js'
import config from './config.js'

const adminActions = [
  'login', 'logout', 'pm2', 'pool/clear', 'pool/copy', 'pool/move',
  'kugou/qr/start', 'kugou/qr/check', 'kugou/qr/apply', 'kugou/refresh',
  'kugou/status/refresh', 'kugou/vip/claim', 'kugou/vip/claim-all',
  'kugou/captcha/send', 'kugou/captcha/login'
]

// Constructing the app does not open ports or start account jobs.
export const createApp = () => {
  const app = new Hono().use(requestLogger).use(cors()).use(errors)
  const prefix = config.http.prefix

  app.get('/healthz', c => c.json({ status: 'ok' }))
  for (const alias of ['api', 'music']) {
    app.get(`${prefix}/${alias}`, apiService)
    app.get(`${prefix}/${alias}/stream`, c => {
      if (c.req.query('server') !== 'kugou' || c.req.query('type') !== 'url') {
        return c.text('Invalid audio resource', 400)
      }
      c.set('streamAudio', true)
      return apiService(c)
    })
    for (const page of ['', '/login', '/monitor']) {
      app.get(`${prefix}/${alias}/manage${page}`, adminService)
    }
    for (const action of adminActions) {
      app.post(`${prefix}/${alias}/manage/${action}`, adminService)
    }
  }
  app.get(`${prefix}/demo`, demoService)
  app.get(`${prefix}/api/monitor/kugou`, kugouMonitorService)
  app.get(`${prefix}/monitor/kugou`, kugouMonitorService)
  return app
}
