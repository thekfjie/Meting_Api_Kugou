const qrcode = require('qrcode');
const { getRuntimeAppid } = require('../util/runtime-context');
// 酷狗二维码生成

module.exports = (params, useAxios) => {
  return new Promise(async (resolve) => {
    const url = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(params.key)}&appid=${getRuntimeAppid()}`
    return resolve({
      code: 200,
      status: 200,
      body: {
        code: 200,
        data: {
          url: url,
          base64: params?.qrimg ? await qrcode.toDataURL(url) : '',
        },
      },
    })
  })
}
