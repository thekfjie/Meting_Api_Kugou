# Meting-API Integration Repo
## Current Deployment Note

The recommended Kugou setup is now:

- `kugou-upstream` for regular/default mode
- `kugou-upstream-lite` for lite/concept mode
- `meting-api` routes `premium/general` to the matching upstream by pool platform

Preferred root env vars:

```bash
METING_KUGOU_UPSTREAM_DEFAULT_URL=http://127.0.0.1:3100
METING_KUGOU_UPSTREAM_LITE_URL=http://127.0.0.1:3101
```

`METING_KUGOU_UPSTREAM_URL` is still accepted as a legacy fallback, but it is no longer the recommended production setup when regular + lite need to run together.

这个仓库不是单一服务，而是一个整合仓库：

- 根目录是 `Meting + Hono` 包装层，对外提供 `/api`、`/music`、`/music/manage`、`/monitor/kugou`。
- `KuGouMusicApi/` 是酷狗 upstream，根层通过 `METING_KUGOU_UPSTREAM_URL` 把它当成 Kugou 的 HTTP upstream 使用。
- 推荐部署方式是 PM2 同时拉起两个进程：`meting-api` 和 `kugou-upstream`。

## 目录结构

```text
Meting-API/
├─ src/                     # 根层 Hono 服务
│  ├─ service/api.js        # 对外 API 主入口
│  ├─ service/admin.js      # 管理页与管理动作
│  ├─ service/kugou-monitor.js
│  └─ utils/
│     ├─ kugou-upstream.js
│     ├─ kugou-upstream-auth.js
│     ├─ kugou-upstream-vip.js
│     ├─ kugou-admin-actions.js
│     └─ kugou-admin-state.js
├─ KuGouMusicApi/           # 酷狗 upstream 子项目
├─ ecosystem.config.cjs     # PM2 双进程配置
├─ cookie/                  # Kugou 文件池，运行后自动生成
└─ data/                    # 管理状态文件，运行后自动生成
```

## 这套集成现在怎么工作

### 根层路由

- `GET /api`
- `GET /music`
- `GET /api/monitor/kugou`
- `GET /monitor/kugou`
- `GET/POST /api/manage/*`
- `GET/POST /music/manage/*`

`/api` 和 `/music` 保持兼容，`type=url` / `type=pic` 仍然返回 `302`。

### Kugou 请求链路

根层会先按 `premium / general / internal` 三种池路由选择 Cookie。

当满足以下条件时，会优先尝试 upstream：

- `server=kugou`
- 池不是 `internal`
- 不是分享歌单特判
- `type` 属于 `song / playlist / lrc / url / pic`

命中 upstream 后，根层会把返回转换成 Meting 风格输出；拿不到数据时，才会回退到原本的 Meting 链路或其他兜底逻辑。

### 调试头

Kugou 请求现在会带上：

- `x-kugou-upstream: hit`
- `x-kugou-upstream: fallback-meting`
- `x-kugou-upstream: miss`

用途：

- `hit`: 本次结果来自 upstream
- `fallback-meting`: 尝试过 upstream，但失败后回退到非 upstream 链路
- `miss`: 这次没有尝试 upstream，例如未配置 upstream、走了游客池、命中其他特判

## 快速开始

### 1. 安装依赖

```bash
npm install
cd KuGouMusicApi && npm install
```

### 2. 配置环境变量

根目录当前没有 `.env.example`，请直接创建 `Meting-API/.env`。

最少建议配置：

```bash
HTTP_PORT=80
METING_URL=https://your-domain.example
METING_TOKEN=replace-me
ADMIN_PASSWORD=replace-me
METING_KUGOU_UPSTREAM_URL=http://127.0.0.1:3100
```

常用根层环境变量：

| 变量 | 说明 |
|---|---|
| `ADMIN_PASSWORD` | 管理页密码 |
| `METING_URL` | 对外访问地址，用于生成资源链接 |
| `METING_TOKEN` | `url / pic / lrc` 的签名密钥 |
| `METING_KUGOU_UPSTREAM_URL` | 指向 `KuGouMusicApi`，典型值 `http://127.0.0.1:3100` |
| `METING_KUGOU_PREMIUM_KEY` | 命中专业池的额外 key |
| `METING_COOKIE_KUGOU_PREMIUM` | 专业池环境变量 Cookie |
| `METING_COOKIE_KUGOU_GENERAL` | 普通池环境变量 Cookie |
| `METING_COOKIE_KUGOU` | Kugou 通用环境变量 Cookie，会影响专业池回退 |
| `METING_COOKIE_ALLOW_HOSTS` | 允许通过 referrer 使用 Cookie 的域名白名单 |
| `METING_KUGOU_ADMIN_LAZY_REFRESH_MS` | 管理页懒刷新窗口，默认 6 小时 |

### 3. 配置 upstream 子项目

`lite` 开关不在根目录 `.env`，而在：

- `KuGouMusicApi/.env`

示例：

```bash
platform=lite
PORT=3100
HOST=127.0.0.1
```

重点：

- `platform=lite` 才表示 upstream 按概念版参数工作
- `KuGouMusicApi` 默认端口实际是 `3100`
- 不同平台的 token 不通用，切换到 `lite` 后应重新登录或刷新

### 4. 启动

开发时可分别启动：

```bash
# 根层
npm run dev

# upstream
cd KuGouMusicApi
npm run dev
```

生产环境推荐 PM2：

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

这会同时启动：

- `meting-api`
- `kugou-upstream`

修改环境变量后建议：

```bash
pm2 restart meting-api --update-env
pm2 restart kugou-upstream --update-env
```

## 管理页

登录入口：

- `/music/manage/login`
- `/api/manage/login`

公开监控页：

- `/music/manage/monitor`
- `/api/manage/monitor`

管理页现在可以直接看到：

- `KuGouMusicApi/.env` 里读到的 `platform`
- `premium / general` 当前实际生效的 Cookie 来源：`env` 还是 `file`
- 当前账号 `userid / vip_type / expire_time`
- 最近一次 refresh 结果
- 最近一次 claim 结果
- 最近一次 upstream 命中或回退状态

管理动作包括：

- 二维码登录写入池
- 短信验证码登录写入池
- 手动 refresh 登录态
- 一键领取概念版会员
- 清空 / 复制 / 迁移文件池

二维码和短信会话、refresh/claim 状态会写入：

- `data/kugou-admin-state.json`

## 文件池与环境变量覆盖

Kugou 的读取顺序是：

1. 环境变量
2. 文件池

也就是说：

- 你在管理页写入的是 `cookie/kugou-premium`、`cookie/kugou-general`
- 但如果环境里还保留着 `METING_COOKIE_KUGOU*`
- 运行时依然优先吃环境变量

这也是“后台明明写了新的概念版 CK，但请求看起来还像旧标准 VIP”的最常见原因。

## 概念版会员领取

根层已经新增：

- `POST /music/manage/kugou/vip/claim`
- `POST /music/manage/kugou/vip/claim-all`
- `POST /api/manage/kugou/vip/claim`
- `POST /api/manage/kugou/vip/claim-all`

行为原则：

- 不做 cron
- 只做按钮触发或手动接口触发
- claim 前会按懒刷新策略先尝试 refresh
- claim 后会重新校验 VIP 状态并写回文件池

如果你想拿 JSON，可以在请求后面加 `?format=json`。

## 常见排查

### 1. 页面显示 `lite`，但实际像还在走标准 VIP

先看三件事：

- 管理页里 `platform` 是否真的是 `lite`
- 当前实际 Cookie 来源是不是 `env`
- 响应头 `x-kugou-upstream` 是 `hit` 还是 `fallback-meting`

典型情况是：

- `platform=lite`
- 但运行时还在吃旧的 `METING_COOKIE_KUGOU*`
- 或者 upstream 失败后静默回退到了非 upstream 链路

### 2. 后台写了 CK，为什么没立刻生效

因为写入的是文件池，而运行时读取是 `env` 优先。

需要先移除或清空对应的 `METING_COOKIE_KUGOU*` 环境变量，再重启进程。

### 3. 为什么 VIP 一过期就失效

之前根层没有“概念版免费会员领取”入口。现在已经接入手动 claim，但它仍然不是定时任务，需要你手动触发或在管理页按需执行。

### 4. 怎么确认这次请求到底有没有走 upstream

看响应头：

- `x-kugou-upstream: hit`
- `x-kugou-upstream: fallback-meting`
- `x-kugou-upstream: miss`

## 关键文件

- `src/service/api.js`
- `src/service/admin.js`
- `src/utils/kugou-upstream.js`
- `src/utils/kugou-upstream-auth.js`
- `src/utils/kugou-upstream-vip.js`
- `src/utils/kugou-admin-actions.js`
- `src/utils/cookie.js`
- `ecosystem.config.cjs`

## Platform Switch Quick Reference

Keep the current single-upstream production deployment in regular mode by using:

```bash
platform=
```

This value belongs to `KuGouMusicApi/.env`, not the root `.env`.

When you want to enable lite later, change only that file to:

```bash
platform=lite
```

Then reload the upstream process:

```bash
pm2 restart kugou-upstream --update-env
```

Notes:

- Do not use `platform=''`; use `platform=` for regular mode.
- After switching between regular and lite, re-login or refresh the Kugou pool because cross-platform token reuse is not guaranteed.
- Example files are provided in `KuGouMusicApi/.env.default.example` and `KuGouMusicApi/.env.lite.example`.
