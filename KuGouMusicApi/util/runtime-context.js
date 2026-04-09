const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { appid, clientver, liteAppid, liteClientver, wx_appid, wx_lite_appid, wx_secret, wx_lite_secret, srcappid } = require('./config.json');
const { getGuid, randomString, calculateMid } = require('./util');

const storage = new AsyncLocalStorage();
const defaultGuid = (process.env.KUGOU_API_GUID || crypto.createHash('md5').update(getGuid()).digest('hex')).toLowerCase();
const defaultDev = String(process.env.KUGOU_API_DEV || randomString(10)).toUpperCase();
const defaultMac = String(process.env.KUGOU_API_MAC || '02:00:00:00:00:00').toUpperCase();

const normalizeText = (value) => String(value || '').trim();
const normalizePlatform = (value) => normalizeText(value).replace(/^['"]+|['"]+$/g, '').toLowerCase() === 'lite' ? 'lite' : 'default';
const normalizeMac = (value) => normalizeText(value).toUpperCase();
const normalizeDev = (value) => normalizeText(value).toUpperCase();
const pickText = (...values) => {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return '';
};

const isLoopbackAddress = (value) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(normalizeText(value));

const hasRuntimeOverrideAccess = (req) => {
  const secret = normalizeText(process.env.KUGOU_RUNTIME_SECRET || process.env.METING_KUGOU_UPSTREAM_RUNTIME_SECRET);
  const headerSecret = normalizeText(req?.headers?.['x-kugou-runtime-secret']);
  if (secret) return secret === headerSecret;

  return isLoopbackAddress(req?.ip) || isLoopbackAddress(req?.socket?.remoteAddress);
};

const buildRuntime = (partial = {}) => {
  const guid = pickText(partial.guid, defaultGuid).toLowerCase();
  return {
    pool: pickText(partial.pool, 'default'),
    platform: normalizePlatform(partial.platform),
    guid,
    dev: normalizeDev(pickText(partial.dev, defaultDev)),
    mac: normalizeMac(pickText(partial.mac, defaultMac)),
    mid: calculateMid(guid)
  };
};

const getFallbackRuntime = () => buildRuntime({
  platform: process.env.platform,
  guid: process.env.KUGOU_API_GUID,
  dev: process.env.KUGOU_API_DEV,
  mac: process.env.KUGOU_API_MAC
});

const getRuntime = () => storage.getStore() || getFallbackRuntime();

const resolveRequestRuntime = (req, cookies = {}) => {
  const canOverride = hasRuntimeOverrideAccess(req);
  const fallback = getFallbackRuntime();

  if (!canOverride) {
    return buildRuntime({
      pool: cookies.pool || fallback.pool,
      platform: cookies.KUGOU_API_PLATFORM || fallback.platform,
      guid: cookies.KUGOU_API_GUID || fallback.guid,
      dev: cookies.KUGOU_API_DEV || fallback.dev,
      mac: cookies.KUGOU_API_MAC || fallback.mac
    });
  }

  return buildRuntime({
    pool: req?.headers?.['x-kugou-pool'] || cookies.pool || fallback.pool,
    platform: req?.headers?.['x-kugou-platform'] || cookies.KUGOU_API_PLATFORM || fallback.platform,
    guid: req?.headers?.['x-kugou-guid'] || cookies.KUGOU_API_GUID || fallback.guid,
    dev: req?.headers?.['x-kugou-dev'] || cookies.KUGOU_API_DEV || fallback.dev,
    mac: req?.headers?.['x-kugou-mac'] || cookies.KUGOU_API_MAC || fallback.mac
  });
};

const runWithRuntime = (runtime, fn) => storage.run(buildRuntime(runtime), fn);
const isLiteRuntime = () => getRuntime().platform === 'lite';

const getRuntimeAppid = () => (isLiteRuntime() ? liteAppid : appid);
const getRuntimeClientver = () => (isLiteRuntime() ? liteClientver : clientver);
const getRuntimeWxAppid = () => (isLiteRuntime() ? wx_lite_appid : wx_appid);
const getRuntimeWxSecret = () => (isLiteRuntime() ? wx_lite_secret : wx_secret);
const getRuntimeSrcAppid = () => srcappid;

module.exports = {
  buildRuntime,
  getFallbackRuntime,
  getRuntime,
  getRuntimeAppid,
  getRuntimeClientver,
  getRuntimeSrcAppid,
  getRuntimeWxAppid,
  getRuntimeWxSecret,
  hasRuntimeOverrideAccess,
  isLiteRuntime,
  normalizePlatform,
  resolveRequestRuntime,
  runWithRuntime
};
