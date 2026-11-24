import * as React from 'react'
import { cn } from '@/lib/utils'

/*
 * 卡片（原 legacy.tsx 的 Card 与 global.css 的 .card / .card-pad / .card-head / .card-title / .card-sub）。
 * 去掉 shadcn 默认的 flex 列布局、py-6、gap-6；数值照旧：14px 圆角、1px #e9eef4 边、--shadow、内边距 20px 22px。
 * 页面里 .kpi / .stat / .room / .grp-card 等未分层规则会覆盖这里的内边距与边框，与旧写法的覆盖关系一致。
 */
function Card({ className, pad = true, ...props }: React.ComponentProps<'div'> & { pad?: boolean }) {
  return (
    <div
      data-slot="card"
      className={cn('rounded-xl border border-card-border bg-card shadow-card', pad && 'px-[22px] py-5', className)}
      {...props}
    />
  )
}

/** 卡片头：标题区与右侧操作并排；pad 用于无内边距卡片里单独给头部加内边距（原 .card-head.card-pad） */
function CardHeader({ className, pad = false, ...props }: React.ComponentProps<'div'> & { pad?: boolean }) {
  return (
    <div
      data-slot="card-header"
      className={cn('mb-4 flex items-start justify-between gap-3', pad && 'px-[22px] py-5', className)}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return <h3 data-slot="card-title" className={cn('m-0 flex items-center gap-2 text-[15.5px] font-bold', className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-description" className={cn('mt-1 text-[12px] text-muted-foreground', className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription }
