# 项目维护说明

## 入口

- 部署、API 用法以 `README.md` 为准。
- 配置、账号池和故障排查见 `docs/configuration.md`。
- Node.js 22+；统一使用 npm，根项目和上游各自维护 `package-lock.json`。

## 结构

- `src/app.js`：构造 Hono 应用及兼容路由，不启动监听或调度。
- `src/index.js`：HTTP / HTTPS 启动与关闭、自动调度。
- `src/service/api.js`：Meting 输出、签名、缓存与池路由。
- `src/utils/kugou-upstream-client.js`：酷狗 HTTP 请求、超时、JSON 解析。
- `src/utils/kugou-upstream.js`：酷狗资源适配与设备缓存。
- `src/utils/kugou-upstream-auth.js`：登录、资料与 Cookie 处理。
- `KuGouMusicApi/`：内置 Express 上游，普通版 / 概念版分别运行。

## 验证

```bash
npm run setup
npm run lint
npm test
docker compose config --quiet
docker compose build
```

测试使用临时工作目录和本地模拟上游。不要读取实际 Cookie，或以真实账号执行登录、刷新、领取。不要提交 `.env`、`cookie/`、`data/` 或日志。

修改接口时保持 `/api`、`/music` 兼容，保留资源签名及 `url / pic` 的 302 行为。管理路由逐项注册，新增动作同步修改 `src/app.js`。生产镜像只安装锁定的运行依赖。
