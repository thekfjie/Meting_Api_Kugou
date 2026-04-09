const util = require('../util');

// 涔愯氨鍚堥泦璇︽儏
module.exports = (params, useAxios) => {
  const { srcappid } = util;
  const paramsMap = {
    srcappid,
    page: params.page ?? 1,
    collection_id: params.collection_id
  };

  return useAxios({
    url: '/miniyueku/v1/opern_square/collection_detail',
    encryptType: 'web',
    method: 'GET',
    params: paramsMap,
    cookie: params?.cookie || {},
  });
};
