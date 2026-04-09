import dotenv from 'dotenv'

dotenv.config()

const toBoolean = value => {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

const toNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

const normalizePlatform = value => {
  const normalized = String(value || '').trim().replace(/^['"]+|['"]+$/g, '').toLowerCase()
  return normalized === 'lite' ? 'lite' : 'default'
}

export default {
  http: {
    prefix: process.env.HTTP_PREFIX || '',
    port: toNumber(process.env.HTTP_PORT, 80)
  },
  admin: {
    password: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.ADMIN_SESSION_SECRET || process.env.METING_TOKEN || 'token',
    sessionTtlMs: toNumber(process.env.ADMIN_SESSION_TTL_MS, 12 * 60 * 60 * 1000)
  },
  https: {
    enabled: toBoolean(process.env.HTTPS_ENABLED),
    port: toNumber(process.env.HTTPS_PORT, 443),
    keyPath: process.env.SSL_KEY_PATH || '',
    certPath: process.env.SSL_CERT_PATH || ''
  },
  meting: {
    url: process.env.METING_URL || '',
    token: process.env.METING_TOKEN || 'token',
    kugou: {
      premiumKey: process.env.METING_KUGOU_PREMIUM_KEY || '',
      blogDataDir: process.env.BLOG_DATA_DIR || './blog-data',
      pools: {
        premium: {
          platform: normalizePlatform(process.env.METING_KUGOU_PREMIUM_PLATFORM || 'default'),
          autoClaim: toBoolean(process.env.METING_KUGOU_PREMIUM_AUTO_CLAIM)
        },
        general: {
          platform: normalizePlatform(process.env.METING_KUGOU_GENERAL_PLATFORM || 'lite'),
          autoClaim: toBoolean(process.env.METING_KUGOU_GENERAL_AUTO_CLAIM || '1')
        }
      },
      upstream: {
        url: process.env.METING_KUGOU_UPSTREAM_URL || '',
        timeoutMs: toNumber(process.env.METING_KUGOU_UPSTREAM_TIMEOUT_MS, 8000),
        runtimeSecret: process.env.METING_KUGOU_UPSTREAM_RUNTIME_SECRET || ''
      },
      scheduler: {
        checkIntervalMs: toNumber(process.env.METING_KUGOU_SCHEDULER_INTERVAL_MS, 60 * 1000),
        refreshBaseMs: toNumber(process.env.METING_KUGOU_AUTO_REFRESH_BASE_MS, 6 * 60 * 60 * 1000),
        refreshJitterMs: toNumber(process.env.METING_KUGOU_AUTO_REFRESH_JITTER_MS, 60 * 60 * 1000),
        refreshRetryMs: toNumber(process.env.METING_KUGOU_AUTO_REFRESH_RETRY_MS, 30 * 60 * 1000),
        claimWindowStartHour: toNumber(process.env.METING_KUGOU_AUTO_CLAIM_START_HOUR, 9),
        claimWindowEndHour: toNumber(process.env.METING_KUGOU_AUTO_CLAIM_END_HOUR, 21)
      },
      status: {
        freeHash: process.env.METING_KUGOU_STATUS_FREE_HASH || '83995C1F356E6FC35A14D27940882F88',
        vipHash: process.env.METING_KUGOU_STATUS_VIP_HASH || '',
        vipDurationMs: toNumber(process.env.METING_KUGOU_STATUS_VIP_DURATION_MS, 0),
        ttlMs: toNumber(process.env.METING_KUGOU_STATUS_TTL_MS, 5 * 60 * 1000),
        maxRpm: {
          premium: toNumber(process.env.METING_KUGOU_PREMIUM_MAX_RPM, 60),
          general: toNumber(process.env.METING_KUGOU_GENERAL_MAX_RPM, 180)
        }
      }
    },
    cookie: {
      allowHosts: process.env.METING_COOKIE_ALLOW_HOSTS
        ? (process.env.METING_COOKIE_ALLOW_HOSTS).split(',').map(h => h.trim().toLowerCase())
        : []
    }
  }
}
