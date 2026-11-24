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

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn('text-left', className)} {...props} />
}

function TabsContent(props: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
