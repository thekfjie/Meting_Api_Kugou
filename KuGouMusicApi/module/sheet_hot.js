const util = require('../util');

// 鎺ㄨ崘涔愯氨
module.exports = (params, useAxios) => {
  const { srcappid } = util;
  const paramsMap = {
    srcappid,
    opern_type: params.opern_type ?? 1,
  };

  return useAxios({
    url: '/miniyueku/v1/opern_square/get_home_hot_opern',
    encryptType: 'web',
    method: 'GET',
    params: paramsMap,
    cookie: params?.cookie || {},
  });
};
