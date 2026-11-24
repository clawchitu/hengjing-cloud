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

## 截图对比

- 用例在 `e2e/`，基线在 `e2e/__screenshots__/`。覆盖登录页、经销商和管理员两个角色的 8 个主要页面，以及 4 种项目状态（混合传感器、无 PM2.5/CO₂、新风单机版、离线）下的 4 个设备页。
- 只在 `mcr.microsoft.com/playwright:v1.65.1-noble`（linux/amd64）里生成和比对，本机与 CI 渲染一致。不要用本机浏览器直接录基线。
- 测试中时钟固定为 2026-01-15 10:00（北京时间），随机数固定种子，`/api/**` 请求一律拦截，不连任何真实后端。
- CI 失败时会上传 `playwright-report`（含差异图）和本次截图作为 artifact。
- 升级 `@playwright/test` 时，同步修改 `package.json` 脚本和 `.github/workflows/ci.yml` 里的镜像版本，并重录基线。

## CI

`.github/workflows/ci.yml`，每个 PR 和 main 的推送都会触发：

1. `checks`：`npm ci` → oxlint → `tsc -b` → vitest → `vite build`
2. `e2e`：在同一个 Playwright 镜像里构建、启动 `vite preview` 并做截图对比

CI 只做检查，不部署。
