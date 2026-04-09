const crypto = require('node:crypto');
const { appid, clientver, liteAppid, liteClientver, srcappid, wx_appid, wx_lite_appid, wx_secret, wx_lite_secret } = require('./config.json');
const { calculateMid, getGuid } = require('./util');

const normalizeText = (value) => String(value || '').trim();
const normalizePlatform = (value) => (normalizeText(value).toLowerCase() === 'lite' ? 'lite' : 'default');
const cryptoMd5 = (value) => crypto.createHash('md5').update(String(value || '')).digest('hex');

const buildRuntime = (runtime = {}) => {
  const platform = normalizePlatform(runtime.platform || process.env.platform);
  const guid = normalizeText(runtime.guid || process.env.KUGOU_API_GUID || cryptoMd5(getGuid()));
  const dev = normalizeText(runtime.dev || process.env.KUGOU_API_DEV || '').toUpperCase();
  const mac = normalizeText(runtime.mac || process.env.KUGOU_API_MAC || '02:00:00:00:00:00').toUpperCase();
  const mid = normalizeText(runtime.mid || process.env.KUGOU_API_MID || calculateMid(guid));

  return {
    platform,
    guid,
    dev,
    mac,
    mid
  };
};

const getFallbackRuntime = () => buildRuntime();
const getRuntime = () => getFallbackRuntime();
const isLiteRuntime = () => getRuntime().platform === 'lite';

const getRuntimeAppid = () => (isLiteRuntime() ? liteAppid : appid);
const getRuntimeClientver = () => (isLiteRuntime() ? liteClientver : clientver);
const getRuntimeSrcAppid = () => srcappid;
const getRuntimeWxAppid = () => (isLiteRuntime() ? wx_lite_appid : wx_appid);
const getRuntimeWxSecret = () => (isLiteRuntime() ? wx_lite_secret : wx_secret);
const hasRuntimeOverrideAccess = () => false;
const resolveRequestRuntime = () => getFallbackRuntime();
const runWithRuntime = (_, fn) => (typeof fn === 'function' ? fn() : undefined);

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
