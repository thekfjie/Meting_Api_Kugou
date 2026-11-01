# 配置与运行说明

## 1. 配置入口

复制根目录 `.env.example` 为 `.env`。根服务启动时读取当前工作目录的 `.env`；PM2 配置读取仓库根目录的 `.env`。已有进程环境变量优先。

Compose 从根目录 `.env` 向 API 注入配置，并覆盖容器内部端口和两个上游地址。宿主机的 `3100 / 3101` 不能用于容器内的跨服务通信。

### API 与管理页

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HTTP_PORT` | `80` | API 端口；示例与容器使用 `3000` |
| `HTTP_PREFIX` | 空 | 路由前缀，如 `/meting`；`/healthz` 固定在根路径 |
| `METING_URL` | 空 | 客户端访问的基址；有前缀时填写如 `https://example.com/meting` |
| `METING_TOKEN` | `token` | 资源签名密钥，部署时替换 |
| `ADMIN_PASSWORD` | 空 | 管理页密码，未配置时管理动作不可用 |
| `ADMIN_SESSION_SECRET` | 回退到 `METING_TOKEN` | 管理会话签名密钥 |
| `ADMIN_SESSION_TTL_MS` | `43200000` | 会话有效期，12 小时 |
| `METING_BIND_PORT` | `3000` | 仅用于 Compose 的宿主机端口 |
| `NODE_IMAGE` | `node:22-alpine` | Docker 构建用的 Node 基础镜像；可指定可访问的官方镜像副本 |
| `TZ` | 运行环境时区 | 调度使用进程本地时区；示例为 `Asia/Shanghai` |

原有内置 HTTPS 支持 `HTTPS_ENABLED`、`HTTPS_PORT`、`SSL_KEY_PATH`、`SSL_CERT_PATH`。Compose 示例使用外部反向代理终止 TLS。

### 酷狗平台与上游

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `METING_KUGOU_UPSTREAM_DEFAULT_URL` | 空 | 普通版上游；本地示例 `http://127.0.0.1:3100` |
| `METING_KUGOU_UPSTREAM_LITE_URL` | 空 | 概念版上游；本地示例 `http://127.0.0.1:3101` |
| `METING_KUGOU_UPSTREAM_URL` | 空 | 旧兼容项，作为未显式配置的平台地址的回退 |
| `METING_KUGOU_UPSTREAM_TIMEOUT_MS` | `8000` | 单次请求超时 |
| `METING_KUGOU_PREMIUM_PLATFORM` | `default` | premium 池平台，`default` 或 `lite` |
| `METING_KUGOU_GENERAL_PLATFORM` | `lite` | general 池平台 |
| `METING_KUGOU_PREMIUM_KEY` | 空 | 显式选择 premium 池的访问 key |
| `METING_COOKIE_ALLOW_HOSTS` | 空 | 逗号分隔的 Referer 域名白名单 |

旧变量 `METING_KUGOU_UPSTREAM_URL` 让两个池共用上游，适用于两个池使用相同平台的场景。普通版与概念版并行时，分别设置两个 URL，并按对应平台重新登录。

PM2 的 `KUGOU_UPSTREAM_DEFAULT_PORT` / `KUGOU_UPSTREAM_LITE_PORT` 可以修改监听端口，修改时也要同步两个 `METING_KUGOU_UPSTREAM_*_URL`。

设备身份可使用 `KUGOU_API_DEFAULT_GUID`、`KUGOU_API_DEFAULT_DEV`、`KUGOU_API_DEFAULT_MAC` 及对应的 `KUGOU_API_LITE_*` 变量固定；PM2、Compose 会传给对应上游。

## 2. 账号池与持久化

| 池 | 默认平台 | Cookie 读取顺序 |
| --- | --- | --- |
| `premium` | 普通版 | `METING_COOKIE_KUGOU_PREMIUM` → `METING_COOKIE_KUGOU` → `cookie/kugou-premium` → `cookie/kugou` |
| `general` | 概念版 | `METING_COOKIE_KUGOU_GENERAL` → `cookie/kugou-general` |
| `internal` | 游客 | 不使用账号 Cookie |

有效的 premium key 选择 premium 池。白名单 Referer 命中的博客歌单曲目也可选择 premium；其余请求走 general。general 额度耗尽时回退到游客线路，premium 额度耗尽返回 `429`。

`BLOG_DATA_DIR` 默认 `./blog-data`，读取可选的 `kugou_playlist.yml`、`liked_playlist.yml` 曲目白名单。Docker 部署可为 API 额外挂载该目录到 `/app/blog-data:ro`。

文件池位于 `cookie/kugou-premium`、`cookie/kugou-general`，管理状态位于 `data/kugou-admin-state.json`。备份 `cookie/` 和 `data/`，不要提交其中内容；容器内由命名卷保存。

管理页写入文件不会覆盖环境变量。要由管理页接管，移除相应环境变量 Cookie 后重新加载进程。自动调度面向文件池；只在环境变量中配置 Cookie 的账号，不会得到与文件池完全相同的自动维护行为。

## 3. 自动刷新与概念版领取

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `METING_KUGOU_SCHEDULER_INTERVAL_MS` | `60000` | 调度检查间隔，下限 30 秒 |
| `METING_KUGOU_AUTO_REFRESH_BASE_MS` | `21600000` | 常规刷新间隔，6 小时 |
| `METING_KUGOU_AUTO_REFRESH_JITTER_MS` | `3600000` | 刷新间隔随机偏移范围，±1 小时 |
| `METING_KUGOU_AUTO_REFRESH_RETRY_MS` | `1800000` | 刷新失败的重试基准间隔 |
| `METING_KUGOU_PREMIUM_AUTO_CLAIM` | 关闭 | premium 自动领取，仅 lite 生效 |
| `METING_KUGOU_GENERAL_AUTO_CLAIM` | 开启 | general 自动领取，仅 lite 生效 |
| `METING_KUGOU_AUTO_CLAIM_START_HOUR` | `9` | 领取窗口起点，进程本地时区 |
| `METING_KUGOU_AUTO_CLAIM_END_HOUR` | `21` | 领取窗口终点 |

下次执行时间及最近结果保存在管理状态中。手动操作要求管理登录态：

```text
POST /music/manage/kugou/refresh
POST /music/manage/kugou/vip/claim
POST /music/manage/kugou/vip/claim-all
```

也支持 `/api/manage/...` 别名；需要 JSON 时加 `?format=json`。更换池平台后重新登录，避免混用普通版和概念版 token。

## 4. 缓存与限流

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `METING_CACHE_DEFAULT_MS` | `3600000` | 普通响应缓存，1 小时 |
| `METING_KUGOU_URL_CACHE_MS` | `600000` | 播放地址缓存，10 分钟 |
| `METING_KUGOU_SHARE_PLAYLIST_CACHE_MS` | `1800000` | 分享歌单缓存，30 分钟 |
| `METING_KUGOU_PREMIUM_MAX_RPM` | `60` | premium 每分钟额度 |
| `METING_KUGOU_GENERAL_MAX_RPM` | `180` | general 每分钟额度 |

缓存与分钟额度是进程内状态，重启后重置；账号和调度状态保存在文件中。

## 5. 故障排查

| 现象 | 检查项 |
| --- | --- |
| API 正常，酷狗无法登录或播放 | 检查两个上游的存活状态、URL、池平台和 Cookie 来源 |
| 管理页写入账号，请求仍像旧账号 | 清理相应环境变量 Cookie，确认来源为 `file` |
| 平台显示 lite，会员能力不一致 | 确认指向概念版上游并重新登录，检查领取结果和有效期 |
| Docker 内连接 localhost:3100 失败 | 使用 Compose 服务名地址，容器的 localhost 相互独立 |
| 返回的音频 / 图片链接地址错误 | 修正 `METING_URL`，确保协议、域名和前缀对应 |
| 概念版音频 CDN 的 HTTPS 证书不匹配 | 播放链接经同站 `/music/stream` 签名接口转发 HTTP 音频，保留 Range / 206；反向代理须转发此路径 |
| 容器管理页的 PM2 按钮不可用 | 使用 `docker compose restart 服务名` 管理进程 |

`x-cache` 表示缓存命中情况，`x-kugou-route` 表示池路由。`x-kugou-upstream` 的含义：

- `hit`：结果来自酷狗上游。
- `fallback-meting`：已尝试酷狗上游，失败后使用兼容链路。
- `miss`：未尝试酷狗上游，例如操作不受支持、地址未配置、游客或分享歌单线路。

根服务请求日志会隐藏 Cookie、Authorization、Set-Cookie，错误日志中的认证参数也会脱敏。原始数据调试日志和上游日志应单独检查后再分享。
