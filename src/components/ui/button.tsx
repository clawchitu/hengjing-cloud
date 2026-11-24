import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/*
 * 按钮（原 global.css 的 .btn / .btn.primary / .btn.ghost-primary / .btn.lg / .btn.block / .link）。
 * 数值照旧：36px 高、0 16px、8px 圆角、13.5px/500、1px --line 描边。
 * primary 的 3px 外发光是常驻样式，不是焦点环；焦点环沿用浏览器默认（旧 .btn 也没有自定义 focus 样式）。
 * link 是行内文字按钮：不设 display，保持 inline-block，文字与图标之间的空格照常渲染。
 */
const box =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border text-[13.5px] font-medium [transition:all_.15s] disabled:cursor-not-allowed disabled:opacity-50'

const buttonVariants = cva('', {
  variants: {
    variant: {
      default: `${box} border-border bg-white text-text-2 hover:border-[#cbd5e1] hover:bg-[#f8fafc]`,
      primary: `${box} border-primary bg-primary text-white shadow-[0_0_0_3px_rgba(8,145,178,.18)] hover:bg-[#0e7490]`,
      soft: `${box} border-transparent bg-primary-soft text-primary`,
      link: 'font-medium text-primary',
    },
    size: {
      default: 'h-9 px-4',
      lg: 'h-[42px] px-4 text-[14.5px]',
      none: '',
    },
    block: { true: 'w-full' },
  },
  defaultVariants: { variant: 'default' },
})

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>

function Button({ className, variant = 'default', size, block, ...props }: ButtonProps) {
  const sz = size ?? (variant === 'link' ? 'none' : 'default')
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={sz}
      className={cn(buttonVariants({ variant, size: sz, block }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
