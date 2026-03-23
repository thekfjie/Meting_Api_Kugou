# Meting-API

基于 Hono.js 的多平台音乐 API 代理服务,封装 [@meting/core](https://www.npmjs.com/package/@meting/core) 提供的统一音乐 API。

## 特性

- 🎵 支持多个音乐平台:网易云、QQ音乐、酷狗、百度、酷我
- 🚀 基于 Hono.js 高性能框架
- 💾 内置 LRU 缓存机制,减少上游 API 调用
- 🔐 HMAC-SHA1 令牌鉴权,保护敏感接口
- 🔄 支持把 `KuGouMusicApi` 作为酷狗上游接入,保留 Meting 风格输出与 302 跳转语义
- 🐳 Docker 部署支持
- 📝 结构化 JSON 日志输出

## 支持的平台

| 平台 | server 参数 | 说明 |
|------|------------|------|
| 网易云音乐 | `netease` | - |
| QQ音乐 | `tencent` | - |
| 酷狗音乐 | `kugou` | - |
| 百度音乐 | `baidu` | - |
| 酷我音乐 | `kuwo` | - |

## 快速开始

### 一键部署

|平台|链接|
|---|---|
|Koyeb|[![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?name=meting-api&type=docker&image=ghcr.io%2Fmetowolf%2Fmeting-api%3Alatest&instance_type=free&regions=was&instances_min=0&autoscaling_sleep_idle_delay=300&env%5BMETING_URL%5D=https%3A%2F%2F%7B%7B+KOYEB_PUBLIC_DOMAIN+%7D%7D&ports=80%3Bhttp%3B%2F&hc_protocol%5B80%5D=tcp&hc_grace_period%5B80%5D=5&hc_interval%5B80%5D=30&hc_restart_limit%5B80%5D=3&hc_timeout%5B80%5D=5&hc_path%5B80%5D=%2F&hc_method%5B80%5D=get)|


### 本地运行

```bash
# 安装依赖
yarn install

# 配置环境变量(可选)
cp .env.example .env
# 编辑 .env 文件配置参数

# 开发模式(热重载)
yarn dev

# 生产模式
yarn start
```

### PM2 部署

如果你希望把 `Meting-API` 和 `KuGouMusicApi` 一起交给 PM2 托管,建议把两个项目放在同级目录:

```text
E:/my_service/
  ├── Meting-API/
  └── KuGouMusicApi/
```

然后在 `Meting-API` 根目录执行:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

该配置会同时启动:

- `meting-api`: 当前服务
- `kugou-upstream`: 指向同级目录下的 `KuGouMusicApi`

如果服务器上之前只托管了 `meting-api`, 拉取更新后需要额外执行一次:

```bash
pm2 start ecosystem.config.cjs --only kugou-upstream
pm2 save
```

如果你已经用反向代理把 `Meting-API` 暴露为例如 `https://api.kfjie.me/api`, 后台页会自动复用同一个前缀:

- 未登录访问 `https://api.kfjie.me/api/admin` 时,只显示基础监控信息
- 登录后访问同一路径,就会进入完整后台页

两个服务各自读取自己目录内的 `.env` 文件,因此修改环境变量后需要执行:

```bash
pm2 restart meting-api --update-env
pm2 restart kugou-upstream --update-env
```

### Docker 部署

```bash
# 构建镜像
docker build -t meting-api .

# 运行容器
docker run -d \
  -p 80:80 \
  -e METING_URL=https://your-domain.com \
  -e METING_TOKEN=your-secret-token \
  --name meting-api \
  meting-api
```

使用 Docker Compose:

```yaml
version: '3.8'
services:
  meting-api:
    image: ghcr.io/metowolf/meting-api:latest
    ports:
      - "80:80"
    environment:
      - METING_URL=https://your-domain.com
      - METING_TOKEN=your-secret-token
    restart: unless-stopped
```

## HTTPS 配置

### 开发环境

使用自签名证书进行本地调试:

```bash
mkdir -p certs
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout certs/local.key \
  -out certs/local.crt \
  -subj "/CN=localhost"
```

在启动服务时配置:

```bash
HTTPS_ENABLED=true \
SSL_KEY_PATH=certs/local.key \
SSL_CERT_PATH=certs/local.crt \
yarn start
```

### 生产环境

推荐使用 [Let's Encrypt](https://letsencrypt.org/) 提供的免费证书,通过 [Certbot](https://certbot.eff.org/) 自动签发与续期。例如在 Nginx 部署的服务器上:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --nginx -d your-domain.com
```

证书获取后,将 `fullchain.pem` 和 `privkey.pem` 文件路径配置到对应环境变量。

### Docker HTTPS 部署示例

```bash
docker run -d \
  -p 80:80 \
  -p 443:443 \
  -v /etc/letsencrypt/live/your-domain.com:/certs:ro \
  -e HTTPS_ENABLED=true \
  -e SSL_KEY_PATH=/certs/privkey.pem \
  -e SSL_CERT_PATH=/certs/fullchain.pem \
  -e METING_URL=https://your-domain.com \
  --name meting-api \
  meting-api
```

### 反向代理推荐

生产环境可搭配 Nginx 或 Caddy 作为反向代理,实现自动证书管理和负载均衡:
- [Nginx HTTPS 配置示例](https://docs.nginx.com/nginx/admin-guide/security-controls/terminating-ssl-http/)
- [Caddy 自动 HTTPS 说明](https://caddyserver.com/docs/automatic-https)


## 环境变量配置

创建 `.env` 文件或通过环境变量传递:

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `HTTP_PREFIX` | HTTP 路由前缀 | `` (空) |
| `HTTP_PORT` | HTTP 服务监听端口 | `80` |
| `ADMIN_PASSWORD` | 后台管理页登录密码 | `` (空,禁用后台) |
| `ADMIN_SESSION_SECRET` | 后台会话签名密钥 | `METING_TOKEN` |
| `ADMIN_SESSION_TTL_MS` | 后台登录会话有效期 | `43200000` |
| `HTTPS_ENABLED` | 是否启用 HTTPS 服务 | `false` |
| `HTTPS_PORT` | HTTPS 服务监听端口 | `443` |
| `SSL_KEY_PATH` | HTTPS 私钥文件路径 | - |
| `SSL_CERT_PATH` | HTTPS 证书文件路径 | - |
| `METING_URL` | API 服务的公网访问地址(用于生成回调 URL) | - |
| `METING_TOKEN` | HMAC 签名密钥 | `token` |
| `METING_KUGOU_PREMIUM_KEY` | 酷狗 Pro 池访问 Key,命中后可在额度内直连 Pro 池 | `` (空) |
| `METING_KUGOU_UPSTREAM_URL` | 可选的酷狗 HTTP 上游地址,例如 `http://127.0.0.1:3100` | `` (空,关闭) |
| `METING_COOKIE_ALLOW_HOSTS` | 允许使用 cookie 的 referrer 域名白名单(逗号分隔) | `` (空,不限制) |
| `METING_COOKIE_NETEASE` | 网易云音乐 Cookie | - |
| `METING_COOKIE_TENCENT` | QQ音乐 Cookie | - |
| `METING_COOKIE_KUGOU` | 酷狗音乐 Cookie | - |
| `METING_COOKIE_BAIDU` | 百度音乐 Cookie | - |
| `METING_COOKIE_KUWO` | 酷我音乐 Cookie | - |

## API 接口文档

### 基础接口

```
GET /api
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `server` | string | 是 | 音乐平台:`netease`/`tencent`/`kugou`/`baidu`/`kuwo` |
| `type` | string | 是 | 操作类型:`search`/`song`/`album`/`artist`/`playlist`/`lrc`/`url`/`pic` |
| `id` | string | 是 | 资源 ID |
| `token` 或 `auth` | string | 条件 | 认证令牌(仅 `lrc`/`url`/`pic` 类型需要) |

### 操作类型说明

| type | 说明 | 需要鉴权 | 返回格式 |
|------|------|----------|----------|
| `search` | 搜索歌曲 | 否 | JSON 数组 |
| `song` | 获取歌曲详情 | 否 | JSON 数组 |
| `album` | 获取专辑 | 否 | JSON 数组 |
| `artist` | 获取歌手 | 否 | JSON 数组 |
| `playlist` | 获取歌单 | 否 | JSON 数组 |
| `lrc` | 获取歌词 | 是 | 纯文本(LRC 格式) |
| `url` | 获取播放链接 | 是 | 302 重定向 |
| `pic` | 获取封面图片 | 是 | 302 重定向 |

### 响应格式

**列表数据** (search/song/album/artist/playlist):

```json
[
  {
    "title": "歌曲名称",
    "author": "艺术家1 / 艺术家2",
    "url": "https://your-domain.com/api?server=netease&type=url&id=xxx&auth=xxx",
    "pic": "https://your-domain.com/api?server=netease&type=pic&id=xxx&auth=xxx",
    "lrc": "https://your-domain.com/api?server=netease&type=lrc&id=xxx&auth=xxx"
  }
]
```

**歌词数据** (lrc):

```
[00:00.000] 歌词第一行
[00:05.123] 歌词第二行 (翻译内容)
[00:10.456] 歌词第三行
```

**音频/图片** (url/pic):
- 成功:302 重定向到实际资源 URL
- 失败:404 Not Found

### 请求示例

搜索歌曲:
```bash
curl "http://localhost:80/api?server=netease&type=search&id=周杰伦"
```

获取歌曲详情:
```bash
curl "http://localhost:80/api?server=netease&type=song&id=歌曲ID"
```

获取歌词(需要 token):
```bash
curl "http://localhost:80/api?server=netease&type=lrc&id=歌曲ID&auth=计算的token"
```

### 鉴权机制

敏感操作(`lrc`、`url`、`pic`)需要提供 HMAC-SHA1 签名的 token:

```javascript
// Token 计算公式
token = HMAC-SHA1(METING_TOKEN, server + type + id)
```

示例(使用 Node.js):
```javascript
const crypto = require('crypto');

function generateToken(server, type, id, secret = 'token') {
  const message = `${server}${type}${id}`;
  return crypto.createHmac('sha1', secret).update(message).digest('hex');
}

const token = generateToken('netease', 'url', '123456');
```

## 缓存策略

- 默认缓存容量:1000 条记录
- 缓存时长:
  - `url` 类型:10 分钟
  - 其他类型:1 小时
- 响应头 `x-cache`:
  - `miss`:缓存未命中,调用上游 API
  - 无此头:缓存命中

## Cookie 配置

部分音乐平台的 API 需要登录态才能访问完整数据。可以通过以下两种方式配置 Cookie:

### 方式一:环境变量(推荐)

通过环境变量 `METING_COOKIE_大写平台名` 配置:

```bash
# Docker 部署示例
docker run -d \
  -p 80:80 \
  -e METING_COOKIE_NETEASE="your_netease_cookie" \
  -e METING_COOKIE_TENCENT="your_tencent_cookie" \
  --name meting-api \
  meting-api
```

### 方式二:文件存储

在项目根目录 `cookie/` 文件夹下创建以平台名命名的文件(无扩展名):

```
cookie/
  ├── netease    # 网易云音乐 Cookie
  ├── tencent    # QQ音乐 Cookie
  ├── kugou      # 酷狗音乐 Cookie
  └── ...
```

每个文件存储对应平台的 Cookie 字符串。

### Cookie 优先级

1. 优先从环境变量读取(`METING_COOKIE_NETEASE` 等)
2. 环境变量不存在时从文件读取(`cookie/netease` 等)

### Cookie 缓存

- Cookie 内容会在内存中缓存 5 分钟,减少文件系统读取
- 使用文件存储时,修改 cookie 文件会自动清除缓存,立即生效
- 环境变量方式需要重启服务才能更新

### Referrer 白名单

通过 `METING_COOKIE_ALLOW_HOSTS` 环境变量限制哪些来源可以使用 Cookie:

```bash
# 仅允许特定域名使用 Cookie
METING_COOKIE_ALLOW_HOSTS=example.com,music.example.com
```

不设置时不限制来源。这可以防止 Cookie 被第三方滥用。

## Kugou 监控状态说明

## Kugou Upstream 接入

当配置 `METING_KUGOU_UPSTREAM_URL` 后,`server=kugou` 的以下能力会优先走上游服务:

- `song`
- `playlist`
- `lrc`
- `url`
- `pic`

当前默认保留 `search` 走原有 Meting 搜索链路,因为公开搜索接口波动更大,原链路在大多数场景下更稳。

外层仍保持 Meting 输出格式:

- 列表接口继续返回 `title` / `author` / `url` / `pic` / `lrc`
- `type=url` 继续返回 `302` 到酷狗真实音频地址
- `type=pic` 继续返回 `302` 到酷狗真实封面地址

推荐把上游部署在本机回环地址,例如:

```bash
METING_KUGOU_UPSTREAM_URL=http://127.0.0.1:3100
```

如果上游不可用,当前实现会自动回退到原有链路。

`/monitor/kugou` 用来观察酷狗路由池当前能力。这里有两类字段容易混淆:

### 池子名称

- `Pro`: 命中有效 `key` 或命中 Referrer 白名单的对外池,优先走 Pro Cookie
- `Normal (CK)`: 未命中 Pro 条件的对外普通池,使用 `METING_COOKIE_KUGOU_GENERAL`
- `Internal (Guest)`: 内部匿名基础池,不依赖 Cookie,只在 `/monitor/kugou` 返回中可见

当前运行逻辑中,`Normal (CK)` 超过分钟额度后会自动回退到 `Internal (Guest)`。这时非 VIP 歌通常仍可解析,VIP 歌可能只剩试听能力。

### 能力状态

- `Full access`: VIP 探针歌曲可拿到完整播放链接
- `Preview only`: VIP 探针歌曲只能拿到试听片段,通常约 1 分钟
- `Unavailable`: 对应池子的 Cookie 不可用,或基础探活未通过
- `Probe issue`: 基础探活正常,但 VIP 探针歌曲未返回可用播放链接
- `Guest only`: 基础游客服务可用,但 VIP 探针没有可用播放链接
- `Available`: 基础探活正常,但当前未启用 VIP 探针,只能确认池子可用
- `Minute exhausted`: 当前分钟内计入额度的真实上游请求已用尽,需等待下一分钟刷新

### 额度相关字段

- `currentMinute`: 当前分钟内计入额度的真实上游请求数,只统计未命中缓存的上游解析
- `remainingMinute`: 当前分钟剩余额度
- `exemptRequests`: 已豁免但未计入额度的请求数
- `blockedRequests`: 因分钟额度耗尽而被直接拦截的请求数

## 错误处理

API 返回标准 HTTP 状态码:

| 状态码 | 说明 |
|--------|------|
| 200 | 请求成功 |
| 302 | 重定向到资源(url/pic 类型) |
| 400 | 参数错误 |
| 401 | 鉴权失败 |
| 404 | 资源不存在 |
| 500 | 上游 API 调用失败或返回格式异常 |

错误信息通过响应头 `x-error-message` 返回。

## 开发

### 代码规范

项目使用 ESLint Standard 规范:

```bash
yarn lint
```

### 技术栈

- **运行时**: Node.js 22+ (ES Module)
- **框架**: [Hono](https://hono.dev/) 4.x
- **核心库**: [@meting/core](https://www.npmjs.com/package/@meting/core) 1.5+
- **缓存**: lru-cache 11.x
- **日志**: pino (JSON 格式)
- **加密**: hash.js (HMAC-SHA1)

## 许可证

MIT License

## 相关项目

- [@meting/core](https://www.npmjs.com/package/@meting/core) - Meting 核心库
- [Meting](https://github.com/metowolf/Meting) - PHP 版本
