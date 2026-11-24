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
 * 这里记下“这次聚焦来自指针”（data-pointer-focus），按键或失焦后清掉；使用方的焦点样式写成
 * `focus-visible:not-data-[pointer-focus]:…`，鼠标点击不出现，Tab / 方向键进入时出现。
 */
function TabsTrigger({ className, onPointerDown, onKeyDown, onBlur, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const [pointer, setPointer] = React.useState(false)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-pointer-focus={pointer ? '' : undefined}
      className={cn('text-left', className)}
      onPointerDown={(e) => { setPointer(true); onPointerDown?.(e) }}
      onKeyDown={(e) => { setPointer(false); onKeyDown?.(e) }}
      onBlur={(e) => { setPointer(false); onBlur?.(e) }}
      {...props}
    />
  )
}

function TabsContent(props: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
