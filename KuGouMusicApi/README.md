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
