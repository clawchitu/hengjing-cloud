import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { cn } from '@/lib/utils'

/*
 * 命令列表（cmdk）：只用它的键盘行为（上下键、Home/End 移动高亮，回车选中，role=listbox/option），
 * 外观由使用方给类名。用在项目切换菜单与顶栏项目搜索，两处都由页面自己过滤（shouldFilter={false}）。
 *
 * 高亮只跟键盘走：
 * - cmdk 在值为空时会自动高亮第一项，而旧版下拉打开时没有任何高亮。所以这里的 value 必须受控，''表示“没有高亮”，
 *   传给 cmdk 时换成一个不对应任何选项的值。此时按下键高亮第一项、回车不选任何项；
 * - 鼠标悬停只是 CSS :hover（同旧版），不改高亮（disablePointerSelection）；鼠标一移动就清掉键盘高亮，
 *   避免同时出现两个灰底。只看真实移动（movementX/Y），浏览器滚动后补发的合成移动不算。
 */
const NO_ITEM = '__none__'

function Command({
  className,
  value,
  onValueChange,
  onPointerMove,
  ...props
}: Omit<React.ComponentProps<typeof CommandPrimitive>, 'value' | 'onValueChange' | 'defaultValue'> & { value: string; onValueChange: (value: string) => void }) {
  return (
    <CommandPrimitive
      data-slot="command"
      disablePointerSelection
      value={value || NO_ITEM}
      onValueChange={(v) => onValueChange(v === NO_ITEM ? '' : v)}
      onPointerMove={(e) => {
        onPointerMove?.(e)
        if ((e.movementX || e.movementY) && value) onValueChange('')
      }}
      className={cn('outline-none', className)}
      {...props}
    />
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List data-slot="command-list" className={cn('outline-none', className)} {...props} />
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" {...props} />
}

/* 选项：8px 10px、两端对齐；键盘高亮为 --bg 底（同旧版悬停色），悬停色由使用方按“是否当前项”给 */
function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn('flex cursor-pointer items-center justify-between px-2.5 py-2 outline-none data-[selected=true]:bg-background', className)}
      {...props}
    />
  )
}

export { Command, CommandEmpty, CommandItem, CommandList }
