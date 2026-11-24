import * as React from 'react'
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 确认弹窗（原 global.css 的 .mask + .modal）。Radix AlertDialog 的行为：模态、焦点圈在弹窗内、Esc 关闭、
 * 锁页面滚动、对读屏隐藏页面其余部分；点遮罩不关闭（AlertDialog 固有行为，旧版点遮罩可关，负责人 11/24 确认改为必须点「取消」）。
 * 数值照旧：遮罩 rgba(15,23,42,.45)、居中；面板宽 440、圆角 16、阴影 --shadow-modal、内边距 22px 24px；
 * 入场动画照旧（遮罩 fade .15s、面板 pop .18s，keyframes 在 global.css），没有退场动画（旧版直接卸载；
 * 动画名关闭前后不变，Radix Presence 因此立即卸载）。
 * 面板放在遮罩里面（Radix 支持的写法），用遮罩的 grid 居中，与旧版 DOM 结构一致。z-50 同其他弹层（plan 第 3 节）。
 */
function AlertDialog(props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 z-50 grid place-items-center bg-[rgba(15,23,42,.45)] animate-[fade_.15s]"
      >
        <AlertDialogPrimitive.Content
          data-slot="alert-dialog-content"
          className={cn('w-[440px] rounded-2xl bg-white px-6 py-[22px] shadow-modal outline-none animate-[pop_.18s]', className)}
          {...props}
        />
      </AlertDialogPrimitive.Overlay>
    </AlertDialogPrimitive.Portal>
  )
}

/** 标题：渲染成 h3（同旧版的标题层级），17px 粗体、图标与文字间距 10px */
function AlertDialogTitle({ className, children, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title data-slot="alert-dialog-title" asChild {...props}>
      <h3 className={cn('mb-[6px] flex items-center gap-[10px] text-[17px] font-bold', className)}>{children}</h3>
    </AlertDialogPrimitive.Title>
  )
}

/** 正文：渲染成 div（正文里有 .kv 列表等块级内容，不能放进 Radix 默认的 <p>） */
function AlertDialogDescription({ className, children, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description data-slot="alert-dialog-description" asChild {...props}>
      <div className={cn('mt-[10px] mb-5 text-[13.5px] leading-[1.7] text-text-2', className)}>{children}</div>
    </AlertDialogPrimitive.Description>
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-footer" className={cn('flex justify-end gap-[10px]', className)} {...props} />
}

function AlertDialogAction(props: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return <AlertDialogPrimitive.Action data-slot="alert-dialog-action" {...props} />
}

function AlertDialogCancel(props: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" {...props} />
}

export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle }
