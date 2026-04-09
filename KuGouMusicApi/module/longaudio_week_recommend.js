const util = require('../util');

module.exports = (params, useAxios) => {
  const { clientver } = util;
  return useAxios({
    url: `/longaudio/v1/home_new/week_new_albums_recommend`,
    method: 'post',
    encryptType: 'android',
    data: {album_playlist: []},
    params: {clientver},
    cookie: params?.cookie || {},
  });
};
