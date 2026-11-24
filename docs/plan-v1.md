# 恒境云 正式版开发方案 v1

日期：2026-11-24 · 范围：把模拟数据演示版（Vite + React 19 + TS + ECharts）接到真实后端，UI 只按《界面改动-1123》小改。
本文只是方案，不含代码改动。标「待确认」的条目汇总在第 8 节，按优先级排了序。

依据：`docs/api/接口文档.md`（下称「接口文档」）、`docs/api/ctrl同步消息200-210.md`（下称「ctrl 文档」）、`docs-界面改动-1123.docx`（下称「改动文档」）、参考实现 `~/code/cosydata_fable`。

## 1. 现状盘点

### 1.1 代码结构（共约 2800 行）

| 位置 | 内容 | 正式版去向 |
| --- | --- | --- |
| `src/pages/*.tsx`（9 个） | Login、Home、Groups、Control、Sensors、Thermostat、FreshAir、Connections、Settings | 保留，换数据源，按改动文档小改 |
| `src/components/Layout.tsx` | 侧边栏、项目切换器、顶栏搜索、面包屑、离线横幅 | 保留，数据源换成真实接口 |
| `src/components/ui.tsx` | Card、Seg、Toggle、Pager、Chart、LogoMark、Avatar、useAsync/useClock/useInterval | 交互类换成 shadcn（见第 4 节），Chart/Logo 保留 |
| `src/app/store.tsx` | 登录态、当前项目、toast、confirm 弹窗 | 拆成 auth / project / 反馈三块 |
| `src/api/index.ts` | 全部为 mock 的异步函数（只有 `/api/login` 是真请求，打到 Worker） | 重写为真实请求层（见第 3 节） |
| `src/mock/*` | data / gen / org 三个文件 | 只留给测试与截图基线用，不进生产包 |
| `src/styles/global.css`、`pages.css` | 232 + 413 行手写 CSS，27 个 `:root` 变量 | global.css 的组件样式逐步迁到 shadcn；pages.css（页面布局）v1 不动 |
| `worker/index.js` + `wrangler.toml` | Cloudflare Worker：静态资源 + `/api/login` 校验两个演示账号 | 改为 `/api/*` 反向代理，去掉演示账号 |
| `scripts/shoot.mjs`、`compose.py` | 手动点击 + 截图 + 与设计稿拼图 | 改造成 Playwright 测试进 CI |

现状缺口：没有 git remote、没有 CI、没有单元测试；oxlint 只开了两条规则。

### 1.2 页面/字段 → 接口对应表

约定：`ctrl NNN` 指 ctrl 文档的同步消息；项目的 `id` 用于 ctrl 请求的 `project_id`。「待确认」后的编号对应第 8 节。

**登录页 / 外壳（Layout）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 账号、密码 | `POST /v1/auth/login` · `mobile`、`password`、`isdp` | 账号填进 `mobile`（平台账号不是手机号，输入框文案用「账号 / 手机号」）；`isdp` 目标传 `true`（已确认）；经销商账号传 `true` 被拒，后端在查，联调先传 `false` |
| 记住我 | 无接口 | 决定 token 存 localStorage 还是 sessionStorage |
| 忘记密码、其他登录方式 | 文档无 | v1 隐藏；待确认 Q12 |
| 顶栏 姓名 / 角色 | `GET /v1/me` · `user_entity.name`、`user_entity.type` | 接口文档未收录，已实测（见第 2 节）；「机构」一栏无来源，去掉 |
| 侧边栏项目切换器（按集成项目分组） | `GetIntegratedProjects` · `entities[].name/project_ids` + `GetProjects` · `project_ids` → `name/online` | |
| 顶栏项目搜索 | `GetProjects` · `name`（模糊），结果取 `name/code/online/distributor_name` | 权限范围由后端按账号限定 |
| 切换当前项目 | `POST /v1/project/click/{id}` | 每次切换上报 |
| 离线横幅 | `GetProjects` · `online` | 演示版显示「最后在线数据」；真实后端离线时取不到数据，改为空态。最后在线时间文档无，待确认 Q9 |
| 铃铛、角标 | 文档无（报警已在 v2 移除） | v1 隐藏 |
| 退出登录 | `POST /v1/auth/invalidate` · `user_id` = `user_entity.id` | |

**欢迎首页（Home）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 当前温度、天气文字 | `GetWeather` · `now.temperature`、`now.weather` | |
| 最高 / 最低 | `f1.day_air_temperature` / `f1.night_air_temperature` | |
| 体感温度 | 文档无 | 去掉 |
| 相对湿度 | `now.sd` | 改动文档要求的 6 项之一 |
| 风向、风力 | `now.wind_direction`、`now.wind_power` | 拆成两格（现在合在一格） |
| 露点 | 文档无，前端用 `now.temperature` + `now.sd` 计算 | 复用 `cosydata_fable/src/utils/dewPoint.js` 的算法 |
| 气压、紫外线 | `f1.air_press`、`f1.ziwaixian` | 只有预报里有，实时里没有 |
| 能见度 | 文档无 | 改动文档 6 项里没有它，去掉 |
| 空气质量、PM2.5 | `now.aqiDetail.aqi/quality/pm2_5` | |
| 日出 / 日落 | `f1.sun_begin_end` | 需拆字符串 |
| 降水概率 | `f1.jiangshui` | 「夜间有小阵雨可能」这类说明文字无来源，去掉 |
| 未来 7 天 | `f1`–`f7` 分别是第 1–7 天（后端已改 7 天版，天气段待后端改完再做） | 7 天版没有的字段（湿度、体感等）一律隐藏 |
| 24 小时预报（温度线） | `GetWeather24` · `hourList[].time/temperature/weather_code` | |
| 24 小时预报（湿度线） | `HourWeather` 无湿度 | 隐藏湿度线，只画温度（负责人答复：无接口支撑的一律隐藏） |
| 城市选择 | `GetWeather(24)` · `city` 传行政区划码；选择结果存 localStorage | 不自建城市表：`/wx/city-list` 返回的城市名与本地全国省市级联数据（参照 `cosydata_fable/src/utils/cascader_disdrict.js`）取交集，做省 → 市两级选择，选中后传行政区划码。测试服 `city-list` 只有无锡、苏州，正式服全量；经销商账号需开 `/wx/city-list` 权限 |
| 4 张统计卡 | `GetIntegratedProjectStat` · `total / project_total / project_online / project_offline` | 字段一一对应 |
| 常用项目（4 张卡） | `GetFrequentProjects(limit=4)` · `name/code/online/customer_region/app_category_name` | 去掉「演示计数」开关 |
| 常用项目卡里的 温度/湿度/CO₂ | 可能是 `brief_stat`（`ProjectBriefStat` 文档未展开） | 待确认 Q9；拿不到就去掉这一行 |
| 问候语里的姓名、日期 | 姓名取 `/me`；日期用浏览器时间 | 农历去掉或引入小库，倾向去掉 |

**集成项目（Groups）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 经销商选择（仅平台用户） | `GetDistributors` · `has_integrated_project=true` → `id/name/code/abbreviation/region` | 搜索用 `name` 参数或前端过滤 |
| 集成项目卡：名称、编码 | `GetIntegratedProjects` · `name`、`code` | |
| 集成项目卡：类型标签 | `app_id`，没有名称 | 待确认 Q9：应用名称从哪取 |
| 集成项目卡：项目数、在线数 | `project_ids.length`；在线数由 `GetProjects(project_ids)` 的 `online` 统计 | |
| 详情：描述、创建时间、在线率 | `desc`、`created_at`、前端计算 | |
| 项目表：名称、项目 ID | `GetProjects` · `name`、`code` | 显示 `code` 还是 `number` 待确认 Q9 |
| 项目表：区域、在线、版本、程序 | `customer_region`、`online`、`app_version`、`app_name` + `app_code` | |
| 表格筛选（名称、区域、在线/离线）与分页 | 项目列表与在线筛选用 `POST /v1/ctrl/projects`（`{only_online:true}` 只返回在线；条目带 `online:true`，缺失即离线；字段比 `/projects` 多 `mode`、`app_version` 等）；一次取全部，前端筛选分页 | `limit` 实测无实际上限，不传 `page_options` 返回全部 |
| 新建集成项目、新建项目、编辑 | — | 按改动文档移除 |

**统一控制（Control）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 经销商、集成项目、项目勾选列表 | 同集成项目页 | 离线项目不可勾选 |
| 系统开关 | `UnifiedCtrlSetQuery.system_switch`（1 / 0 / -1） | |
| 运行模式 | `system_mode`（枚举 14 个值） | 演示版只有 制冷/制热/除湿/通风/自动/不变 6 项，与枚举对不上，开放哪些待确认 Q6 ③ |
| 房间开关 | `room_switch`（1 / 0 / -1） | |
| 房间温度设定 | `room_temp`（-1 不变） | 按所选集成项目组的 `app_code` 决定是否禁用：`app_code` 为 12 的项目温度设定不可用（后端已确认；app_code 8 暂不用本平台，主要支持 1 与 12） |
| 下发 | `POST /v1/ctrl/unified-ctrls-send` · `project_ids` + `body`（protobuf → base64）→ `batch_id/total` | 一次请求只有一个 body；只能选同一集成项目组内的项目，同组 `app_code` 相同，不存在混选 |
| 预览里的「影响设备 N 台」 | 文档无 | 去掉 |
| 最近一次执行结果 | `GetUnifiedCtrlsRecords` · `batch_id` → `project_name / project_code / result / operate_time` | 只留 项目、项目 id、状态、操作时间四列（改动文档） |
| 结果标题行（批次、操作人） | `batch_id`、`operator_name` | 指令摘要记录里没有，去掉 |

**室内空气传感器（Sensors）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 传感器卡：名称、温度、湿度、露点、PM2.5、CO₂、在线 | ctrl 207 · `name / temperature / humidity / dew_point / pm2_5 / co2 / is_connected` | |
| 「该型号无 PM2.5 / CO₂ 探头」 | 无探头 / 未初始化字段返回 65536（设备字段 2 字节最大 65535） | 前端遇 65536 视为无数据并隐藏该项；缺字段解码出的 0 同样视为无数据（proto3 不输出 0，待后端确认 Q7 ⑥） |
| 离线传感器的「最后在线」 | 文档无 | 去掉 |
| 顶部平均值 KPI | 前端对 207 在线设备求平均 | |
| 数据统计图（24 小时） | ctrl 208 · `device_id/start_time/end_time` → `date/hour/各指标` | 65536、-100、缺字段解码出的 0 都是无效值，画成断点；同一小时多条按字段合并（无效值不覆盖有效值，多个有效值取平均，权威顺序待后端 Q7 ⑥） |
| 数据统计图（7 日 / 30 日） | 同 208，前端按天聚合 avg/max/min | 时间为毫秒（已实测）；208 每 5 分钟刷新，207 每 15 秒 |
| 指标统计汇总 | 前端从 208 结果计算 平均/最大/最小/达标率 | 去掉「超标时长/超标天数」列（改动文档，Q13 已确认）；达标率保留，口径经 Fable 复核（11/24）：落在标准范围内的有效小时数 ÷ 有效小时数，三档都按小时值算，无效值不进分子分母；有效小时为 0 显示「—」，不到应有小时数一半时加注「有效 N/M 小时」；没装该探头的指标整行隐藏 |
| 标准范围、超标着色 | 前端常量（`src/data/sensors/stats.ts` limitsOf） | 五恒指南（经 Fable 复核 11/24）：温度冬季 18–22℃ / 夏季 24–26℃（按北京时间月份，5–10 月为夏季）、湿度 40–60%、CO₂ ≤ 800、PM2.5 ≤ 35；露点指南未给，沿用 ≤ 17.0。卡片标签、阈值虚线、汇总「标准范围」列与达标率同源 |

**房间温控面板（Thermostat）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 房间卡：名称、室温、湿度、露点 | ctrl 200 · `name / temperature / humidity / dew_point` | 楼层文档无，去掉 |
| 开关、节能标签 | `switch`、`eco` | |
| 设定温度 | `set_temp` | 新增调节控件（改动文档） |
| 设定湿度 | `set_humi` | 按改动文档移除 |
| 风速 | `wind_speed`（100 为自动） | 档位数字与 低/中/高 的对应待确认 Q7 |
| 末端标签（顶辐射/地冷/风盘…） | `end_modes[]` · `option_name`、`is_selected`（蓝/灰）、`switch`（开/关） | 数量动态；演示版写死三个 |
| 面板在线 | `is_connected` | KPI「全部在线」改为实际统计 |
| 单房间开关、调温 | ctrl 201 · `equipment_id / temperature / switch / end_modes…` | 所有不修改的字段一律传 -1（后端答复） |
| 全部开启 / 全部关闭 | ctrl 206 · `switch` | |
| 统计图 | ctrl 209 · 参数与返回同 208 | |
| 「该项目无房间温控面板」 | `GetProjects` · `app_code == 12` | |

**新风除湿机（FreshAir）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 设备页签：名称、开关、在线 | ctrl 202 · `name / switch / is_connected` | |
| 滤网寿命环与进度 | `filter_life_p`（百分比）、`filter_life`、`filter_running` | 后两者单位待确认 Q7 |
| 运行模式 | `running_mode`（字符串） | 演示版的「模式 13」数字编码不再用 |
| 实时数据格子 | `supply_temp / return_temp / wind_level / wind_speed / dehumidifier_status / dehumidifier_freq / running_time` | 只显示接口有的字段；新风温湿度、送风湿度/露点、新风量去掉 |
| 设备汇总表 | 设备 `name`、开关 `switch`、模式 `running_mode`、运行时间 `running_time`、滤网运行时间 `filter_running`、滤网寿命 `filter_life_p`% | 列按改动文档 |
| 运行设置面板（仅 `app_code == 12`） | 读 ctrl 210 · `control_type / dew_point / humidity_set / wind_speed / switch / can_change`；写 ctrl 204 | 风速为 低/高/自动（演示版是 低/中/高）；`control_type=-1` 时两项都禁用；设定范围待确认 Q7 |

**设备连接状态（Connections）/ 系统设置（Settings）**

| 界面元素 | 接口 · 字段 | 备注 |
| --- | --- | --- |
| 明细表：设备名称、类型、地址、连接状态 | ctrl 205 · `device_name / model / address / conn_status`（0 离线 1 在线 2 异常） | 「类型」列改为型号 |
| 4 张 KPI | 前端按 `conn_status` 统计 | 「最长离线时长」「丢包率」无来源，去掉 |
| 网关编号 | `GetProjects` · `control_screen_id` 或 `dtu_id` | 网关 IP/延迟/运行时长无来源，去掉 |
| 「每 30 秒检测一次」 | 每 30 秒重新调 205 | |
| 系统设置页的 4 个通知开关 | 文档无 | 待确认 Q12：隐藏该页，或只留本地偏好 |

## 2. 认证与会话

**环境与账号**：开发、联调、测试一律连测试环境 `https://test.cosyhome.com.cn:9443/v1`（已实测可用）。负责人已提供两个测试环境账号：平台管理员和一个经销商账号，密码存在本机钥匙串（`hengjing-admin`、`hengjing-dealer`），不进仓库、不进 CI。这两个账号在生产上不可用。

**登录**：`POST /v1/auth/login`，body `{ mobile, password, isdp }`，返回 `access_token / refresh_token / expires_in`。实测 `access_token` 是 JWT，`expires_in=7200`（2 小时），claims 只有 `exp / iat / iss / sub`，不含角色。之后所有请求带 `Authorization: Bearer <access_token>`（与 cosydata_fable 的 `request.js` 一致）。演示账号及 Worker 里的密码校验一并删除。

**当前用户与角色**（后端确认 + 测试环境实测，接口文档未收录）：登录成功后调 `GET /v1/me`，返回 `user_entity` 与 `permission_paths`。
- `user_entity.type`：`1` 为经销商；`0` 为平台用户，且 `0` 可能不传，字段缺失按平台用户处理。实测平台账号无 `type`，经销商账号 `type=1`。
- `user_entity` 还有 `id / name / mobile / parent_id / role_id / ac_brand_ids / air_brand_ids`。`id` 用作 ctrl 同步消息和退出接口的 `user_id`，`name` 用于顶栏和问候语。
- **只有平台用户显示经销商选择器**（集成项目页、统一控制页），其余账号一律不显示，直接看到自己范围内的集成项目。
- `/me` 的结果只放内存，每次刷新页面重新取，不存浏览器存储，所以角色无法靠改本地存储伪造。`/me` 失败视为未登录。

**permission_paths**：实测平台账号 578 条、经销商 347 条。v1 的做法：拿到后存入会话，提供 `can(path)` 判断函数，但先不拿它控制页面和按钮，原因是恒境云的页面和 5 个写接口对应哪些 path 还不知道（Q4）。后端给出对应关系后，在 S5 里接上：没有权限的写按钮禁用并提示、没有权限的菜单隐藏。数据范围始终由后端保证，前端的判断只影响显示。

**isdp**：文档只说「为 true 时无集成功能的账号会被拒绝」。恒境云正是集成项目平台，传 `true`，让没有集成功能的账号在登录时就被挡住（负责人答复已确认，原有接口不受影响）。测试经销商账号传 `true` 曾被拒（500「经销商未配置集成功能」），后端已于 11/24 修好，现在两个测试账号都传 `true`，前端不再保留退回 `false` 的配置。

**存储**：勾了「记住我」存 localStorage，否则存 sessionStorage；只存 `access_token`、`refresh_token`、过期时间戳。旧的 `hjc-auth`（存用户名和角色，可伪造）废弃。

**刷新**：
- 过期前 60 秒主动调 `POST /v1/auth/refresh`；另外任何请求返回 401 时刷新一次并重放原请求一次，再 401 就退出。
- 刷新会返回新的 `refresh_token` 并作废旧值，所以同一时刻只能有一个刷新在跑：页内用单例 Promise，多标签页之间用 Web Locks，其他标签页通过 `storage` 事件拿到新 token。
- `refresh_token` 的有效期和「是否单设备登录」文档没写（Q4）。

**过期与退出**：刷新失败 → 清本地登录态 → 跳登录页并提示「登录已过期」（多请求并发只提示一次，参考 `authError.js` 的 3 秒去重）。主动退出调 `POST /v1/auth/invalidate`，不论成功失败都清本地状态。

## 3. API 层设计

### 3.1 基址可配

- 前端所有请求走相对前缀，默认 `/api`，与 cosydata_fable 相同（`/api/projects` → 后端 `/v1/projects`）。
- 运行时配置：`public/config.js` 写 `window.__HJC_CONFIG__ = { apiBase: '/api' }`，在 `index.html` 里先于应用加载。对方部署时改这一个文件即可，不用重新构建。构建时可用 `VITE_API_BASE` 设默认值。
- 本地开发：Vite 代理 `/api` → `VITE_PROXY_TARGET`，默认测试环境 `https://test.cosyhome.com.cn:9443/v1`。
- hvac-demo：浏览器直连后端不可行，已实测两个后端对 `hvac-demo.haoqianglyu.com` 的 CORS 预检都返回 403，所以由 Worker 把 `/api/*` 转发到 `API_UPSTREAM` 变量指向的后端。Worker 只转发到这一个固定上游，不接受任意目标。

### 3.2 请求封装

目录：

```
src/api/
  config.ts      读取运行时配置
  http.ts, errors.ts  fetch 封装：POST JSON、Bearer、超时、401 刷新重放、错误归一与中文提示
  auth.ts        login / refresh / invalidate / me + token 存取与 can()
  pcfg.ts        projects / frequent / click / integrated-projects(+stat) / distributors
  weather.ts     weather / weather24
  ctrl.ts        callCtrl() + 200–210 的 11 个函数 + unified-ctrls-send / records
  guard.ts       写操作防护（见 3.6）
  proto/, types.ts  由 .proto 生成的编解码；REST 实体类型
```

- 用原生 `fetch` + `AbortController`，不引 axios。默认超时 10 秒，ctrl 同步消息 12 秒。
- 响应保持后端的 snake_case，在各接口函数里手工映射成页面用的 camelCase 视图模型。不做全量自动转换，因为 `GetWeather24` 里 `hourList / areaCode` 与 snake_case 混用，自动转换容易出错。
- 页面取数用 TanStack Query：统一 loading/错误/重试/轮询/缓存失效，替换现在的 `useAsync`。

### 3.3 错误处理

| 情况 | HTTP（按 gRPC 网关惯例，待联调核实） | 前端处理 |
| --- | --- | --- |
| 未登录 / 令牌过期 | 401 | 刷新后重放一次，仍失败则退出 |
| 无权限 | 403 | 提示「无权限」，不退出（cosydata_fable 把 403 当过期处理，联调时核实后端实际含义） |
| 控制屏不在线（Unavailable） | 503 | 页面显示「控制屏未连接」空态，不弹重复 toast |
| 控制屏响应超时（DeadlineExceeded） | 504 | 读：显示可重试的错误态；写：提示「未收到应答，结果未知」，不自动重发 |
| 内部错误 | 500 | 通用错误提示，带后端 `message` |
| 网络断开 / 超时 | — | 读请求自动重试 1 次，写请求不重试 |
| ctrl 写操作 Reply `success=false` | 200 | 提示 Reply 里的 `msg`，界面回滚到下发前的值 |

错误体格式（`{ code, message }`？）文档没写，联调第一天抓一次真实响应定下来。

### 3.4 ctrl 同步消息

- 统一入口 `callCtrl(route, projectId, QueryType, ReplyType, query)`：把 Query 用 protobuf 编码成 base64 放进 `body`，带上 `project_id` 和 `user_id`，再把响应的 `body` 解码成 Reply。空 Query 传空字符串。
- **编解码**：需要这 11 组消息的 `.proto`。cosydata_fable 的 `ctrlcb_pb.js` 里没有 200–210 的消息（已检索），而 ctrl 文档的表格没给字段编号，无法手写。必须由后端提供 `ctrlcb.proto` 的相关部分（Q1）。拿到后用 `@bufbuild/protobuf` 生成 TS 类型；int64 字段（设备 ID、时间）统一转成 number 再交给页面，避免 cosydata_fable 里踩过的 Long 对象问题。
- **超时**：服务端等控制屏 10 秒，前端设 12 秒。
- **轮询**（同步消息本身不用轮询结果，这里指页面数据的定时刷新）：传感器实时数据（207）、温控面板、新风除湿机每 15 秒，传感器小时统计（208）每 5 分钟（小时数据一小时才变，赤兔 11/24 确认），连接状态每 30 秒。传感器实时数据（207）返回 503（控制屏未连接）后降到 60 秒继续探测，恢复成功后回到 15 秒；503 之后的旧读数作废（按请求序号，之后遇到其他错误也不恢复旧值）。上一次返回后才排下一次，不重叠；标签页不可见或项目离线时暂停。每次轮询都会真实打到控制屏，频率是否可接受要问后端（Q7）。
- 写操作成功后立即重新拉一次对应的读接口，以设备回读值为准。
- 207–209 目前复用 `TP*` 消息，ctrl 文档自己注明可能调整，联调时逐个验证。

### 3.5 批量统一控制

`unified-ctrls-send` 立即返回 `batch_id`，然后每 2.5 秒查一次 `unified-ctrls-records(batch_id)`，直到没有「等待中」，最长 35 秒（服务端 30 秒判超时）。改动文档要求不显示执行中状态：轮询期间结果卡片显示加载骨架，结束后一次性显示成功/失败/超时。35 秒后仍「等待中」的记录（ctrlcb 重启会造成）显示为「未知」并附刷新按钮。进入页面时取最新一条记录的 `batch_id`，再按批次查出整批结果。

### 3.6 写操作防护

写接口共 5 个：ctrl 201、203、204、206 和 `unified-ctrls-send`。全部经过 `guard.ts`：

- 运行时配置加 `writeMode`：`off`（全部拦截）/ `allowlist`（只放行 `writeProjectIds` 里的项目）/ `on`。
- 本地开发和 hvac-demo 都连测试环境，`writeMode=allowlist`，名单为两个测试项目 260911001 和 240829001（后端已确认可做下发测试，Q2）；下发前在群里说一声，下发前后各读一次核对，日志和截图写进 PR。
- 指向生产须负责人确认；指向生产后默认 `allowlist`，改成 `on` 也须负责人确认。交付给对方的包默认 `writeMode: 'off'` 且 `writeProjectCodes` 为空（生产环境禁止一切下发），负责人另行确认后才开放（负责人 11/24 指示，见 `docs/部署说明.md`）。
- CI 里的测试一律用拦截的假响应，不连任何真实后端。
- 每个写操作沿用现有的二次确认弹窗，弹窗里写明项目名和将下发的值。

### 3.7 类型定义

REST 实体按接口文档手写 TS 接口，只声明用到的字段。ctrl 消息类型由 proto 生成。`result`、`conn_status`、`system_mode` 等枚举集中在 `types.ts`，中文标签映射放同一处。测试夹具（fixture）用同一套类型约束，接口变了编译就报错。

## 4. shadcn/ui 迁移策略

**原则**：shadcn/ui（Radix）只提供行为和可访问性（焦点管理、键盘操作、弹层定位），外观全部用恒境云自己的 token 重写，迁移前后截图一致。

**Tailwind 4 接入**：用 `@tailwindcss/vite`。只引入 theme 和 utilities 两层，不引入 preflight，因为 global.css 已有自己的 reset，preflight 会改动标题、按钮、表格的默认样式。现有手写 CSS 不放进 layer，优先级天然高于 Tailwind 的 layer，旧样式不会被意外覆盖。

**Token 映射**（在 `@theme` 里声明，值直接引用现有变量；现有 27 个变量名全部保留）：

| shadcn 语义 token | 恒境云变量 | 值 |
| --- | --- | --- |
| `--background` / `--foreground` | `--bg` / `--text` | #f1f5f9 / #0f172a |
| `--card`、`--popover` | `--card` | #ffffff |
| `--primary` / `--primary-foreground` | `--primary` / 白 | #0891b2 |
| `--secondary`、`--accent` | `--primary-soft` | #ecfeff |
| `--muted` / `--muted-foreground` | `--bg` / `--muted` | #f1f5f9 / #64748b |
| `--border`、`--input` | `--line` | #e7ecf2 |
| `--ring` | `--primary-2` | #06b6d4 |
| `--destructive` | `--red` | #f43f5e |
| `--radius` | 控件 8px；卡片仍用 `--radius` 14px | |
| `--sidebar-*` | `--navy`、`--navy-2`、`--navy-active` | #0b1a2e 等 |
| 字体 | `--font`（Barlow + Noto Sans SC） | 数字类 `.num` 保留 |
| 状态色（不在 shadcn 语义内） | `--green`、`--amber`、`--orange`、`--indigo`、`--sky` | 作为自定义颜色加入 theme |

**组件替换清单**：

| 现有 | 换成 | 用在 |
| --- | --- | --- |
| `.btn` 系列 | Button（primary / ghost-primary / lg / block 变体） | 全站 |
| `Toggle` | Switch | 温控面板、新风设置、系统设置 |
| `Seg` | ToggleGroup | 时间范围、指标切换、在线筛选 |
| 原生 `<select>` | Select | 区域、房间、集成项目 |
| 经销商搜索框 + select | Popover + Command（可搜索下拉） | 集成项目、统一控制 |
| 项目切换器、顶栏搜索弹层 | Popover + Command | Layout |
| `.checkbox` | Checkbox | 登录、统一控制 |
| `.input` / `.field` | Input | 登录、各搜索框 |
| 手写 confirm 弹窗 | AlertDialog | 全部写操作 |
| 手写 toast | Sonner | 全站 |
| 原生 range | Slider | 统一控制温度；温控面板新调温控件 |
| `Pager` | Pagination | 项目表、连接明细 |
| `.table` | Table | 4 处表格 |
| 无 | Skeleton、Tooltip | 加载态、截断文字 |

不换的：Card、pill 标签、KPI 卡、图表（ECharts）、登录页左侧插画、Logo、页面布局（pages.css）。Font Awesome 图标保留，不换成 lucide。

**截图对比验收**：
- 迁移开始前（第 0 段）先在 mock 模式下录基线：8 个页面 × 2 种角色 + 关键状态（离线、新风单机版、无探头、弹窗打开、下拉展开），1440 宽全页。
- 截图在 CI 的固定 Playwright 容器里生成和比对，避免本机与 CI 字体渲染差异。时钟固定、动画关闭、图表等渲染完成后再截。
- 阈值：接入 Tailwind 那段要求零差异；组件迁移段每页差异像素 ≤ 0.5%，且差异图要人工看过。预期差异只允许焦点环和原生控件换成自绘控件后的细节，逐条列在 PR 描述里。
- 行为验收：键盘可操作（Tab、方向键、Esc）、弹层焦点回收，用 Playwright 断言。

## 5. 改动文档逐条落点

| # | 改动文档条目 | 落在哪段 | 说明 |
| --- | --- | --- | --- |
| 1 | 首页显示 相对湿度、露点、风向、风力、气压、紫外线 | S7 | 6 格重排：去能见度，风向与风力拆开，露点前端计算 |
| 2 | 首页城市选择，缓存上次选择，`city` 传行政区划码 | S7 | 不建 `cities.json`：`/wx/city-list` 城市名与本地省市级联数据取交集，省 → 市两级选择 |
| 3 | 集成项目移除「新建集成项目」「新建项目」 | S6b | |
| 4 | 集成项目移除「编辑」 | S6b | |
| 5 | 统一控制：`app_code` 为 12 时房间温度设定不可用 | S12 | 现在按 12 判断并同时隐藏房间开关，改为按所选组的 `app_code`（12）只禁用温度；组内 `app_code` 相同，无混选 |
| 6 | 统一控制：最近一次执行结果只显示 项目、项目 id、状态、操作时间 | S12 | 去掉执行中计数、进度条、设备数、说明、操作列 |
| 7 | 传感器：指标统计汇总移除超标时长，数据从 208 自行过滤得出 | S8 | Q13 |
| 8 | 温控面板：实现房间温度调节，调整 UI | S9 | 房间卡设定温度处加 −/+ 步进，确认后下发 201；UI 小样在该段 PR 里先给负责人看 |
| 9 | 温控面板：`end_modes` 动态显示，`is_selected` 蓝/灰，`switch` 开/关 | S9 | |
| 10 | 温控面板：移除设定湿度 | S9 | 三格变两格 |
| 11 | 新风除湿机：实时数据按 202 字段显示 | S10 | |
| 12 | 新风除湿机：设备汇总列为 设备、开关、模式、运行时间、滤网运行时间、滤网寿命（%） | S10 | |
| 13 | 新风除湿机：仅 `app_code == 12` 有运行设置 | S10 | 现有 `isStandalone` 判断沿用，数据源换成 `app_code` |

## 6. 分段计划

共 15 段（S6 拆为 S6a、S6b），约 12.5 个工作日。第三版分工：Claw 做 S2、S3（S3c 除外）、S6a、S6b、S7–S11；Chitu 做 S5（含 S3c）、S12、S13 及所有 PR 的最后把关，S0、S1、S4 已合并。关键日期：11/24 S5、S2b；11/25 S6a；11/26 S3b、S3a；11/27 S6b；11/28–29 第一批（S8、S9、S11）；11/30–12/1 第二批（S10、S7）；12/2–3 S13，预计 12/3 交付。每段一个 PR：两路评审（Opus + Codex，由 PR 作者跑）通过、CI 全绿后，由 Chitu 最后把关并合并；Fable 只用于方案和拆分。两人分工、各段预计日期与文件归属约定见 `docs/分工.md`（表中「负责人」列以该文件为准）。S1–S3（UI 底座）与 S4–S5（接口底座）互不依赖，可交叉进行。

CI（GitHub Actions，每个 PR 触发）：`oxlint` → `tsc -b` → `vitest` → `vite build` → Playwright（mock 模式下的截图对比 + 交互用例）。失败时上传差异图为 artifact。

| 段 | 负责人 | 内容 | 工期 | 依赖 | 验收 | 测试 |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | Chitu | 建私有仓库 `clawchitu/hengjing-cloud` 并推送现有历史（推送前检查历史里无密钥；`.dev.vars` 已确认未入库）；main 分支保护；PR 模板；CI 五步；引入 vitest；把 `shoot.mjs` 改写成 Playwright 测试并录截图基线；重写 README | 1 天 | 无 | 空改动 PR 上 CI 全绿；基线截图入库；直接推 main 被拒 | 截图基线全量；1 个 vitest 冒烟用例 |
| S1 | Chitu | 接入 Tailwind 4 与 shadcn 基础配置；`@theme` token 映射；不改任何组件 | 0.5 天 | S0 | 截图零差异；构建体积增量记录在 PR | 截图对比 |
| S2 | Claw | 组件迁移 A：Button、Switch、ToggleGroup、Select、Checkbox、Input、Pagination、Table | 1 天 | S1 | 每页差异 ≤ 0.5% 且逐条说明；global.css 对应旧样式删除 | 截图对比；键盘操作用例 |
| S3 | Claw | 组件迁移 B，子段顺序 S3-0（补基线）→ S3b（Popover + Command：项目切换、顶栏搜索；经销商选择合并为可搜索下拉按负责人 11/24 确认延后到改界面阶段，见 `docs/plan-s1-s3.md` 负责人确认 1）→ S3a（AlertDialog + Slider）；S3c（RHF + zod + Login）并入 S5，归 Chitu；S3d（Dialog / Sheet / DropdownMenu / DatePicker + `/__ui`）后移；涉及 AlertDialog、Sonner、Popover + Command（项目切换、搜索）、Slider、Tooltip、Skeleton | 1 天 | S2 | 同上；弹层 Esc 关闭、焦点回收 | 截图对比（含弹层打开态）；交互用例 |
| S4 | Chitu | API 基座：运行时配置、`http.ts`、错误归一、token 存取与刷新、proto 生成与 `callCtrl`、写操作防护、TanStack Query；mock 模式保留为可切换的数据源 | 1 天 | S0；Q1 的 proto | 对测试环境手动跑通 login → me → projects → 一条 ctrl 读；写防护在 `off` 下拦截全部 5 个写接口 | vitest：刷新单例、401 重放、错误映射、base64 编解码往返、防护逻辑 |
| S5 | Chitu | 登录与会话（含 S3c 表单）：登录页接真接口、`/me` 取用户与角色、路由守卫、过期跳转、退出、`can()`；Worker 改为 `/api/*` 代理并删除演示账号 | 1 天 | S4；Q3 | 两个测试账号可登录，平台账号有经销商选择、经销商账号没有；令牌过期自动续期；多标签页不互相踢出；退出后旧令牌失效 | vitest：会话状态机；Playwright：登录、过期、退出（假响应） |
| S6a | Claw | 组织数据的数据层：hooks、store 拆分、当前项目、在线状态、`app_code`、项目列表；不改界面 | 0.5 天 | S5 | 经销商账号只见自己的数据；空数据、加载、失败三态在数据层齐全 | vitest：hooks 与数据映射；截图零差异，不动基线 |
| S6b | Claw | 组织数据的界面：侧边栏项目切换、顶栏搜索、经销商选择（合并为可搜索下拉 Popover + Command，负责人 11/24 确认，见 `docs/plan-s1-s3.md` 负责人确认 1）、点击上报；首页统计卡与常用项目；改动 3、4 | 0.5 天 | S6a、S3b | 平台账号可切换经销商、经销商账号没有选择器；空数据、加载、失败三态齐全 | 夹具驱动的页面用例；截图基线更新（去掉按钮） |
| S7 | Claw | 首页天气：实时、7 天（f1–f7）、24 小时；城市选择（city-list 与本地省市数据取交集）与缓存；改动 1、2 | 1 天 | S6b | 换城市后刷新页面仍记住；`ret_code` 非 0 时有错误态 | vitest：露点计算、日出日落解析、城市交集；截图 |
| S8 | Claw | 传感器：207 实时（15 秒；503 后 60 秒探测、恢复回 15 秒）+ 208 统计（5 分钟）；按天聚合；65536 / -100 / 缺省 0 无效值处理；达标率口径（Fable 复核）；改动 7 | 1 天 | S6a | 24 小时 / 7 日 / 30 日三档数据正确；无效值不参与统计；控制屏离线有空态；503 后不显示旧数据 | vitest：聚合与无效值、轮询跨周期；页面用例 |
| S9 | Claw | 温控面板：200 实时、209 统计、201 单房间开关与调温、206 全开全关；改动 8、9、10 | 1 天 | S6a、S3；Q5 | 只对 260911001、240829001 下发，且走 S4 的统一写入口；下发后回读值一致；失败时界面回滚 | vitest：201 请求体组装（不改字段传 -1，end_modes 不改传空列表）；页面用例；测试环境手动验证 |
| S10 | Claw | 新风除湿机：202 实时与汇总、210 读设置、204 写设置；改动 11、12、13 | 1 天 | S6a、S3 | 下发走 S4 统一写入口；`app_code` 非 12 无设置面板；`control_type=-1`、`can_change=false` 时正确禁用 | vitest：设置表单状态；页面用例；测试环境手动验证 |
| S11 | Claw | 连接状态（205，30 秒刷新）；项目离线态改造；系统设置页处理（通知开关按 Q12 去掉，页面留空态；隐藏系统设置入口与路由另开 PR，排基线队列队尾，已获赤兔授权改 main.tsx） | 0.5 天 | S6a | 三种连接状态筛选正确；离线项目的 4 个设备页显示空态而非旧数据 | 页面用例；截图基线更新 |
| S12 | Chitu | 统一控制：先做逻辑层，页面在 S6a、S3a 之后；批量下发、结果轮询、最近一次结果；改动 5、6 | 1 天 | 逻辑层 S4；页面 S6a、S3a；Q6 | 只对 260911001、240829001 下发；`app_code` 为 12 的项目温度禁用；35 秒内给出最终结果 | vitest：请求体组装、轮询终止条件；页面用例；测试环境手动验证 |
| S13 | Chitu | 收尾与交付：全站错误态走查、测试环境完整走一遍、删除生产包里的 mock、交付包与部署文档、hvac-demo 上线 | 1 天 | 全部 | 交付包在本地 nginx 按文档能跑起来；改一处 `config.js` 即可换后端 | 全量回归；交付包冒烟脚本 |

说明：S6b 及之后各页面段会有意改变界面（去字段、去按钮），该段 PR 同时更新截图基线，并在描述里对应到改动文档条目或「接口无此字段」。

## 7. 部署与交付

### 7.1 hvac-demo（沿用现状）

**现在的部署方式**（已核对 `wrangler.toml` 与 `worker/index.js`）：Cloudflare Workers 静态资源。本机执行 `npx wrangler deploy`，它先自动跑 `npm run build`，再把 `dist/` 和 `worker/index.js` 一起发布到自定义域名 `hvac-demo.haoqianglyu.com`。Worker 先于静态资源执行，负责 `/api/login`（用 Worker 密钥 `BASIC_PASS`、`ADMIN_PASS` 校验两个演示账号）、SPA 回退、缓存头和 `noindex`。没有 CI 自动部署，是手动发布。

**正式版的变化**：
- 发布方式不变，仍是合并到 main 后本机 `npx wrangler deploy`。
- Worker 的 `/api/login` 换成 `/api/*` 反向代理，上游由 `wrangler.toml` 的 `API_UPSTREAM` 变量决定。
- `BASIC_PASS`、`ADMIN_PASS` 两个密钥在 S5 上线后删除。
- `config.js` 设为不缓存，`/assets/*` 保持长缓存。
- 上游指向测试环境（证书有效，已实测）。切到生产需要负责人确认，届时写操作模式按 3.6 处理。
- 上线顺序：演示版已确定保留（负责人答复），现有 mock 版挪到 `hvac-mock.haoqianglyu.com`，`hvac-demo` 改接真接口，因此不需要另起 Worker 名称过渡（Q14 ①已答复；② 切生产的时间、③ 源码权限仍待定）。
- **已落地（S13 准备）**：两个站共用一份构建和 `worker/index.js`，按 `wrangler.toml` 的 `DATA_SOURCE` 区分。
  - `hvac-demo`（默认环境，`npx wrangler deploy`）：`DATA_SOURCE=real`，`/api/*` 转发到 `API_UPSTREAM`（只能是 `ALLOWED_UPSTREAMS` 里的测试环境，否则一律 500）；只允许 GET / HEAD / POST（其他 405），只转 `Authorization / Content-Type` 和请求体，路径按字符白名单 `[A-Za-z0-9._~/-]` 校验（出现 `%` 即拒绝），空段、`.` 段、`..` 段也拒绝，一律 404，不跟随重定向，去掉上游 `Set-Cookie`、CORS 头、`Location` 与 `Server` 等指纹头，统一加 `nosniff` 和 `CSP sandbox`，20 秒超时返回 504，连不上后端返回 502（前端按网络中断处理，写操作提示「后端连接失败，下发结果未知」），跨站请求 403，不记录请求体与令牌。`/config.js` 由 Worker 生成（`dataSource=real`、`apiEnv=test`，白名单沿用前端默认值）。没有演示账号，`BASIC_PASS / ADMIN_PASS` 已从该 Worker 删除。
  - `hvac-mock`（`npx wrangler deploy --env mock`）：演示数据，`/api/login` 校验两个演示账号（密钥设在 `hvac-mock` 上），其余 `/api/*` 返回 404，不转发；`/config.js` 同样由 Worker 生成（`dataSource=mock`）。

### 7.2 给对方后端的交付物（部署到 int.cosyhome.com.cn）

1. `hengjing-cloud-<版本>-<commit>.zip`：`dist/` 静态文件，内含 `config.js`。
2. `docs/部署说明.md` 构建与部署说明（`docs/deploy.md` 只讲 hvac-demo / hvac-mock 测试站）；包由 `scripts/build-prod.sh` 生成：
   - 构建：Node 版本、`npm ci && npm run build`、`scripts/build-prod.sh` 的 `API_BASE`、`OUT_DIR`。
   - 配置：`config.js` 里的 `apiBase`、`writeMode`。
   - nginx 示例：SPA 回退（`try_files … /index.html`）、`/assets/` 长缓存、`index.html` 与 `config.js` 不缓存、`/api/` 反向代理到后端 `/v1/`。
   - 如果不做反向代理而让浏览器直连 `control.cosyhome.com.cn`，后端需要为 `int.cosyhome.com.cn` 开 CORS（目前预检返回 403）。
   - 默认部署在域名根路径；放子路径目前不支持（`vite.config.ts` 未设 `base`），需要时再加。
3. 用到的接口清单（路由 + 用到的字段），方便后端评估改动影响。
4. 版本信息：页面底部和 `version.json` 带 commit 与构建时间，便于报问题时对版本。
5. 源码仓库访问权是否一并交付，由负责人决定（Q14）。

## 8. 风险与待确认问题

### 8.1 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 拿不到 200–210 的 proto 字段编号 | 全部 ctrl 页面（S8–S12）无法开工 | Q1 最先问；S0–S3、S5–S7 不依赖它，可先做 |
| 对真实设备误下发 | 影响客户现场 | 3.6 的写防护 + 二次确认 + CI 不连真实后端 |
| 接口字段少于设计稿 | 首页、新风、连接状态页会出现空位，与设计稿不一致 | 1.2 已逐项列出去留；布局重排在各段 PR 里出截图给负责人过目 |
| 页面定时刷新给控制屏带来压力 | 现场控制屏变慢或后端限流 | 间隔做成可配置，默认 15 秒，Q7 确认 |
| 测试环境与生产行为不一致、测试项目控制屏不在线 | 联调受阻 | Q2 要一个长期在线的测试项目；切生产前做一次只读走查 |
| Tailwind / shadcn 引入后外观漂移 | 违反「外观保持原样」 | 不引 preflight、截图零差异门槛、分两段迁移 |
| 刷新令牌轮换下的并发 | 多标签页互相踢下线 | 单例刷新 + Web Locks，S5 有专门用例 |

### 8.2 待确认问题（按优先级）

**P0：不回答就无法开工对应段**

- **Q1（后端）** 请提供 `ctrlcb.proto` 中 200–210 相关消息的定义（含字段编号）。没有它，所有设备页面和统一控制都无法编码请求。
  - 已实测（11/24），仍需后端：空 Query 的 200/202/205/207 可以不用 proto，直接按线格式解出 Reply；但 200 的字段号不连续（跳到 #15、#16），靠猜不可靠，仍然要 proto。详见 `api/实测记录-1124.md`。
- **Q2（后端 / 负责人）** 测试环境里哪些项目可以随意下发指令、且控制屏长期在线？最好 `app_code` 为 12、8 和其他值的各一个。
  - 已答复：260911001 和 240829001 两个项目可以做下发测试，其他项目一律不下发。
  - 已实测（11/24），仍需后端：测试环境只有 1 个项目在线（测试项目0829，app_code 1）；app 8（24 个）和 app 12（2 个）全部离线。
- **Q3（后端）** 恒境云登录时 `isdp` 传 true 还是 false？
  - 已实测（11/24），结论：传 `isdp=true`。平台账号可以登录；测试经销商账号 1xxxxxxxxxx 传 true 被拒（500 `{"code":13,"message":"经销商未配置集成功能"}`），但它的 /me 里有 `integrated_feature`，要后端查明原因。修好之前，经销商联调临时传 false。
- **Q4（后端）** ① `permission_paths` 里哪些 path 对应恒境云的页面和 5 个写接口（201、203、204、206、批量下发）？是否要求前端按它隐藏菜单或禁用按钮？② `refresh_token` 有效期多长，同一账号是否允许多处同时登录？③ 错误响应体的格式是什么？
  - 已实测（11/24），部分有结论：① 网关按 `permission_paths`（`/v1/...` 路由模板）拦截，不在列表里就返回 403 `no permission`，`can()` 直接匹配模板即可；**测试经销商缺少天气、常用项目、集成统计、ctrl 200–210、统一控制的权限**，需要后端补。② `/auth/refresh` 实际必须带 `Authorization: Bearer access_token`（文档说不用）；refresh 每次轮换，旧的立即作废；**每个用户只有一个有效 refresh**，新登录会让其他会话的 refresh 失效（多设备最迟 2 小时后被踢）；过期的 access 能否用于刷新还没测，前端先按「过期前主动续期」做。③ JSON 错误为 `{code(gRPC 码), message}`，HTTP 按 gRPC 码映射（16→401、13→500、14→503），**没有 404**；令牌无效时网关返回 **403 text/plain `token err`**；ctrl 的业务错误是 HTTP 200，错误文案放在 Reply 的 #2 字段。

**P1：影响具体页面的做法**

- **Q5（后端，已答复）** 201 只改温度或开关时，其余字段一律传 -1（不是带回 200 读到的值）；设定温度暂定 16–30°C、步长 0.5，后端之后在接口里给范围，缺失时回退 16/30/0.5。
- **Q6（后端 + 负责人）** 统一控制：① 已答复：`app_code` 为 12 的项目温度设定不可用，房间开关仍可用；② 已答复：只能选同一集成项目组内的项目，同组 `app_code` 相同，前端不存在混选，按所选组的 `app_code` 决定温度是否可用；③ 运行模式选项是用 `OperatingMode` 的全部 14 个值，还是只开放其中几个？④ 经销商账号查执行记录时，后端是否已按账号限定范围？
- **Q7（后端）** ① 208/209 的 `start_time / end_time` 是秒还是毫秒？一次最多能查多长（30 天是否可以）？② 无探头 / 未初始化字段返回 65536（后端已答复，前端视为无数据并隐藏）；③ 200 的 `wind_speed` 档位数字含义；202 的 `wind_level`、`dehumidifier_status` 取值含义，`filter_life / filter_running / running_time` 的单位。④ 204 的露点、湿度设定范围。⑤ 页面每 15 秒刷新一次 ctrl 读接口是否可接受？⑥（S8）208 同一小时返回多条时以哪条为准（权威顺序）？缺省字段解码为 0 是否一律表示无数据？208 的小时值是该小时的均值还是瞬时值？
  - 已实测（11/24），部分有结论：① **毫秒**（传秒返回空）；跨度到 365 天不报错，但测试数据太少，性能未验证。`date` 是小时起点的毫秒时间戳，`hour` 是北京时间小时。② 后端已答复无探头返回 65536；另外发现无数据的 floor_temperature 返回 0（缺省），不是 -100。③ 只有 1 个样本（值为 3），仍需后端。⑤ 单次 0.7–1.9 秒，离线项目 0.7 秒就返回 503。
- **Q8（后端，已答复）** `GetWeather` 的 `city` 传国标行政区划码（也接受城市名）；城市列表用 `/wx/city-list`（返回城市名，测试服只有无锡、苏州，正式服全量），与本地省市级联数据取交集，不自建表；经销商需开该接口权限。
  - 已实测（11/24），结论：`city` 用**国标行政区划码**（即 showapi 的 areaCode，市级 320500、区级 320506 都可以，和项目的 `customer_region` 是同一套），城市名也行，areaid 不行。`/wx/city-list` 测试服只返回 `["无锡","苏州"]`（正式服全量），与本地省市数据取交集使用；城市选择不自建表，见上一条结论。**仍需后端：`/weather`（GetWeather）在测试环境全部返回 500 unmarshal 错误，要修**；`/weather24` 正常。
- **Q9（后端）** ① 界面上的「项目 ID」显示 `code` 还是 `number`？② 集成项目的应用类型名称从哪取（只有 `app_id`）？③ `brief_stat` 里有没有温度、湿度、CO₂？④ 有没有项目的最后在线时间？
  - 已实测（11/24），结论：① 显示 `code`（全部都有且唯一，如 261102001；`number` 只有 12/433 填了，是自由值）。② 用 `POST /apps` 按 `app_id` 查名称（两种账号都能调，共 11 条）；ProjectEntity 自带 `app_name`。③ `brief_stat` 只有 `device_count / room_count`，没有温湿度和 CO₂，常用项目卡去掉这一行。④ 没有最后在线时间；`online` 只在 true 时出现，缺失就按离线处理。

**P2：可以先按默认做法推进**

- **Q10（负责人，已答复）** 天气后端已改 7 天版（`f1`–`f7`），按 7 天做；24 小时图只画温度，7 天版没有的字段（湿度、体感等）隐藏。
- **Q11（后端）** `page_options.limit` 的上限是多少？一个集成项目最多会有多少个项目？
  - 已实测（11/24），结论：`limit` 没有实际上限（测到 5000），不传 `page_options` 就返回全部（平台 433 条约 1.5 秒），前端一次取完再分页可行。测试环境一个集成项目最多 2 个项目，生产规模仍需后端给数。另发现：`only_online=true` 返回空、`project_ids` 过滤不生效、经销商集成项目 `total` 多算 1 个。
- **Q12（负责人）** 没有接口支撑的界面元素默认隐藏：忘记密码、其他登录方式、顶栏铃铛、系统设置页的通知开关。是否同意？
- **Q13（负责人）** 改动文档第 7 条的理解：去掉「超标时长」这一列，其余的平均/最大/最小由前端从 208 的小时数据算出。对吗？
- **Q14（负责人）** ① 已答复：演示版保留，挪到 hvac-mock 域名。② hvac-demo 何时从测试环境切到生产后端？③ 给对方后端的交付是否包含源码仓库权限？

## 负责人答复（11/24 09:31 CST）
- Q1：proto 定义稍后由周强提供。
- Q2：测试环境有可随意下发的项目，但还缺 app_code=12 的项目（待补）。
- Q5：温控面板可修改「温度」和「节能模式」（界面需设计）；风速暂不修改；设定湿度去除（见改动文档）。未改字段如何回传仍按「200 读到的当前值原样带回」处理，待 proto 到后核对。
- Q6：统一控制只能选择同一个集成项目组里的项目；同组项目应用类型（app_code）相同，创建时已限制 → 前端不存在混选 8/12 与其他的情况，按所选组的 app_code 决定温度设定是否可用。
- Q3：登录传 isdp=true（原有接口不受影响）。
- Q10：天气后端已改 7 天版（测试服 /weather 500 待唐学未修）→ 按 7 天做；7 天版没有的字段（湿度/体感等）隐藏。
- Q12：没有接口支撑的元素一律隐藏；账号管理不在本平台（忘记密码、其他登录方式、账号/用户管理相关入口全部去掉）。
- Q13：确认——去掉「超标时长」，平均/最大/最小由前端从 208 小时数据算（负责人 11/24 09:37）。
- Q14：演示版保留（负责人 11/24 09:38）→ 现 mock 版挪到 hvac-mock.haoqianglyu.com，hvac-demo 接真接口。
- 天气：7 天版返回字段 f1–f7 分别是第 1–7 天（唐学未 11/24 09:40）；后端仍在改，天气段暂缓。
- Q5 补：设定温度暂定 16–30°C、步长 0.5；后端之后会在接口里加设定范围字段 → 前端按接口返回的范围，缺失时回退 16/30/0.5（负责人 11/24 09:49）。
- Q5 定：201 下发时所有不修改的字段一律传 -1（不是带回 200 读到的值）（负责人转唐学未，11/24 09:51）。
- 201 字段（文档 4.2）：wind_speed 100=自动风速；eco 1 节能 / 0 标准；switch 1 开 / 0 关 / -1 不变；所有不改的标量传 -1；end_modes（repeated WorkModeData）至少选中一项，修改时须传获取到的完整信息——本期末端只读，不改时传空列表（待联调确认）。
- 后端答复（11/24 09:57）：④设定范围下一步在接口提供；⑤所有设置接口不变项都传 -1；⑥201 success=true 即面板已生效；⑦房间关闭时界面不允许设置（虽然后端会接受、开机后生效）；⑧wind_speed <100 为对应档位，100 为自动；⑪无探头/未初始化字段返回 65536（设备字段 2 字节最大 65535，65536 = 未初始化）→ 前端遇 65536 视为无数据并隐藏该项；其余（筛选、经销商可见范围等）等另一位后端答复。
- 城市选择用 /wx/city-list（测试服只有无锡、苏州，正式服全量；返回城市名，天气接口接受城市名）；经销商需开 /wx/city-list 权限（负责人 11/24 10:13）。
- 城市选择照数据平台 WeatherRecord.vue：/wx/city-list 返回 city_names，与本地全国省市级联数据（cosydata_fable/src/utils/cascader_disdrict.js）取交集做省→市二级选择；露点复用 utils/dewPoint.js。
- 项目列表与在线筛选用 POST /v1/ctrl/projects（{only_online:true} 只返回在线；条目带 online:true，缺失即离线；字段比 /projects 多 mode、app_version 等）（后端 11/24 10:22，已实测）。
- app_code 8 暂不用本平台，不测；主要支持 1 与 12（负责人 11/24 10:37）。
