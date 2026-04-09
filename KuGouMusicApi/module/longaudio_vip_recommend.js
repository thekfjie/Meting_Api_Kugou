const util = require('../util');

module.exports = (params, useAxios) => {
  const { clientver } = util;
  return useAxios({
    url: `/longaudio/v1/home_new/vip_select_recommend`,
    method: 'post',
    encryptType: 'android',
    data: {album_playlist: []},
    params: {position: '2', clientver},
    cookie: params?.cookie || {},
  });
};
