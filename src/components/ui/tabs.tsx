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
 * Radix 在 mousedown 里用脚本 focus() 聚焦触发器，Chromium 因此把鼠标点击也当成 :focus-visible。
 * 这里只标记“这一次聚焦来自指针”：pointerdown（左键、无 Ctrl，与 Radix 自己聚焦的条件一致）记一个瞬时标志，
 * 紧接着的 focus 读走标志并设 data-pointer-focus；blur、按键时清掉属性。瞬时标志在 focus 时消费，
 * 鼠标松开时若没拿到焦点、或指针被取消（触屏滚动等）也清掉，不会遗留到之后的键盘或脚本聚焦。
 * 使用方把焦点样式写成 `focus-visible:not-data-[pointer-focus]:…`：鼠标点击不出现，Tab / 方向键 / 脚本聚焦照常出现。
 */
function TabsTrigger({ className, onPointerDown, onPointerUp, onPointerCancel, onFocus, onBlur, onKeyDown, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const pending = React.useRef(false)
  const [pointerFocus, setPointerFocus] = React.useState(false)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-pointer-focus={pointerFocus ? '' : undefined}
      className={cn('text-left', className)}
      onPointerDown={(e) => { pending.current = e.button === 0 && !e.ctrlKey; onPointerDown?.(e) }}
      onPointerUp={(e) => {
        // 触屏点按的 mousedown / focus 在 pointerup 之后才来，只对鼠标做“没聚焦就清掉”
        if (e.pointerType === 'mouse' && document.activeElement !== e.currentTarget) pending.current = false
        onPointerUp?.(e)
      }}
      onPointerCancel={(e) => { pending.current = false; onPointerCancel?.(e) }}
      onFocus={(e) => { setPointerFocus(pending.current); pending.current = false; onFocus?.(e) }}
      onBlur={(e) => { setPointerFocus(false); onBlur?.(e) }}
      onKeyDown={(e) => { setPointerFocus(false); onKeyDown?.(e) }}
      {...props}
    />
  )
}

function TabsContent(props: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
