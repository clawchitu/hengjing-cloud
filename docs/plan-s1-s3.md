# 恒境云 S1–S3 执行说明：Tailwind 4 + shadcn/ui 底座迁移

日期：2026-11-24 · 上游：`docs/plan-v1.md` 第 4、6 节 · 前置：S0（Playwright 截图基线，55 张（56 条用例），`threshold: 0` 且 `maxDiffPixels: 0`，CI 用单线程软件光栅化）已合并。

**硬约束**：保留 React + Vite；shadcn/ui 只做组件底座与行为层；视觉参数全部来自 `src/styles/global.css` 的 `:root`；三段结束时界面与 S0 基线一致；不做《界面改动-1123》里的任何变化；Font Awesome 保留，不引入 lucide；不做暗色模式。

**与 plan-v1 的出入（以本文为准）**：① Card、pill 也纳入 S2，但只是换成 shadcn 外壳，样式不变；② Seg 不换 ToggleGroup，保留自绘；③ 工作量由 2.5 天上调为 4–5 天（见各段）。

## 0. 先读：三条贯穿全程的规则

1. **层叠顺序决定一切**。现有手写 CSS 不在任何 `@layer` 里，Tailwind 的 theme/base/utilities 都在 layer 里，所以**旧 CSS 永远赢过 Tailwind 工具类**，与书写顺序、选择器权重无关。好处是旧界面不会被动到；坏处是旧的全局规则会压住 shadcn 组件上的工具类（见第 5 节 A 类）。
2. **不引入 Tailwind preflight**（沿用 plan-v1 第 4 节的决定）。全量 preflight 会改动行高、标题字重、`small` 字号、占位符颜色、复选框外边距等十余处（第 5 节 B 类），逐一钉回去比不引入更脆弱。shadcn 组件需要的重置，用一份只作用于 `[data-slot]` 元素自身的小型重置代替。
3. **迁一个删一个**。某个旧类的最后一个使用点迁走后，同一个 PR 里删掉 global.css 中对应规则，避免新旧两套并存。`pages.css`（页面布局）三段内都不动，除非第 5 节点名。

## 1. S1：接入 Tailwind 4 与 shadcn 配置，token 映射（不改任何组件）

**范围**：装依赖、配别名、建 Tailwind 入口与 token 映射、处理会压住 shadcn 的旧全局规则。页面 TSX 只允许做类名重命名（`.grid`）。

**改动文件**

| 文件 | 改动 |
| --- | --- |
| `package.json` | 加 `tailwindcss`、`@tailwindcss/vite`、`class-variance-authority`、`clsx`、`tailwind-merge`、`tw-animate-css`。不装 `lucide-react` |
| `vite.config.ts` | 加 `tailwindcss()` 插件；`resolve.alias` 的 `@` 指向 `src` |
| `tsconfig.json`、`tsconfig.app.json` | 两处都加 `paths: { "@/*": ["./src/*"] }`（shadcn CLI 读根 tsconfig）。TS 7 下不写 `baseUrl` |
| `components.json`（新） | `style: new-york`、`rsc: false`、`tsx: true`、`tailwind.css: src/styles/tailwind.css`、`cssVariables: true`、aliases 指向 `@/components/ui`、`@/lib/utils` |
| `src/lib/utils.ts`（新） | `cn()`（clsx + tailwind-merge） |
| `src/styles/tailwind.css`（新） | 见下 |
| `src/styles/global.css` | 第 34–39 行的元素级重置移入 `@layer base`；`.grid` 改名 `.hj-grid`；`:root` 增加扩展变量 |
| `src/main.tsx` | 在 `global.css` 之前 `import './styles/tailwind.css'` |
| `src/pages/*.tsx`、`pages.css` | `className="grid ..."` 全部改成 `hj-grid`（含 `.grid.g2–g5` 的用法） |

注意：现有 `src/components/ui.tsx` 与 shadcn 默认目录 `src/components/ui/` 同名。S1 先把 `ui.tsx` 改名为 `src/components/legacy.tsx` 并更新 import（纯改名），S2 逐步清空它。

**`tailwind.css` 结构**（手写，不要用 `shadcn init` 生成的内容覆盖；init 写入的 oklch 中性色 `:root`、`.dark` 块、`@custom-variant dark` 全部删掉）

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source(none);   /* 不引 preflight.css */
@source "../**/*.{ts,tsx}";                                          /* 只扫 src，避开 docs/、ref/ */
@import "tw-animate-css";
@theme inline { /* 见下表 */ }
@layer base {
  :where([data-slot]), :where([data-slot])::before, :where([data-slot])::after {
    box-sizing: border-box; margin: 0; padding: 0; border: 0 solid var(--line);
  }
  :where(button, input, select, textarea)[data-slot] { font: inherit; color: inherit; background: transparent; border-radius: 0; letter-spacing: inherit; }
  :where(h1, h2, h3, h4, h5, h6)[data-slot] { font-size: inherit; font-weight: inherit; }
}
```

不要照抄 shadcn 文档里的 `* { @apply border-border outline-ring/50 }`：它会改掉所有原生控件的焦点环颜色。

**Token 映射**（`@theme inline`，值一律 `var(旧变量)`；27 个旧变量名和值都不改）

| Tailwind / shadcn 语义 | 取值 | 说明 |
| --- | --- | --- |
| `--color-background` / `--color-foreground` | `var(--bg)` / `var(--text)` | |
| `--color-card`、`--color-popover`（及 `-foreground`） | `var(--card)` / `var(--text)` | |
| `--color-primary` / `-foreground` | `var(--primary)` / `#fff` | |
| `--color-secondary`、`--color-accent`（及 `-foreground`） | `var(--primary-soft)` / `var(--primary)` | 菜单项 hover 另用 `bg-background`，见 S3 |
| `--color-muted` / `--color-muted-foreground` | `var(--bg)` / `var(--muted)` | **重点**，见下 |
| `--color-border`、`--color-input` | `var(--line)` | 卡片边框是 `#e9eef4`，另加 `--color-card-border` |
| `--color-ring` / `--color-destructive` | `var(--primary-2)` / `var(--red)` | |
| `--radius-sm / md / lg / xl / 2xl` | 6 / 8 / 10 / `var(--radius)`=14 / 16 px | 写死像素，不用 shadcn 的 `calc(var(--radius) - 2px)` |
| `--font-sans`、`--font-num` | `var(--font)`、`'Barlow', var(--font)` | |
| `--shadow-card`、`--shadow-pop`、`--shadow-modal` | `var(--shadow)`、搜索弹层、`.modal` 的阴影值 | |
| 扩展色（shadcn 没有） | `--color-navy / navy-2 / navy-3 / navy-active`、`--color-primary-2 / primary-soft / primary-line`、`--color-line-2`、`--color-text-2`、`--color-faint`、`--color-green / green-2 / orange / amber / amber-2 / red-2 / indigo / sky` | |
| 状态色 soft 版（新增到 `:root`） | `--green-soft`（已有）、`--amber-soft:#fffbeb`、`--orange-soft:#fff7ed`、`--red-soft:#fff1f2`、`--blue-soft:#eff6ff`、`--purple-soft:#f5f3ff`、`--gray-soft:#f1f5f9` 及对应前景 `#d97706 / #ea580c / #2563eb / #7c3aed` | 取自 `.pill.*`，S2 的 Badge 用 |

**变量重名（必须照做）**：旧 `--muted` 是**文字灰** `#64748b`，全站 `color: var(--muted)` 在用；shadcn 的 `--muted` 是**底色**。所以不在 `:root` 定义任何 shadcn 同名变量，只在 `@theme inline` 里建 `--color-*` 映射。同理旧 `--radius`=14px 是卡片圆角，不能当 shadcn 的控件基准。旧 `--text`、`--text-2`、`--shadow`、`--font` 不能原名放进 `@theme`（`--text-*` 在 Tailwind 4 是字号命名空间）。后续凡是 shadcn 组件源码里直接写 `var(--muted)`、`var(--radius)`、`var(--border)`、`var(--popover)` 的地方（已知：sonner 包装、sidebar、chart），加入时逐个改成本项目变量。

**验收**
- `npm run e2e` 55 张基线全部零差异（阈值不动）；`typecheck`、`lint`、`test`、`build` 通过。
- 临时在某页写 `<div className="bg-primary text-primary-foreground rounded-md shadow-card p-4">`，目测等于 `.btn.primary` 的颜色与 8px 圆角后删除。
- PR 描述记录 CSS 与 JS 产物体积前后值（预期 CSS 增量 < 10 KB gzip）。

**风险与回退**
- 风险：`.grid` 改名漏改一处会直接掉布局（截图能抓到）；元素级重置移入 layer 后优先级降低，理论上零影响，以截图为准。
- 回退：本段不动组件，`git revert` 整个 PR 即可，无数据与接口牵连。

**工作量**：0.5–1 天。可拆：S1a（依赖 + 配置 + token，零 TSX 改动）、S1b（`.grid` 改名 + 元素重置入 layer + `ui.tsx` 改名）。

## 2. S2：基础组件替换

**做法**：`npx shadcn add <组件>` 生成到 `src/components/ui/`，然后**立即把默认样式改成恒境云的数值**（下表「目标样式来源」），图标换成 Font Awesome，删掉所有 `dark:` 类。一个组件一个 commit：加组件 → 替换全部使用点 → 删旧 CSS → 跑 e2e。

| 组件 | 替换对象 | 使用点 | 目标样式来源 |
| --- | --- | --- | --- |
| Button | `.btn`（primary / ghost-primary / lg / block）、`.link` | 9 个页面、`store.tsx` 弹窗 | global.css 116–125。variant：default(白底描边) / primary / soft / link；size：default 36px、lg 42px。primary 的 3px 外发光用 `shadow-[0_0_0_3px_rgba(8,145,178,.18)]`，**不是焦点环** |
| Input | `.input`、`.row.input` 包裹式搜索框、登录 `.field` | Login、Groups、Control、Layout 顶栏 | 168–169、220–223。带图标的做成 `InputGroup`（外层画边框，内层 input 无边框） |
| Card | `Card`（legacy.tsx）、`.card-pad`、`.card-head`、`.card-title`、`.card-sub` | 全站 | 101–105。shadcn Card 默认 `py-6 gap-6 rounded-xl` 全部去掉，保留 `pad` 属性 |
| Badge | `.pill.*`（9 色）、`.badge`、`.lvl` | 全站 | 138–149。variant 用 soft 色变量；高 22px、圆角 6px、11.5px |
| Switch | `Toggle` | Thermostat、FreshAir、Settings | 133–136。40×22，滑块 16px，开 `--primary-2`，关 `#e2e8f0` |
| Tabs | `.dev-tabs` / `.dev-tab` 设备切换 | FreshAir | pages.css 29–35。只用 Radix 的行为，触发器外观照旧 |
| Table | `.table`（4 处）、`.ptable` | Groups、Control、FreshAir、Sensors、Connections | 151–158。shadcn 默认 `h-10 px-2 border-b` 改成 th `10px 12px`、td `9.5px 12px` + 上边框、首末列 22px |
| Select | 原生 `<select class="select">` | Groups(2)、Control(2)、Thermostat(1) | 170。触发器照旧；下拉面板是新外观，不在静态截图里 |
| Checkbox | `.checkbox`（原生） | Login、Control | 171。15×15；自绘后与原生有抗锯齿差异，属允许项 |
| Tooltip | 原生 `title=` | Home 常用项目卡、FreshAir 禁用按钮 | 白底、`--shadow-pop`、12px |
| Sonner | `store.tsx` 手写 toast | 全站 `toast()` | 188–191。顶部居中、距顶 72px、2600ms、成功/失败图标用 FA；`useApp().toast(text, err)` 签名不变，内部转调 sonner |

**保留自绘，只改成 Tailwind 写法**（不引入 Radix）：`Seg`（补 `role="radiogroup"` 与方向键）、`Pager`、KPI 卡（`.kpi`、`.k-ico`）、首页 `.stat` 统计卡、`.dot`、`.bar` 进度条、步进器（`.stepper`、`.temp-box .round`）、`.opt-btn` / `.mode` 选项块、`.btn-send` 与 `.btn-login` 渐变按钮（作为 Button 的 `gradient` variant 亦可）。
**完全不动**：`Chart`（ECharts）、`LogoMark`、`Avatar`、登录页左侧插画、`Ring` 等内联 SVG、`pages.css` 的页面布局类。

**逐页对照顺序**（由简到繁，每页过完再下一页）：Settings → Connections → Login → Home → Groups → Sensors → Thermostat → FreshAir → Control → Layout 外壳。

**验收**
- 每页截图：先期望零差异；出现差异按第 4 节判定。预计需要更新基线的只有：Checkbox（Login、Control）、原生 select 箭头若位置有亚像素变化。
- 新增键盘用例（Playwright）：Button 回车/空格触发；Switch 空格切换且 `aria-checked` 正确；Select 方向键选择、Esc 关闭并回到触发器；Tabs 左右键切换。
- `global.css` 的 116–171、188–191 行对应旧规则删除；`legacy.tsx` 只剩 Seg、Pager、Chart、LogoMark、Avatar 与 hooks。

**风险与回退**：见第 5 节 C 类。每个组件独立 commit，出问题可单独 revert；旧 CSS 在同一 commit 里删，revert 会一并恢复。

**工作量**：1.5–2 天。可拆：S2a（Button、Badge、Card、Table —— 纯外观类，无 Radix 行为）、S2b（Input、Checkbox、Switch、Select、Tabs —— 表单控件）、S2c（Tooltip、Sonner + 自绘件改 Tailwind 写法）。三者可按序各出一个 PR。

## 3. S3：交互组件与表单

**第 0 步（先于任何替换，单独 PR）**：当前基线没有任何弹层打开态。先在**旧代码**上补录：确认弹窗（退出登录、统一控制下发确认、新风下发确认）、toast（成功、失败）、项目切换菜单展开、顶栏搜索有结果 / 无结果、管理员经销商搜索。没有这一步，S3 的替换无从比对。

| 组件 | 替换对象 | 使用点 | 要点 |
| --- | --- | --- | --- |
| AlertDialog | `store.tsx` 的 `.mask` + `.modal` | 退出登录、Thermostat 全开全关、FreshAir 下发、Control 下发 | global.css 181–187：宽 440、圆角 16、遮罩 `rgba(15,23,42,.45)`。`confirm()` 的 Promise 签名不变。现状点遮罩可关闭，AlertDialog 默认不可——写操作确认改为不可点遮罩关闭，属行为变化，需在 PR 说明 |
| Dialog、Sheet、DropdownMenu | 无现有使用点 | — | 只加组件文件并套好 token；温控编辑设计（`docs/design/thermostat-edit.md`）明确不用弹窗和抽屉，故不挂到任何页面 |
| Popover + Command | 项目切换器 `.proj-menu`、顶栏搜索 `.search-pop`、经销商选择（`.dp-search` + `<select>`） | Layout、Groups、Control | 删 `useOutside`。列表项外观照 global.css 68–73 与 pages.css 328–333。经销商选择合并为一个可搜索下拉（Combobox）——这会改变 Groups 管理员视图的静态外观（搜索框 + 下拉变成一个触发器），**与「零界面变化」冲突，需负责人确认**；未确认前保持两个控件，只把 `<select>` 换成 S2 的 Select |
| DatePicker（Popover + Calendar） | 无现有使用点（时间范围是 Seg） | — | 需要 `react-day-picker`、`date-fns`。建议推迟到第一个真正需要它的段落再加；若坚持在 S3 做，只加文件不挂页面 |
| Slider | 原生 `input[type=range]` | Control 温度 | pages.css 232。原生与自绘外观必然不同，属允许项，更新该页基线 |

**无使用点的组件如何验收**：新建仅开发环境可见的 `/__ui` 展示页（`import.meta.env.DEV` 或 e2e 专用开关下注册路由，不进导航），把 Dialog、Sheet、DropdownMenu、DatePicker 各放一个打开态，录成新的基线图。

**表单校验库：推荐 react-hook-form + zod（配 `@hookform/resolvers` 与 shadcn `form.tsx`）**
- 理由：shadcn 的 Form 组件就是围绕 RHF 写的，接入成本最低；zod schema 可在 S4 的 API 层复用于响应校验；S9、S10、S12 的写操作（温度范围 16–30、露点 8–16、湿度 35–70）需要统一的范围校验与错误提示出口。 备选 TanStack Form 类型更强，但 shadcn 无官方封装，不选。
- S3 只做：装库、加 `form.tsx`、把 Login 迁成 RHF + zod 作为样板。错误提示仍走 toast，不加行内错误文案（那是界面变化）。
- 不迁：Control、FreshAir 的设置面板（步进器与选项块，不是文本表单），留在 `useState`，到 S10、S12 接真实接口时再定。

**验收**：第 0 步补录的打开态截图逐张比对；交互用例：Esc 关闭、焦点回到触发器、Tab 不逃出弹窗、Command 上下键与回车选择、输入过滤结果与旧实现一致（顶栏搜索最多 8 条）。`store.tsx` 不再含任何 JSX 弹层；global.css 68–73、181–193 删除。

**风险与回退**：Radix 弹层走 Portal 挂到 `body`，脱离 `.sidebar`（z-index 20）与 `.topbar`（10）的层叠上下文，统一用 z-50；离线页的 `.offline-data` 带 `inert` 与 `filter`，Portal 出去的弹层不受灰化影响（离线时本就不能操作，确认无可触发入口即可）。每个替换独立 commit 可单独 revert。

**工作量**：1.5–2 天（含第 0 步 0.25 天）。可拆：S3-0（补基线）、S3a（AlertDialog + Slider）、S3b（Popover + Command 三处）、S3c（RHF + zod + Login）、S3d（Dialog / Sheet / DropdownMenu / DatePicker + `/__ui`，可整体后移）。

## 4. 截图对比策略

- **每段每个 PR 都跑** `npm run e2e`（固定 Playwright 容器，与 CI 同镜像；本机直接跑的结果不作数）。全局阈值保持 `threshold: 0`、`maxDiffPixels: 0`，**不放宽**——0.5% 的页面级阈值足以藏住一个小控件 1px 的位移。
- **S1**：必须零差异，不允许更新任何基线。有差异就是配置问题，修到零为止。
- **S2、S3**：先以零差异为目标。失败时打开 HTML 报告的差异图逐张判定。

| 判定 | 情形 |
| --- | --- |
| 允许（更新该张基线） | 原生控件换自绘后的边缘抗锯齿差异（复选框、滑块、select 箭头）；圆角或描边处零散的亚像素色差，且周围元素位置不变；补录的弹层打开态中，下拉面板这类原本就是系统控件的部分 |
| 必须修 | 任何文字或盒子位移 ≥ 1px；页面总高度变化；颜色、字号、字重、行高、圆角、阴影变化；元素缺失或多出；差异区域落在本次未触碰的组件上（说明全局样式泄漏） |

- **更新基线的手续**：只用 `npm run e2e:update` 更新受影响的那几张（`-g` 过滤），不得整目录重录。PR 描述里逐张贴「前 / 后 / 差异图」三联，并写明原因（哪个组件、为何无法做到零差异）。评审人逐张看过才能合并。没有说明的基线变更一律打回。
- 对比不替代人眼：每段结束把 8 个页面在浏览器里点一遍，检查 hover、focus、disabled 这些截图覆盖不到的状态。

## 5. 高风险点清单

**A. 旧全局规则压住 shadcn 工具类（S1 必须处理，否则 S2 一上来就错）**

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `global.css:37` `button, input, select, textarea { font-size: inherit; color: inherit }` | 不在 layer 内，会压掉 Button 的 `text-white`、`text-sm` | 移入 `@layer base` |
| `global.css:39` `a { color: inherit; text-decoration: none }` | 同上，影响 `asChild` 渲染成 `<a>` 的 Button | 移入 `@layer base` |
| `global.css:106` `.grid { display: grid; gap: 16px }` | shadcn 大量使用 `grid` 类（Dialog、Card、Select），会被强加 16px 间距 | 改名 `.hj-grid` |
| `global.css:147` `.pill.dark` | 若保留 shadcn 的 `dark` 变体（`.dark *`），该元素的后代会触发暗色样式 | 不声明 dark 变体，删光 `dark:` 类 |
| `global.css:189` `.toast`、`:60` `.badge`、`:101` `.card`、`:168` `.input`、`:170` `.select`、`:151` `.table` | 与组件概念同名；sonner 旧版包装会给元素加 `toast` 类，叠上旧的 padding 与动画 | 对应组件迁完即删旧规则；sonner 的 `classNames` 不用 `toast` 这个名字 |

**B. 若有人打开全量 preflight 会坏掉的地方（本方案不打开；留作禁区说明）**

| 位置 | 后果 |
| --- | --- |
| `body`（global.css:36）未设行高 | `html { line-height: 1.5 }` 使全站文字块变高，所有页面高度变化 |
| `.set-panel h4`、`.proj-card h4`、`.grp-card h4`、`.grp-head h2`、`.dev-head h2`、`.detail h3`、`.placeholder h3`、`.modal h3`（都只设了字号与外边距） | 标题字重变成继承，失去加粗 |
| 没有显式字号的 `<small>`（Layout 89/107/131/169 行，Control 102/113/127，FreshAir 119/139–144，Groups 40/47，Home 68/113–123 中未被 CSS 覆盖者需逐个核对） | `smaller`（约 83%）变 80% |
| `.field input`、`.dp-search input`、`.row.input input`、`.filters .search-in input`（未设占位符颜色；只有 `.search input::placeholder` 设了） | 占位符由浏览器默认灰变成半透明当前色 |
| `.checkbox`（Login、Control）、`.temp-box input[type=range]` | 原生外边距被清零，位置偏移 3–4px |
| `.field input`、`.search input` 等无 padding 声明的 input | 原生 `1px 2px` 内边距清零，文字左移 2px |
| `.pager button`、`.stepper button`、`.temp-box .round`、`.opt-btn`、`.mode`、`.btn-send`、`.btn-login`、`.field .eye`（未声明 padding 或字重） | `padding: 0`、`font: inherit` 改变字重与行高继承 |
| Home 天气图标 SVG、FreshAir `Ring` SVG、Avatar SVG | `svg { display: block }` 去掉行内基线空隙 |

**C. shadcn 默认样式与恒境云数值不符（S2、S3 逐个改）**

| 组件 | 默认 | 应为 |
| --- | --- | --- |
| Button | `h-9 px-4 text-sm rounded-md`，focus-visible 3px ring | 36px、`0 16px`、13.5px、500、8px；primary 常驻 3px 外发光，需与焦点环区分 |
| Input | `h-9 px-3 shadow-xs`，`md:text-sm` | 36px、`0 12px`、无阴影；focus 为 `--primary-2` 边 + `rgba(6,182,212,.12)` 3px |
| Card | `rounded-xl py-6 gap-6 shadow-sm`，边框 `--border` | 14px、`20px 22px`、`--shadow`、边框 `#e9eef4` |
| Badge | `rounded-full px-2 py-0.5 text-xs`，带 border | 6px、高 22、11.5px、无边框 |
| Switch | 32×18 左右，开为 `--primary` | 40×22，开为 `--primary-2`，滑块带阴影 |
| Table | 行 `border-b`、`hover:bg-muted/50`、单元格 `p-2` | 行上边框 `--line-2`、hover `#fafcfe`、见 S2 表 |
| Select 触发器 | `h-9`，lucide 下箭头，`justify-between` | 36px、右侧 11px 处 10×6 箭头（现为内嵌 SVG 背景），文字色 `--text-2` |
| Sonner | 右下角、自带配色 | 顶部居中、距顶 72px、白底、`--line` 边、10px 圆角 |

另：`rem` 基准是 `html` 的 16px（`body` 的 14px 不影响），Tailwind 间距与 `text-sm`（14px）按 16px 计；恒境云大量使用 13.5px、12.5px、11.5px，统一写任意值 `text-[13.5px]`，不要就近取整到 `text-sm`。

## 6. 工作量汇总与待确认

S1 0.5–1 天、S2 1.5–2 天、S3 1.5–2 天，合计 3.5–5 天，依次依赖（S0 → S1 → S2 → S3），拆分方式见各段。高于 plan-v1 的 2.5 天，差额来自「零差异」门槛下的逐页对照，以及 S3 需先补录弹层基线。

**需负责人确认**：① 经销商选择是否合并为单个可搜索下拉（改变 Groups 管理员视图外观）；② 写操作确认弹窗改为点遮罩不关闭；③ DatePicker、Sheet、Dialog、DropdownMenu 当前无使用点，是否后移到首次需要的段落。

## 负责人确认（11/24 09:58）
1. 经销商选择改为可搜索下拉——同意，放到后续改界面阶段，不进 S1–S3。
2. 确认弹窗点遮罩不关闭，必须点「取消」——同意。
3. 暂无使用点的组件（Sheet、DatePicker、Dialog、DropdownMenu 等）用到再加——同意。
