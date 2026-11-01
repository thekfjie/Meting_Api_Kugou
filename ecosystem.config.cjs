const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true })

const withOptional = (target, key, value) => {
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    target[key] = String(value).trim()
  }
  return target
}

const baseEnv = () => ({
  NODE_ENV: 'production',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: ''
})

const buildUpstreamEnv = ({ port, platform, guid, dev, mac }) => {
  const env = {
    ...baseEnv(),
    PORT: String(port),
    HOST: '127.0.0.1',
    platform: platform === 'lite' ? 'lite' : 'default'
  }

  withOptional(env, 'KUGOU_API_GUID', guid)
  withOptional(env, 'KUGOU_API_DEV', dev)
  withOptional(env, 'KUGOU_API_MAC', mac)

  return env
}

module.exports = {
  apps: [
    {
      name: process.env.METING_KUGOU_UPSTREAM_DEFAULT_PM2_NAME || 'kugou-upstream',
      cwd: path.resolve(__dirname, './KuGouMusicApi'),
      script: 'app.js',
      interpreter: process.execPath,
      autorestart: true,
      watch: false,
      env: buildUpstreamEnv({
        port: process.env.KUGOU_UPSTREAM_DEFAULT_PORT || 3100,
        platform: '',
        guid: process.env.KUGOU_API_DEFAULT_GUID,
        dev: process.env.KUGOU_API_DEFAULT_DEV,
        mac: process.env.KUGOU_API_DEFAULT_MAC
      })
    },
    {
      name: process.env.METING_KUGOU_UPSTREAM_LITE_PM2_NAME || 'kugou-upstream-lite',
      cwd: path.resolve(__dirname, './KuGouMusicApi'),
      script: 'app.js',
      interpreter: process.execPath,
      autorestart: true,
      watch: false,
      env: buildUpstreamEnv({
        port: process.env.KUGOU_UPSTREAM_LITE_PORT || 3101,
        platform: 'lite',
        guid: process.env.KUGOU_API_LITE_GUID,
        dev: process.env.KUGOU_API_LITE_DEV,
        mac: process.env.KUGOU_API_LITE_MAC
      })
    },
    {
      name: 'meting-api',
      cwd: __dirname,
      script: 'src/index.js',
      interpreter: process.execPath,
      autorestart: true,
      watch: false,
      env: baseEnv()
    }
  ]
}
