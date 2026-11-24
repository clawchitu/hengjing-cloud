import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/*
 * 输入框（原 global.css 的 .input / .input:focus）：36px 高、0 12px、8px 圆角、1px --line 描边、白底、无阴影；
 * 焦点为 --primary-2 边 + rgba(6,182,212,.12) 3px 外圈。目前页面上都是带图标的包裹式输入框，用 InputGroup。
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 rounded-md border border-border bg-white px-3 font-normal leading-[normal] outline-none focus:border-primary-2 focus:shadow-[0_0_0_3px_rgba(6,182,212,.12)]',
        className,
      )}
      {...props}
    />
  )
}

/*
 * 带图标的输入框：外层画边框，内层 input 无边框。三种外观对应三处旧写法：
 * - default：页面里的 `.row.input`（统一控制、集成项目的项目检索）。旧 .input:focus 落在外层 div 上永远不生效，所以这里也没有焦点样式；
 * - field：登录页的 `.field`（44px、#f8fafc 底，聚焦时 --primary-2 边、白底）；
 * - search：顶栏项目搜索（34px、--bg 底、无边框、13px）。
 * 图标与文字颜色是 --faint；输入的文字颜色各处不同，由使用方给 InputGroupInput。
 */
const inputGroupVariants = cva('flex items-center text-faint', {
  variants: {
    variant: {
      default: 'h-9 gap-2 rounded-md border border-border bg-white px-3',
      field: 'h-11 gap-3 rounded-md border border-[#e2e8f0] bg-[#f8fafc] px-[14px] focus-within:border-primary-2 focus-within:bg-white',
      search: 'h-[34px] gap-2 rounded-md bg-background px-3 text-[13px]',
    },
  },
  defaultVariants: { variant: 'default' },
})

function InputGroup({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof inputGroupVariants>) {
  return <div data-slot="input-group" data-variant={variant ?? 'default'} className={cn(inputGroupVariants({ variant }), className)} {...props} />
}

/*
 * 包裹式输入框里的 input。旧写法是裸 <input>，只清掉了边框和 outline，其余沿用浏览器默认：
 * [data-slot] 的小型重置会把内边距清零、把字体改成继承，这里用 padding: revert 退回浏览器默认内边距，
 * 行高 / 字重 / 字距钉回浏览器默认（normal / 400 / normal），保证文字位置不动。
 */
function InputGroupInput({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      data-slot="input-group-input"
      className={cn('flex-1 bg-transparent p-[revert] font-normal leading-[normal] tracking-[normal] outline-none', className)}
      {...props}
    />
  )
}

export { Input, InputGroup, InputGroupInput }
