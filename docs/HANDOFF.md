# 交接：S10 新风、S7 天气（Claw → 赤兔，11/24）

S10、S7 从 Claw 转给赤兔。这份文档写 Claw 这边踩过的坑和已知的约束，供 Fable 出方案。下发口径以 `docs/分工.md` 第 3、4 节为准，本文不重复。

---

## 1. S9 写路径踩过的坑（S10 直接照抄这套）

### 1.1 end_modes：没改传空列表，改了完整回传（后端 11/25 答复第 3 条，覆盖原来的「永远原样回传」）
- 没改末端传空列表（表示不改末端）；改了末端就把该房间全部末端完整回传，只换 is_selected（`edit.ts` 的 `endModesFor`）
- 末端 switch 是状态显示，由控制屏自己控制，不能改；完整回传时原样带回读到的值
- 读不到末端不再禁用下发
- 温控页已接入末端选择（点末端标签）；`record201` 带 `ends`，`matchRoomSet` 逐个比对 `is_selected`（switch 不比），「末端 + 温度」一起改时末端不一致整体判未变化
- S10 对应：204 没有 repeated 字段，但同样要用"确认后新读的 210"组装，不能用弹窗前的旧读数

### 1.2 claim 必须在 beforeSend 链的最后
- `writeOnce` 先 await 令牌续期，再同步调 `beforeSend`，再 fetch。`claim(token)` 放在别的检查之后、链的最后一个：
  `beforeSend: () => sameSession() && sameProject() && present() && claim(token)`
- 拿到写请求的 Promise 后立刻 `markSent(token, p, record)`；`markSent` 在 `claim` 之前或之后都可以
- 发送前先调 `checkSentRecord(record)`，不通过就 `release(token)`、提示原因、不发送
- 要在**用户点了确认之后**再 `acquire`：held 状态 30 秒到期（#30），用户犹豫久了 claim 会失败
- 写结果分类直接复用统一控制的 `outcomeOf`：只有 503 + code 14、写防护、401、认领前出错算"未下发"；不带 code 的 503、纯文本 503、超时、500 都是"结果未知"，锁保持

### 1.3 核对与否决提交
- success 只算"已下发"，核对一致才放锁（#31，Fable 裁定）。结果四态：已生效 / 未变化 / 无法核对 / 结果未知，优先级 结果未知 > 未变化 > 无法核对 > 已生效
- 核对函数一致时返回 `{ same: true, commit }`，成功提示、清草稿、写缓存都放在 `commit` 里——只有写锁认可这次核对（锁没换、没过期、没换号、没中止）才会调到
- `commit` 可以返回 `false` 否决提交（94678c8，Fable 裁定）：S9 在 `commit` 第一行同步检查"这次读数还是不是最新"，否决时锁不放、记 mismatch、`lastVetoed` 置位，界面继续显示「已下发，正在核对…」
- 核对读数只是候选，认可后才写查询缓存；所有 200 读取带递增序号，不覆盖更新的读数
- 草稿的"待确认"状态和锁分开维护：锁到期只恢复下发资格并强制重读，草稿保留，直到认可的一致、确定失败或用户点「放弃本次改动」
- 收口规则（Fable）：放锁的定序点就是 `commit` 回调里的同步检查；同类时序意见要有能跑的复现、后果超出"展示短暂偏早"才受理

### 1.4 核对器注册时机（#38 之后）
- 所有核对器都写在 `src/app/writeLockSetup.ts`，按 QueryClient 幂等
- 203 和 `configureWriteLock` 由 AppProvider 调；201、206 由 OrgGate 在组织数据就绪后注册（`registerThermostatVerifiersOnce`），注册后不随就绪状态注销
- S10 的 204 核对器照 201/206 的方式，由 OrgGate 调

### 1.5 其他
- 确认要在真正发起下发的组件里取（`useConfirm()` 或 `useApp().confirm`），不要从父组件取了往下传
- 目标设备 id 必须在原始回包里恰好出现一次，确认前和预检各查一次；回读里 id 重复或无效判"无法核对"
- 回读字段 proto3 缺省 = 0，是真实读数（后端 11/25 答复第 9 条：0 有效，-100 才无效）；"无法核对"用于目标条目缺失、空回包、目标在回读里没有对应字段、读数无效（-100、65536、-1），以及房间开关未上报期间（`features.roomSwitchReported = false`）的房间开关
- 真机：两次实测（203 全开、201 开房间）都返回 success 但读数不变。后端 11/25 答复第 1 条：控制屏没上报房间状态，读到的是默认值 0，这两次应改记为无法核对，见 `docs/api/实测记录-1125-下发.md` 末尾。下次测试要抓 201/204 的请求和回复原文

---

## 2. 新风接口实测情况

只读联调只测过 240829001（app_code 1），详见 `docs/api/实测记录-1124.md` 的 Q7。**204 从来没有下发过。**

### 202 新风除湿机读取
- 240829001 有 1 台（id 9326461980）。读到：#8=20、#9=100、#10=1、#12=`除湿`、#13=2、#15=1
- 按 proto：`dehumidifier_freq=20`、`filter_life=100`、`filter_life_p=1`、`running_mode=除湿`、`running_time=2`、`is_connected=1`。**filter_life 和 filter_life_p 看起来像是反了**，待后端确认
- 改动文档要求的汇总列：设备、开关、模式、运行时间、滤网运行时间、滤网寿命（百分比）

### 210 运行设置读取
- 在 240829001 上用 202 的设备 id 读，回复只有 #2 = `该软件类型不支持此控制`，符合"只有 app_code 12 才有设置项"
- 260911001（app_code 12，独立空气系统）当时离线，**没读过**；现在两个测试项目都在线，可以读
- 字段（proto 1964 行起）：`id`、`name`、`control_type`（1 露点 / 0 湿度 / -1 都不可控）、`dew_point`（-1 显示 --）、`humidity_set`（-1 显示 --；11/25 第 5 条：210 读到 -1 表示这一项不能设置）、`wind_speed`（**0 低 / 1 高 / 2 自动，和 200 的 1–99 档位、100 自动不是一套**）、`switch`、`can_change`

### 204 运行设置下发
- 字段（proto 1975 行起）：`id`、`name`、`control_type`、`dew_point`、`humidity_set`、`wind_speed`、`switch`（-1 不变）
- 不变：数值字段 -1（后端 11/25 答复第 4 条）；枚举字段用该枚举里的不变值（203 system_mode = 0，OPERATION_MODE_NONE；11/25 15:35 真机确认，传 -1 会 unknown enum、504）
- 回读用 210，可核对字段：`control_type`、`dew_point`、`humidity_set`、`wind_speed`、`switch`
- 坑：`control_type = 0`（湿度控制）、`switch = 0`、`wind_speed = 0`（低）在线上都会省略，回读缺省就是 0，按真实读数比对
- 两个测试项目共用控制屏 667b7cc6…，写锁按屏加：S10 下发 260911001 时，240829001 的温控、统一控制也会被锁住

---

## 3. S7 天气城市选择器

### 数据源
- 选择器：强哥定的是用 `/wx/city-list` 加省市级联，照数据平台「气象记录」页的做法。级联数据在 cosydata_fable 仓库 `src/utils/cascader_disdrict.js`（每个城市带行政区划码）；露点用同仓库 `utils/dewPoint.js` 算。Claw 没有 cosydata_fable 的权限
- 实测：`/wx/city-list` 只返回 `["无锡","苏州"]`、没有编码，看起来是"有历史天气记录的城市"；**经销商账号 403**。要和"取交集"的方案对一下：测试服交集后只剩两个城市，经销商无法使用
- 项目自带 `customer_region`（如 `320000/320500/320506`），和天气接口接受的行政区划码是同一套，首页默认可以直接用项目所在地的市级或区级码

### 天气接口
- `/weather`（实时 + 7 天 f1–f7）：11/24 实测**全部 500**（unmarshal 失败），后端 bug，修好后要复测是否接受行政区划码。样例在 `docs/api/weather-sample-320500.json`
- `/weather24`（24 小时）：正常，城市名和行政区划码（市级 320500、区级 320506）都能用，areaid 不行；无锡首次请求偶发 500，重试就好
- 改动文档：首页天气加相对湿度、露点、风向、风力、气压、紫外线；右上角选城市，浏览器缓存上次选择；7 天版没有的字段隐藏
- S7 要改 Home.tsx，S6b 已经把首页统计和常用项目接上真实数据，注意别冲掉

---

## 4. 半成品分支

没有需要接手的半成品。

| 分支 | 状态 |
|---|---|
| `hide-settings` | 进行中（Claw 收尾：隐藏系统设置入口与 /settings 路由，全部基线统一重录一次） |
| `wip-31-presence`、`wip-31-before-bdbc2c6` | 已废弃（#31 的中间版本，presence 方案已被 Fable 撤销），只在 Claw 本地，不会推 |
| `s9-screenshot-compare` | 只放 S9 截图前后对比图，不合并 |
| 其余 `s2a`…`s9`、`write-lock`、`write-result-semantics`、`fix-29-held-ttl`、`docs-live-1124-s9` | 都已合并，可删 |

Made by [Tomo](https://github.com/shuaiyuan17/tomo)
