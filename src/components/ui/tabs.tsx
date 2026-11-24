import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 标签页：只用 Radix 的行为（role=tablist/tab/tabpanel、左右方向键切换、Home/End），外观由使用方给类名
 * （新风页的设备切换沿用 pages.css 的 .dev-tabs / .dev-tab）。shadcn 默认的 flex 列、gap、底色、高度全部去掉。
 * 触发器是 <button>：浏览器默认 text-align: center，这里改回 left，保证旧 <div> 触发器里的多行文字位置不变。
 */
function Tabs(props: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />
}

function TabsList(props: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" {...props} />
}

/*
 * 设备切换等标签的键盘焦点外圈：使用方写 `focus-visible:not-data-[pointer-focus]:…`。
 * 为什么要 data-pointer-focus：Radix 在 mousedown 里用脚本 focus() 聚焦触发器，Chromium 把脚本聚焦算作 :focus-visible，
 * 所以鼠标点一下也会命中 :focus-visible。这里只给“由这次指针按下直接造成的那一次聚焦”打标记。
 *
 * 期望（T = 被操作的标签；“Tab 回来”= 焦点先移到别处，再按 Tab 回到 T；“方向键”= 紧接着按左右键移到相邻标签 N）
 * | 操作                          | T 原状态        | 操作后 T 的外圈        | Tab 回来 | 方向键（N） |
 * | 鼠标左键                      | 未聚焦          | 无（T 聚焦、打标记）   | 有       | 有          |
 * | 鼠标左键                      | 已聚焦·无外圈   | 无（不变）             | 有       | 有          |
 * | 鼠标左键                      | 已聚焦·有外圈   | 有（不变，同原生按钮） | 有       | 有          |
 * | 鼠标右键 / Ctrl+左键          | 未聚焦          | 不聚焦（Radix 阻止）   | 有       | —           |
 * | 鼠标右键 / Ctrl+左键          | 已聚焦          | 不变                   | 有       | 有          |
 * | 触屏点按                      | 未聚焦          | 无（T 聚焦、打标记）   | 有       | 有          |
 * | 触屏点按                      | 已聚焦          | 不变                   | 有       | 有          |
 * | 触屏按下后取消（滚动等）      | 任意            | 不变                   | 有       | 有          |
 * | 键盘 Tab 进入 / 方向键移入    | 未聚焦          | 有                     | 有       | 有          |
 * | 脚本 focus()                  | 未聚焦          | 与 :focus-visible 一致 | 有       | 有          |
 * | 已聚焦时按非修饰键（含 Esc）  | 已聚焦·无外圈   | 有（键盘接管）         | 有       | 有          |
 * | 已聚焦时单按 Shift/Ctrl/Alt/Meta | 已聚焦·无外圈 | 无（不变）             | 有       | 有          |
 *
 * 最小状态：pending（瞬时，ref）只表示“指针刚在未聚焦的 T 上按下、聚焦马上要发生”。
 * - pointerdown：左键无 Ctrl（与 Radix 自己聚焦的条件一致）且 T 不是当前焦点时置 pending，否则清掉；
 * - focus：data-pointer-focus = pending，随即清 pending；blur：清属性、清 pending；
 *   keydown：清属性（键盘接管）。单按 Shift / Ctrl / Alt / Meta 不算（Ctrl+点击会先按下 Ctrl）；
 * - 鼠标 pointerup：一律清 pending（鼠标聚焦发生在 mousedown，早于 pointerup）；
 * - 触屏：聚焦发生在 pointerup 之后的兼容 mousedown 里，pending 活到下一次 focus / blur / pointercancel / click 为止。
 * 因此 pending 不会跨过一次失焦存活，“Tab 回来”永远按键盘聚焦处理。
 * 已知边界：若触屏点按既不产生兼容 mousedown/click、也没有 pointercancel（只在有人对 touchstart 调 preventDefault 时出现，
 * 本项目没有），pending 会留到下一次聚焦，那一次会被当成指针聚焦。
 */
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta']

function TabsTrigger({ className, onPointerDown, onPointerUp, onPointerCancel, onClick, onFocus, onBlur, onKeyDown, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const pending = React.useRef(false)
  const [pointerFocus, setPointerFocus] = React.useState(false)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-pointer-focus={pointerFocus ? '' : undefined}
      className={cn('text-left', className)}
      onPointerDown={(e) => {
        pending.current = e.button === 0 && !e.ctrlKey && document.activeElement !== e.currentTarget
        onPointerDown?.(e)
      }}
      onPointerUp={(e) => { if (e.pointerType === 'mouse') pending.current = false; onPointerUp?.(e) }}
      onPointerCancel={(e) => { pending.current = false; onPointerCancel?.(e) }}
      onClick={(e) => { pending.current = false; onClick?.(e) }}
      onFocus={(e) => { setPointerFocus(pending.current); pending.current = false; onFocus?.(e) }}
      onBlur={(e) => { setPointerFocus(false); pending.current = false; onBlur?.(e) }}
      onKeyDown={(e) => { if (!MODIFIER_KEYS.includes(e.key)) setPointerFocus(false); onKeyDown?.(e) }}
      {...props}
    />
  )
}

function TabsContent(props: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
