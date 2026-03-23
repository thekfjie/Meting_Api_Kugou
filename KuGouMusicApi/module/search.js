// 搜索
module.exports = (params, useAxios) => {
  const type = ['special', 'lyric', 'song', 'album', 'author', 'mv'].includes(params.type) ? params.type : 'song';

  if (type === 'song') {
    return useAxios({
      baseURL: 'https://mobiles.kugou.com',
      url: '/api/v3/search/song',
      method: 'GET',
      params: {
        format: 'json',
        keyword: params?.keywords || '',
        page: params?.page || 1,
        pagesize: params?.pagesize || 30,
        showtype: 1
      },
      clearDefaultParams: true,
      notSignature: true,
      cookie: params?.cookie || {}
    })
  }

  const dataMap = {
    albumhide: 0,
    iscorrection: 1,
    keyword: params?.keywords || '',
    nocollect: 0,
    page: params?.page || 1,
    pagesize: params?.pagesize || 30,
    platform: 'AndroidFilter'
  }

  return useAxios({
    url: `/${type === 'song' ? 'v3' : 'v1'}/search/${type}`,
    method: 'GET',
    params: dataMap,
    encryptType: 'android',
    headers: { 'x-router': 'complexsearch.kugou.com' },
    cookie: params?.cookie || {},
  });
};
