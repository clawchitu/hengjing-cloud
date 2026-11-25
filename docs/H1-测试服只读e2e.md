# H1：测试服只读 e2e 运行说明

`docs/e2e-strategy.md` 的第 4 层（测试服只读）、`docs/e2e-plan-hengjing.md` 第 6 节的 H1。真前端连真实测试服，只做读和「验证拦截」，不下发。不参与 `npm run e2e` 和 CI 的截图比对。

## 1. 前置条件（每次运行前必读，照抄 REVIEW.md 12.6）

- **每次运行只登录一次，全程不续期。** 测试服每登录一次，同一账号在别处的刷新令牌就会失效；多登录一次，就会把 Claw 和强哥浏览器里的登录挤掉。
- **写锁存在各自的浏览器里，不同机器之间不会同步。** 自动测试和人工测试同时操作同一块屏时，写锁拦不住，只能在跑之前去群里打招呼，并避开 Claw 正在用的时段。

另外：

- **跑之前在项目群里说一声**（谁、什么时候、用哪两个账号、预计多久），结束后发结果。
- **每次运行会让两个账号（平台、经销商）在别处的会话失效**：别处已打开的页面最迟在访问令牌到期（2 小时）后被踢回登录页。所以避开 Claw 的走查和下发测试时段。
- 本套用例不做任何下发；温控页只点开关进入确认框再「取消」。

## 2. 怎么跑

| 命令 | 作用 |
| --- | --- |
| `npm run e2e:live` | 默认目标 `local`：本机起 vite 开发服务器（端口 5174），`/api` 经开发代理固定转发到测试服 `https://test.cosyhome.com.cn:9443/v1` |
| `H1_TARGET=demo npm run e2e:live` | 目标改为测试站 `https://hvac-demo.haoqianglyu.com`（`/api/*` 由 Worker 转发到测试服） |
| `npm run e2e:live:dry` | 演练：同一套用例和闸门，开发代理改指向本机假后端（`e2e-live/dry/fake-backend.ts`），不连测试服、不用真实账号。改用例后先跑这个 |
| `npx vitest run e2e-live` | 闸门放行规则的单元测试（也在 `npm test` 里） |

账号：环境变量 `H1_PLATFORM_ACCOUNT` / `H1_PLATFORM_PASSWORD` / `H1_DEALER_ACCOUNT` / `H1_DEALER_PASSWORD`；本机没设时从 macOS 钥匙串读（服务名 `hengjing-test-platform`、`hengjing-test-dealer`，帐户字段是手机号，密码是条目密码）。CI 里必须用环境变量。

GitHub Actions：`.github/workflows/e2e-live.yml`，只能在 Actions 页面手动触发（`notified` 填 `yes` 表示已在群里通知），选目标 `demo` 或 `local`。账号放在 environment `h1-live` 的 secrets 里（名字同上面四个环境变量）。**这个 environment 必须设「必需审批人」**：手动触发时可以选任意分支，工作流文件取自那个分支，没有审批就等于任何有写权限的人推一个改过的分支就能拿到账号。同一时间只跑一个。

## 3. 安全护栏（代码在 `e2e-live/`）

1. **目标只认测试服**（`target.ts`、`harness.ts` 的 `assertTestTarget`）：被测站点只能是 `http://localhost:5174` 或 `https://hvac-demo.haoqianglyu.com`，其他取值启动即报错；`local` 的开发代理上游固定为 `TEST_API_ORIGIN` 并核对域名是 `test.cosyhome.com.cn`；`demo` 每个用例打开页面后核对 Worker 生成的 `config.js` 是 `apiEnv: 'test'`、`dataSource: 'real'`、`apiBase: '/api'`。`local` 另外把 `writeMode` 设为 `off`，前端写防护也拒绝下发。
2. **请求闸门**（`policy.ts`、`harness.ts` 的 `installGate`）：在 `context.route` 层、请求发出之前判定，放行白名单之外的一律 `abort` 并记为违规，用例结束时失败：
   - **只读白名单**（方法 + 路由，相对 `/api`，逐字比对、不带查询串）：`GET /me`，`POST /ctrl/projects`、`/integrated-projects`、`/integrated-projects/stat`、`/distributors`、`/apps`、`/projects/frequent`，以及 ctrl 读路由 200/202/205/207/208/209/210（从 `src/api/ctrl.ts` 的 `CTRL` 去掉 `WRITE_CTRL` 得到，不手抄）。`POST /auth/login` 只在 setup 项目里放行。
   - **一律拦截**：写路由（`WRITE_CTRL` 对应的 201 `room-temperature-set`、203 `unified-ctrl-set`、204 `running-ctrl-set`、206 `project-room-switch-set`，以及 `guard.ts` 的 `WRITE_ROUTES` 里的 `unified-ctrls-send`；另按 `guard.ts` 的 `isWritePath` 拦所有 `ctrl/*-set`、`*-send`、`*-ctrl-message`，含大小写和 `/v1` 变体）、`/auth/refresh`（全程不续期）、`/auth/invalidate`（不作废别处令牌；本套不测退出）、白名单之外的任何 `/api` 请求、被测站点之外的任何请求、静态路径上的非 GET。
   - **拦截但不算违规**：`POST /project/click/{id}`（切换项目时的点击上报，有副作用；前端失败只记日志、不影响切换）；Cloudflare 自动注入的访问统计（`static.cloudflareinsights.com`、`/cdn-cgi/rum`）。
   - 启动自检：白名单和写路由交集为空、白名单没有一条被 `isWritePath` 认作写路径，否则直接报错。setup 里还有一条不联网的闸门自检：从页面对每条写路由、续期、作废令牌、额外登录各发一次，必须全部在发出前被拦；setup 串行，自检不过就不登录。
3. **单次登录**（`auth.setup.ts`）：setup 项目每个账号登录一次（勾「记住我」，令牌在 localStorage），存成 `e2e-live/.auth/<账号>.json` 的 storageState，`platform`、`dealer` 两个项目依赖它并复用。用例里出现登录请求即违规；`retries: 0`（重试 setup 就是第二次登录）。运行结束 `teardown.ts` 删掉 `.auth/`（里面有令牌），不调 `/auth/invalidate`。
4. **不续期**：访问令牌有效期 2 小时（`expires_in=7200`）；前端在到期前 1 分钟（`REFRESH_LEEWAY_MS`）才主动续期，且续期请求会被闸门拦下判失败。每个用例开始前检查令牌至少还剩 11 分钟，不够就中止（不重新登录）。整次运行 `globalTimeout` 30 分钟，远低于 2 小时。
5. **不泄漏账号和令牌**：账号密码用 `evaluate` 填入（`locator.fill` 会把值写进步骤标题，HTML 报告和 trace 里能看到明文，已实测）；不截图、不录视频、不录 trace（trace 里有请求头）；不出 HTML 报告，只出 JSON 报告；从填入账号到离开登录页这一段不用 `expect` 匹配器（匹配器失败时会立刻抓整页快照、含输入框的值，写进 `error-context.md`，已实测），失败时先清空输入框再抛一条不带页面内容的错误；运行结束删掉 `test-results-live/`。每个用例附一个去敏的 `network.txt`（只有判定、方法、路径）。

## 4. 覆盖的流程（对应 `docs/e2e-plan-hengjing.md` 第 4 节）

两个账号各跑一遍（经销商没有某个接口的权限时，按界面应有的回退或「未开通」状态核对）。断言是「界面结论与只读接口原始回包一致」，不做截图比对。

| 用例 | 流程 | 断言 |
| --- | --- | --- |
| setup | F1、F3 | 未登录打开 `/sensors` → 登录页 → 登录后回到 `/sensors`；刷新保持登录；`/me` 身份与账号对得上 |
| `org.spec.ts` | F6、F7 | 侧栏菜单的条目数、每个项目的在线 / 离线显示与 `/ctrl/projects`、`/integrated-projects` 一致；切换后侧栏更新；搜索按编号找到可见项目并切换，可见范围外的项目搜不到 |
| `home.spec.ts` | F1、F5（统计卡） | 四张统计卡与 `/integrated-projects/stat` 一致（无权限时与前端按可见范围的计算一致）；常用项目与 `/projects/frequent` 一致（未开通、空、失败各有对应状态） |
| `devices.spec.ts` | F8、F10（只看） | 传感器卡片与 207 一致、统计三档切换不报错；温控房间与 200 一致，点开关（或开关未上报时的「开」）进确认框、核对文案后取消，网络记录里没有任何写请求；连接状态计数与 205 一致；各页不出现 65536；离线项目三页都是离线空态、不发 ctrl 请求 |

不覆盖：新风、天气、统一控制、退出登录、续期（F4）。测试服上没有在线项目或离线项目时，相应用例标为跳过（环境不可用，不算失败）。

## 5. 结果怎么看

- 终端里是 list 报告；`playwright-report-live/results.json` 是 JSON 报告（含 `network.txt` 附件和每个账号令牌剩余时间的注释）。
- 失败时先看是不是环境问题（测试服登录不了、测试项目离线），再看是不是界面与回包不一致。
- 运行记录（命令、时间、结果）附到对应的高风险 PR 里（REVIEW.md 第 3 节第 5 条）。
