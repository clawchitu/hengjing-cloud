import * as React from 'react'
import { cn } from '@/lib/utils'

/*
 * 表格（原 global.css 的 .table）。去掉 shadcn 默认的 h-10、p-2、行 border-b、hover:bg-muted/50；
 * 数值照旧：表体 13.5px；表头 #f8fafc 底、--muted 字、12.5px/500、10px 12px；单元格 9.5px 12px + --line-2 上边框；
 * 首末列 22px。
 * 不要 shadcn 自带的横向滚动包裹 div：旧版表格超宽时向外溢出，不出内部滚动条。
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <table data-slot="table" className={cn('w-full border-collapse text-[13.5px]', className)} {...props} />
  )
}

function TableHeader(props: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" {...props} />
}

// 行悬停色写在 global.css（tbody[data-slot="table-body"] > tr:hover > td），未分层、权重与旧 .table 规则相同。
function TableBody(props: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" {...props} />
}

function TableRow(props: React.ComponentProps<'tr'>) {
  return <tr data-slot="table-row" {...props} />
}

const edge = 'px-3 first:pl-[22px] last:pr-[22px] whitespace-nowrap'

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(edge, 'bg-[#f8fafc] py-2.5 text-left text-[12.5px] font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn(edge, 'border-t border-line-2 py-[9.5px]', className)} {...props} />
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
