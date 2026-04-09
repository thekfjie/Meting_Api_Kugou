# KuGouMusicApi Upstream
## Current Deployment Note

This upstream is now expected to run as two PM2 processes in the integration repo:

- `kugou-upstream` on the regular/default platform, typically `127.0.0.1:3100`
- `kugou-upstream-lite` on the lite/concept platform, typically `127.0.0.1:3101`

The root service should point to them with:

```bash
METING_KUGOU_UPSTREAM_DEFAULT_URL=http://127.0.0.1:3100
METING_KUGOU_UPSTREAM_LITE_URL=http://127.0.0.1:3101
```

If only `METING_KUGOU_UPSTREAM_URL` is configured, both pools will share one upstream, which is no longer the preferred regular + lite deployment mode.

这个目录不是原始独立仓库说明页，而是当前整合仓库里的 upstream 子项目说明。

它的职责很明确：

- 作为根层 `Meting-API` 的 Kugou HTTP upstream
- 提供登录、刷新、资料查询、概念版领取、资源解析等底层接口
- 被根层通过 `METING_KUGOU_UPSTREAM_URL` 调用

## 默认启动信息

- 默认端口：`3100`
- 默认入口：`http://127.0.0.1:3100`
- 技术栈：`Express + CommonJS`

根层推荐指向：

```bash
METING_KUGOU_UPSTREAM_URL=http://127.0.0.1:3100
```

## 关键配置

请在当前目录创建 `KuGouMusicApi/.env`。

最关键的项：

```bash
platform=lite
PORT=3100
HOST=127.0.0.1
```

说明：

- `platform=lite` 表示切到概念版参数
- `platform` 不在根目录 `.env` 里配置，而在 `KuGouMusicApi/.env`
- 不同平台的 token 不通用，切到 `lite` 后最好重新登录或 refresh

### 建议固定的设备参数

如果你希望登录态更稳定，建议固定以下环境变量：

- `KUGOU_API_GUID`
- `KUGOU_API_DEV`
- `KUGOU_API_MAC`

服务也会自动补：

- `KUGOU_API_PLATFORM`
- `KUGOU_API_MID`
- `KUGOU_API_GUID`
- `KUGOU_API_DEV`
- `KUGOU_API_MAC`

## 启动

```bash
npm install
npm run dev
```

PowerShell 临时指定端口：

```powershell
$Env:PORT=3100
npm run dev
```

Linux 临时指定端口：

```bash
PORT=3100 npm run dev
```

## 当前集成里最重要的接口

### 登录相关

- `/login/qr/key`
- `/login/qr/create`
- `/login/qr/check`
- `/login/cellphone`
- `/captcha/sent`
- `/login/token`
- `/register/dev`

根层管理页已经接了这些能力，用于：

- 二维码登录
- 短信验证码登录
- refresh 登录态
- 拉取用户资料和 VIP 资料

### 账号资料

- `/user/detail`
- `/user/vip/detail`

### 概念版领取

- `/youth/listen/song`
- `/youth/vip`

根层管理页的一键领取逻辑就是围绕这两个接口展开的。

### 资源解析

根层会优先拿这些接口补强 Kugou 资源：

- `/privilege/lite`
- `/krm/audio`
- `/song/url`
- `/playlist/detail`
- `/playlist/track/all`

## 与根层的配合方式

根层会把这个子项目当成 HTTP upstream。

典型链路：

1. 根层选择 `premium / general / internal` Cookie 池
2. 若配置了 `METING_KUGOU_UPSTREAM_URL`
3. 根层优先调用本目录服务的接口
4. 拿到数据后再转成 Meting 风格输出
5. 如果 upstream 失败，根层才会回退

## 你现在最该关注的不是“能不能启动”，而是“是不是在用 lite”

建议联合根层一起看：

- `KuGouMusicApi/.env` 里的 `platform`
- 根层管理页显示的当前 Cookie 来源是 `env` 还是 `file`
- 根层响应头 `x-kugou-upstream`

如果是下面这种组合：

- `platform=lite`
- 但根层实际来源还是 `METING_COOKIE_KUGOU*`

那就说明运行时仍可能没有真正吃到后台写入的文件池登录态。

## 相关文件

- `server.js`
- `util/index.js`
- `module/login_token.js`
- `module/user_detail.js`
- `module/user_vip_detail.js`
- `module/youth_listen_song.js`
- `module/youth_vip.js`

## Platform Switch Quick Reference

Regular mode keeps the upstream aligned with the normal Kugou client flow:

```bash
platform=
PORT=3100
HOST=127.0.0.1
```

Lite mode can be prepared in the repo without enabling it right now:

```bash
platform=lite
PORT=3100
HOST=127.0.0.1
```

Important:

- `platform=` means regular/default mode.
- `platform=lite` means concept/lite mode.
- Do not use `platform=''`.
- After switching modes, restart the upstream with `pm2 restart kugou-upstream --update-env`.
- Re-login or refresh the related Kugou pool after a mode switch.
- Example files are included as `.env.default.example` and `.env.lite.example`.
