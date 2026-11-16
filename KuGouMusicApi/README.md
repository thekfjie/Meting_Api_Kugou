# KuGouMusicApi 上游

本目录是整合仓库内维护的酷狗 HTTP 上游，保留 Express / CommonJS 实现。部署入口见 [根目录 README](../README.md)，底层接口见 [接口文档](docs/README.md)。

## 普通版与概念版

两种平台使用独立进程和登录态：

| 进程 | 平台 | PM2 本地端口 | Compose 内部端口 |
| --- | --- | --- | --- |
| `kugou-upstream` | `default` | `3100` | `3100` |
| `kugou-upstream-lite` | `lite` | `3101` | `3100` |

PM2 / Compose 已固定各自平台，不需要切换同一个 `.env` 来运行两个版本。根服务根据账号池的平台选择上游。

## 单独启动

在仓库根目录执行 `npm run setup` 后，可用以下两个命令分别启动：

```bash
npm run start:upstream
npm run start:upstream:lite
```

也可进入本目录后运行 `npm start -- --platform=lite --port=3101`。直接启动时从本目录 `.env` 读取配置，命令行覆盖 `platform`、`PORT` 等值。

设备身份可由 `KUGOU_API_GUID`、`KUGOU_API_DEV`、`KUGOU_API_MAC` 固定；代理使用 `KUGOU_API_PROXY`。`.env.default.example`、`.env.lite.example` 提供单独启动的配置示例。

## 构建与检查

统一镜像从仓库根目录构建：

```bash
docker build --target upstream -t meting-kugou-upstream .
```

`GET /healthz` 返回进程存活状态，不注册设备、不查询账号、不调用酷狗远端。测试文件不会被动态加载为 HTTP 路由。

原始接口模块及 MIT 许可继续保留。普通版与概念版 token 不应混用，登录、刷新、领取由根服务管理。

## 上游维护

本目录基于 `1.5.1`，按需回移上游修复，保留本项目的平台、设备身份和登录态隔离实现。已核对至 [MakcRe/KuGouMusicApi `443d4a4`](https://github.com/MakcRe/KuGouMusicApi/commit/443d4a416dd344ccf7b022b9fb932e324afc77b4)（2026-11-13，版本 `1.6.3`），并非完整同步该版本。

| 修复 | 上游来源 |
| --- | --- |
| 设备注册优先 `/risk/v3/r_register_dev` | [`1c73c64`](https://github.com/MakcRe/KuGouMusicApi/commit/1c73c649e69d8b186786aae7c78d88a76c12ae6d) |
| 概念版歌曲、专辑搜索使用网关与对应客户端参数 | [`b34a8b1`](https://github.com/MakcRe/KuGouMusicApi/commit/b34a8b14de0f3de73067b5141456e254176472e0) |
| `/song/url/new` 使用网关与 `x-router`，连接使用 HTTPS | [`f9d9a08`](https://github.com/MakcRe/KuGouMusicApi/commit/f9d9a087731c1a0c7caf8aaf14f16bbfdbe179b1) |
| 丢弃 JSON 的 `__proto__`，参数使用无原型对象，非法错误状态回退至 500 | [`443d4a4`](https://github.com/MakcRe/KuGouMusicApi/commit/443d4a416dd344ccf7b022b9fb932e324afc77b4) |
| RSA 依赖 `node-forge` 固定为 `1.4.1` | [`5d6c9f7`](https://github.com/MakcRe/KuGouMusicApi/commit/5d6c9f7b180279c9dd08bc6f7159de52a856d587) |

本地请求层额外设置 8 秒截止时间，传输错误仅返回错误分类，不序列化 Axios 请求对象；访问日志不记录查询串。保留原来的请求体封装和 100 KB JSON 限制。未引入上传、聊天等新接口，也未引入 `pkg`、`tsdown` 或新的运行依赖。

杭州实测概念版 v3 偶尔返回 `status=1` 但 `dfid` 为空；此时携带相同设备身份回退 v2 一次。两次都没有有效标识时返回 502，避免写入空的或 `undefined` 的设备 Cookie。网络错误不自动重试。

后续更新应逐项合并模块和请求层，保留 `runtime-context.js`、登录时保存的设备字段、测试模块过滤和根服务的缓存绕过机制。根目录 `npm test` 同时验证这些兼容行为及 core 的 QQ 搜索回归。
