import * as React from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 弹出层：Radix Popover 的行为（Esc 关闭、点外部关闭、关闭后焦点回到触发器、碰撞避让），外观由使用方给类名。
 * 恒境云只用非模态（modal=false，Radix 默认）：不锁页面滚动、不对读屏隐藏页面其余部分，与旧的手写下拉一致。
 * Content 走 Portal 挂到 body、z-50，脱离侧栏（z-index 20）与顶栏（10）的层叠上下文；没有入场动画（旧版也没有）。
 */
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn('z-50 bg-popover text-popover-foreground outline-none', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
