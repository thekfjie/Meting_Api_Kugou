const util = require('../util');

// 涔愯氨璇︽儏
module.exports = (params, useAxios) => {
  const { srcappid } = util;
  const paramsMap = {
    srcappid,
    position: params.position ?? 2
  };

  return useAxios({
    url: '/miniyueku/v1/opern_square/get_home_module_config',
    encryptType: 'web',
    method: 'GET',
    params: paramsMap,
    cookie: params?.cookie || {},
  });
};
