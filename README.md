# 恒境云（hengjing-cloud）

恒境云 HVAC 物联网管理平台前端。Vite + React + TypeScript + ECharts，当前使用 `src/mock/` 里的演示数据。

- 开发方案：[`docs/plan-v1.md`](docs/plan-v1.md)
- 部署说明：[`docs/deploy.md`](docs/deploy.md)（线上演示版 https://hvac-demo.haoqianglyu.com ）

## 协作约定：所有改动走 PR

本仓库是 GitHub 私有库，**没有开启分支保护**（私有库当前套餐不支持），技术上可以直接推 main。约定如下：

- **不直接推送 main**。每段工作新建分支，开 PR 合并。
- PR 按模板（`.github/pull_request_template.md`）填写：改动、测试、截图、评审结论。
- 合并前 CI 必须全绿，并通过评审。
- 界面有意变化时，同一个 PR 里更新截图基线并逐条说明原因。

## 常用命令

需要 Node ≥ 22.12。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发服务器 |
| `npm run lint` | 代码规范检查（oxlint，配置见 `.oxlintrc.json`） |
| `npm run typecheck` | 类型检查（`tsc -b`，各 tsconfig 已设 `noEmit`） |
| `npm test` | 单元测试（vitest，用例放在 `src/**/*.test.ts`） |
| `npm run build` | 类型检查并构建到 `dist/` |
| `npm run e2e` | 在 Playwright 官方镜像里跑截图对比（需要 Docker） |
| `npm run e2e:update` | 同上，并重写截图基线 |
| `npm run gen:proto` | 由 `proto/ctrl200.proto` 重新生成 ctrl 编解码（`src/api/gen/`） |
| `npm run test:live` | 手动联调：连测试环境跑只读冒烟（login → me → 项目 → ctrl 读 → 刷新），账号从 macOS 钥匙串 `hengjing-admin` / `hengjing-dealer` 读取；CI 不跑 |

## 接口层与运行时配置

- `src/api/`：`config.ts` 运行时配置，`http.ts` 请求封装与令牌续期，`errors.ts` 错误归一，`ctrl.ts` ctrl 同步消息（`callCtrl`），`guard.ts` 写操作防护，`values.ts` 特殊值（-1 不变、65536 无数据），`query.ts` TanStack Query 默认值。`index.ts` 仍是演示数据，现有页面不变。
- 部署时改 `public/config.js`（`window.__HJC_CONFIG__`）即可换后端；构建时可用 `VITE_API_BASE`、`VITE_API_ENV`、`VITE_DATA_SOURCE`、`VITE_WRITE_MODE` 设默认值。
- `npm run dev` 时 `/api/*` 代理到测试环境 `https://test.cosyhome.com.cn:9443/v1`（`VITE_PROXY_TARGET` 可改），`/api/login` 除外（演示版 Worker）。
- 下发类接口默认只在测试环境放行；判断不出环境按生产处理；生产下发须在 `config.js` 显式写 `writeMode: 'on'`。

## 截图对比

- 用例在 `e2e/`，基线在 `e2e/__screenshots__/`。`pages.spec.ts` 覆盖登录页、两个角色的 8 个主要页面、5 种项目状态（混合传感器、无 PM2.5/CO₂、新风单机版、单机版模式 6、离线）下的 4 个设备页；`states.spec.ts` 覆盖由 `scripts/shoot.mjs` 迁移的交互状态（常用项目数量、顶栏搜索、新风 5 种模式、统一控制混合选择与无房间布局、管理员切换/搜索经销商）。
- 比较门槛：`threshold: 0`（逐像素颜色严格），`maxDiffPixels: 0`，不允许任何像素差异。
- 只在 `mcr.microsoft.com/playwright:v1.65.1-noble`（linux/amd64）里生成和比对，本机与 CI 渲染一致。不要用本机浏览器直接录基线。
- 测试中时钟固定为 2026-01-15 10:00（北京时间），随机数固定种子，`/api/**` 请求一律拦截，不连任何真实后端。
- CI 失败时会上传 `playwright-report`（含差异图）和本次截图作为 artifact。
- 升级 `@playwright/test` 时，同步修改 `package.json` 脚本和 `.github/workflows/ci.yml` 里的镜像版本，并重录基线。

## CI

`.github/workflows/ci.yml`，每个 PR 和 main 的推送都会触发：

1. `checks`：`npm ci` → oxlint → `tsc -b` → vitest → `vite build`
2. `e2e`：在同一个 Playwright 镜像里构建、启动 `vite preview` 并做截图对比

CI 只做检查，不部署。
