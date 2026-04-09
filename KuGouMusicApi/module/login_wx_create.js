const axios = require('axios');
const { cryptoMd5, cryptoSha1, randomString } = require('../util');
const { getRuntimeWxAppid, getRuntimeWxSecret } = require('../util/runtime-context');

const accessToken = () => {
  const appid = getRuntimeWxAppid();
  const secret = getRuntimeWxSecret();
  return axios({ url: 'https://api.weixin.qq.com/cgi-bin/token', params: { appid, secret, grant_type: 'client_credential' } });
};

/**
 *
 * @param {string} accessToken
 * @returns
 */
const ticket = (accessToken) => axios({ url: 'https://api.weixin.qq.com/cgi-bin/ticket/getticket', params: { access_token: accessToken, type: 2 } });

module.exports = (params, useAxios) => {
  const answer = { status: 500, body: {}, cookie: [] };
  return new Promise(async (resolve, reject) => {
    try {
      const accessTokenResp = await accessToken();
      if (accessTokenResp.data?.access_token) {
        const ticketResp = await ticket(accessTokenResp.data.access_token);

        if (ticketResp.data?.errcode === 0) {
          const appid = getRuntimeWxAppid();
          const ticket = ticketResp.data.ticket;
          const timestamp = Date.now();
          const noncestr = cryptoMd5(randomString());
          const signaturePrams = `appid=${appid}&noncestr=${noncestr}&sdk_ticket=${ticket}&timestamp=${timestamp}`;
          const signature = cryptoSha1(signaturePrams);
          const params = { appid: appid, noncestr, timestamp, scope: 'snsapi_userinfo', signature };
          const connect = await axios({ url: 'https://open.weixin.qq.com/connect/sdk/qrconnect', params });

          if (connect.data?.errcode === 0) {
            answer.status = 200;
            connect.data.qrcode['qrcodeurl'] = `https://open.weixin.qq.com/connect/confirm?uuid=${connect.data.uuid}`;
            answer.body = connect.data;
            resolve(answer);
          } else {
            answer.status = 502;
            answer.body = { status: 0, msg: connect.data };
            reject(answer);
          }
        } else {
          answer.status = 502;
          answer.body = { status: 0, msg: ticketResp.data };
          reject(answer);
        }
      } else {
        answer.status = 502;
        answer.body = { status: 0, msg: accessTokenResp.data };
        reject(answer);
      }
    } catch (e) {
      answer.status = 502;
      answer.body = { status: 0, msg: e };
      reject(answer);
    }
  });
};
