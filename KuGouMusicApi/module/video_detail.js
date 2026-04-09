const util = require('../util');

// 鑾峰彇瑙嗛璇︽儏
module.exports = (params, useAxios) => {
  const { appid, clientver, signParamsKey, cryptoMd5 } = util;
  const dfid = params?.cookie?.dfid || '-';
  const mid = params?.cookie?.KUGOU_API_MID;
  const uuid = cryptoMd5(`${dfid}${mid}`);
  const token = params?.token || params?.cookie?.token || '';
  const clienttime = Math.floor(Date.now() / 1000);

  const resource = (params.id || '').split(',').map((s) => ({ video_id: s }));

  const dataMap = {
    appid,
    clientver,
    clienttime,
    mid,
    uuid,
    dfid,
    token: token || '',
    key: signParamsKey(clienttime.toString()),
    show_resolution: 1,
    data: resource,
  };

  return useAxios({
    url: '/v1/video',
    method: 'POST',
    data: dataMap,
    encryptType: 'android',
    cookie: params?.cookie || {},
    clearDefaultParams: true,
    headers: { 'x-router': 'kmr.service.kugou.com' },
  });
};
