const util = require('../util');

// 鏍规嵁 album_audio_id/MixSongID 鑾峰彇姝屾洸 鐩稿搴旂殑 mv
module.exports = (params, useAxios) => {
  const { appid, clientver } = util;
  const resource = (params?.album_audio_id || '').split(',').map((s) => ({ album_audio_id: s }));

  const paramsMap = {
    data: resource,
    fields: params.fields || '',
    appid,
    clientver,
  };

  return useAxios({
    url: '/kmr/v1/audio/mv',
    method: 'POST',
    data: paramsMap,
    encryptType: 'android',
    cookie: params?.cookie || {},
    headers: { 'x-router': 'openapi.kugou.com', 'KG-TID': 38 },
  });
};
