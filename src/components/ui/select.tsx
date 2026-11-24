import * as React from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCheck, faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons'
import { cn } from '@/lib/utils'

/*
 * 下拉选择（原生 <select class="select">）。触发器照旧，下拉面板是新外观。
 *
 * 触发器按 Chromium 对 appearance:none 的 <select> 的排版复刻（html.css + menu_list_inner_element.cc）：
 * - 36px 高、1px --line 描边、8px 圆角、0 30px 0 12px、白底，右侧 11px 处 10×6 箭头（与旧 .select 同一张内嵌 SVG 背景图）；
 * - 文字色 --text-2、字重 400（原生控件不继承字重）、white-space: pre、内容垂直居中；
 * - 原生下拉框内部文字的行高是首选字体的 ascent + descent 取整（不是 line-height: normal，后者会被中文回退字体撑高），
 *   恒境云首选字体 Barlow 的 ascent/descent 为 1.0em / 0.2em，14px 下取整为 14 + 3 = 17px；
 * - 原生按取整后的 ascent/descent（14 + 3 = 17）算半行距，基线正好在行顶下 14px；Tailwind 的 17px 行高按小数 metrics
 *   （14 + 2.8）算，基线多出约 0.1px，在小数纵坐标上会被取整到下一像素（温控统计、项目列表的区域下拉曾因此下移 1px）。
 *   所以文字块上移 6/64px（LayoutUnit 精度）抵掉这段半行距；文字块同原生用 overflow: hidden；
 * - 原生 select 的默认宽度 = 最长选项文字宽度向上取整 + 内边距。不定宽的使用点传 `sizer`（全部选项文字），
 *   触发器下面叠一个不可见的原生 select 撑出同样的宽度，保证逐像素一致。
 * 焦点：旧 .select 只有 outline: none，没有焦点样式，这里照旧。
 */
function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

const arrow =
  "bg-white bg-no-repeat bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2710%27%20height=%276%27%3E%3Cpath%20d=%27M1%201l4%204%204-4%27%20stroke=%27%2364748b%27%20fill=%27none%27%20stroke-width=%271.4%27/%3E%3C/svg%3E)] bg-position-[right_11px_center]"
const box = 'h-9 rounded-md border border-border pr-[30px] pl-3 font-normal text-text-2 outline-none'

function SelectTrigger({
  className,
  placeholder,
  sizer,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { placeholder?: string; sizer?: string[] }) {
  const trigger = (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(box, arrow, 'inline-flex cursor-default items-center text-left whitespace-pre', sizer && 'col-start-1 row-start-1 w-full', className)}
      {...props}
    >
      <SelectPrimitive.Value
        data-slot="select-value"
        placeholder={placeholder}
        className="relative -top-[0.09375px] min-w-0 grow overflow-hidden leading-[17px]"
      />
    </SelectPrimitive.Trigger>
  )
  if (!sizer) return trigger
  return (
    <span data-slot="select-sizer" className="inline-grid">
      <select aria-hidden tabIndex={-1} inert className={cn(box, 'invisible col-start-1 row-start-1 appearance-none', className)}>
        {sizer.map((s) => <option key={s}>{s}</option>)}
      </select>
      {trigger}
    </span>
  )
}

/* 下拉面板：白底、1px --line 边、10px 圆角、--shadow-pop，6px 内边距；宽度不小于触发器。z-50 走 Portal，脱离侧栏与顶栏的层叠上下文 */
function SelectContent({ className, children, position = 'popper', ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={6}
        className={cn(
          'relative z-50 max-h-[min(320px,var(--radix-select-content-available-height))] min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-pop',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center text-[10px] text-faint">
          <FontAwesomeIcon icon={faChevronUp} />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center text-[10px] text-faint">
          <FontAwesomeIcon icon={faChevronDown} />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

/* 选项：同项目切换菜单的 .opt（8px 10px、7px 圆角、13px），高亮 --bg 底，当前项 --primary-soft 底、--primary 字、600 */
function SelectItem({ className, children, value, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      data-value={value}
      value={value}
      className={cn(
        'relative flex cursor-default items-center justify-between gap-3 rounded-[7px] px-2.5 py-2 text-[13px] text-foreground outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:text-faint data-[highlighted]:bg-background data-[state=checked]:bg-primary-soft data-[state=checked]:font-semibold data-[state=checked]:text-primary',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="text-[11px]">
        <FontAwesomeIcon icon={faCheck} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export { Select, SelectContent, SelectItem, SelectTrigger }
