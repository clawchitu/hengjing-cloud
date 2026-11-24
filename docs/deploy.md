# 部署说明

> 本文记录 **hvac-demo.haoqianglyu.com 目前的部署方式**（截至 S0，演示数据版本）。S0 只补文档，线上不做任何改动。
> 正式版的变化（`/api/*` 代理、`config.js`、给对方后端的交付包）见 `docs/plan-v1.md` 第 7 节，届时在本文补充。

## 概览

| 项目 | 现状 |
| --- | --- |
| 访问地址 | https://hvac-demo.haoqianglyu.com |
| 托管 | Cloudflare Workers（Workers Static Assets），Worker 名 `hvac-demo` |
| 配置文件 | 仓库根目录 `wrangler.toml` |
| Worker 代码 | `worker/index.js` |
| 静态资源 | `npm run build` 产出的 `dist/` |
| 数据 | 前端内置演示数据（`src/mock/`），不连任何真实后端 |
| 发布方式 | **本机手动** `npx wrangler deploy`；CI 不做自动部署 |

## wrangler.toml 要点

- `name = "hvac-demo"`，`main = "worker/index.js"`。
- `routes = [{ pattern = "hvac-demo.haoqianglyu.com", custom_domain = true }]`：自定义域名直接绑在 Worker 上，`workers_dev = false`（不开 `*.workers.dev` 地址）。
- `[build] command = "npm run build"`：`wrangler deploy` 会先自动构建。
- `[assets] directory = "./dist"`，`binding = "ASSETS"`，`not_found_handling = "single-page-application"`（SPA 回退到 `index.html`），`run_worker_first = true`（所有请求先进 Worker）。
- `[observability] enabled = true`，关闭逐次调用日志（`invocation_logs = false`）。

## Worker 做的事（worker/index.js）

1. `POST /api/login`：校验两个演示账号，返回 `{ ok, role, username }`，失败 401。
   - `cosyhome` → 角色 `dealer`（经销商），密码取 Worker 密钥 `BASIC_PASS`
   - `hjadmin` → 角色 `admin`（管理员），密码取 Worker 密钥 `ADMIN_PASS`
   - 用定长比较防计时攻击；响应 `Cache-Control: no-store`。
2. 其余请求交给 `env.ASSETS`（静态资源 + SPA 回退），并统一加响应头：
   - `X-Robots-Tag: noindex, nofollow`
   - `/assets/*`：`private, max-age=31536000, immutable`（文件名带哈希，长缓存）
   - 其他（含 `index.html`）：`private, no-cache`

已知限制：登录后的角色存在浏览器本地（`hjc-auth`），可被手工篡改；演示版只有 mock 数据，可以接受。正式版改为由后端 `/me` 决定角色。

## 密钥

密码**不进仓库、不进 CI**。真实值存在发布机的 macOS 钥匙串里，以 Worker 密钥形式上传：

```sh
security find-generic-password -s hvac-demo-basic -w | npx wrangler secret put BASIC_PASS
security find-generic-password -s hvac-demo-admin -w | npx wrangler secret put ADMIN_PASS
```

本地调试 Worker 时在仓库根目录放 `.dev.vars`（已在 `.gitignore`），写入假的 `BASIC_PASS` / `ADMIN_PASS`，再 `npx wrangler dev`。

## 发布步骤

前提：本机已 `npx wrangler login` 到对应 Cloudflare 账号；Node ≥ 22.12。

```sh
git checkout main && git pull       # 只发布已合并到 main 的代码
npm ci
npm run lint && npm run typecheck && npm test   # 可选，CI 已跑过
npx wrangler deploy                 # 自动 npm run build，再上传 dist/ 和 worker/index.js
```

发布后检查：

1. 打开 https://hvac-demo.haoqianglyu.com/login，两个演示账号都能登录。
2. 刷新任意子路径（如 `/sensors`）不出现 404。
3. `curl -sI https://hvac-demo.haoqianglyu.com/ | grep -i x-robots-tag` 有 `noindex`。

## 回滚

`npx wrangler deployments list` 查看历史版本，`npx wrangler rollback <版本 ID>` 回到上一版；或在 Cloudflare 控制台 Workers → hvac-demo → Deployments 里回滚。

## 后续计划（未实施）

- 负责人 11/24 决定保留演示版：现 mock 版将挪到 `hvac-mock.haoqianglyu.com`，`hvac-demo` 改接真实接口（见 `docs/plan-v1.md` 7.1 与 Q14）。迁移时更新本文。
