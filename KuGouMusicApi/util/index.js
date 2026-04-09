const { apiver, wx_appid, wx_lite_appid, wx_secret, wx_lite_secret } = require('./config.json');
const {
  cryptoAesDecrypt,
  cryptoAesEncrypt,
  cryptoMd5,
  cryptoRSAEncrypt,
  cryptoSha1,
  rsaEncrypt2,
  playlistAesEncrypt,
  playlistAesDecrypt,
  publicLiteRasKey,
  publicRasKey,
} = require('./crypto');
const { createRequest } = require('./request');
const { signKey, signParams, signParamsKey, signCloudKey, signatureAndroidParams, signatureRegisterParams, signatureWebParams } = require('./helper');
const { randomString, decodeLyrics, parseCookieString, cookieToJson, randomNumber, calculateMid } = require('./util');
const { getRuntimeAppid, getRuntimeClientver, getRuntimeSrcAppid, isLiteRuntime } = require('./runtime-context');

const exported = {
  apiver,
  wx_appid,
  wx_lite_appid,
  wx_secret,
  wx_lite_secret,
  cryptoAesDecrypt,
  cryptoAesEncrypt,
  cryptoMd5,
  cryptoRSAEncrypt,
  cryptoSha1,
  rsaEncrypt2,
  playlistAesEncrypt,
  playlistAesDecrypt,
  createRequest,
  signKey,
  signParams,
  signParamsKey,
  signCloudKey,
  signatureAndroidParams,
  signatureRegisterParams,
  signatureWebParams,
  randomString,
  decodeLyrics,
  parseCookieString,
  cookieToJson,
  publicLiteRasKey,
  publicRasKey,
  randomNumber,
  calculateMid
};

Object.defineProperties(exported, {
  appid: { enumerable: true, get: () => getRuntimeAppid() },
  clientver: { enumerable: true, get: () => getRuntimeClientver() },
  srcappid: { enumerable: true, get: () => getRuntimeSrcAppid() },
  isLite: { enumerable: true, get: () => isLiteRuntime() }
});

module.exports = exported;
