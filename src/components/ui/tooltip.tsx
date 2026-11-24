import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 文字提示（替换原生 title=）。Radix Tooltip：指针悬停延时出现、键盘聚焦立即出现、Esc / 指针离开 / 失焦关闭，
 * 触发器带 aria-describedby 指向提示内容。外观：白底、1px --line 描边、圆角 8、--shadow-pop、12px、--text-2，无箭头。
 * 每个 Tooltip 自带 Provider（同 shadcn 新版写法），不用改 main.tsx。延时 500ms，接近原生 title 的出现时间。
 * 内容走 Portal、z-50，脱离侧栏 / 顶栏的层叠上下文。
 */
function Tooltip({ delayDuration = 500, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root> & { delayDuration?: number }) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipPrimitive.Provider>
  )
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn('z-50 rounded-md border border-solid border-border bg-white px-[10px] py-[6px] text-[12px] text-text-2 shadow-pop', className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipTrigger }
