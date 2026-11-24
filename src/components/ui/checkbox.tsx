import * as React from 'react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 复选框（原 global.css 的 .checkbox：原生 15×15、accent-color: --primary）。
 * 外观按 Chromium 原生复选框的绘制参数自绘（ui/native_theme/native_theme_base.cc 的 PaintCheckbox）：
 * - 外边距 3px 3px 3px 4px（原生 UA 样式，[data-slot] 重置会清零，这里补回）；
 * - 圆角 2px；未选中：白底（内缩 0.2px）+ 1px #767676 描边（内缩 0.5px）；悬停时描边变深为 #4f4f4f；
 * - 选中：整格 accent 色（--primary），白色对勾 M3 7.5 l3 3 L12 3、线宽 2.4（= 高 × 0.16）；
 *   悬停时 accent 亮度 -0.11（HSL），#0891b2 → #06657c；
 * - 禁用：底色先叠 #a9a9a9 20%，再叠白 60%，描边 #767676 30%；选中且禁用时底色同禁用描边色、对勾为白 60%；禁用时不响应悬停。
 * 颜色经 CSS 变量传给 SVG，状态全在根元素上切换（原生选中态不画描边，选中时隐藏描边）。
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'group/checkbox relative m-[3px_3px_3px_4px] size-[15px] cursor-pointer',
        '[--cb-accent:var(--primary)] [--cb-bg:#fff] [--cb-border:#767676] [--cb-check:#fff]',
        'hover:not-data-[disabled]:[--cb-accent:#06657c] hover:not-data-[disabled]:[--cb-border:#4f4f4f]',
        'data-[disabled]:[--cb-accent:#7676764d] data-[disabled]:[--cb-bg:#ffffff99] data-[disabled]:[--cb-border:#7676764d] data-[disabled]:[--cb-check:#ffffff99]',
        className,
      )}
      {...props}
    >
      <svg aria-hidden viewBox="0 0 15 15" className="absolute inset-0 size-[15px]">
        {props.disabled && <rect x=".2" y=".2" width="14.6" height="14.6" rx="2" fill="#a9a9a933" />}
        <rect data-part="bg" x=".2" y=".2" width="14.6" height="14.6" rx="2" className="fill-(--cb-bg)" />
        <rect data-part="border" x=".5" y=".5" width="14" height="14" rx="2" strokeWidth="1" className="fill-none stroke-(--cb-border) group-data-[state=checked]/checkbox:hidden" />
      </svg>
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="absolute inset-0">
        <svg aria-hidden viewBox="0 0 15 15" className="absolute inset-0 size-[15px]">
          <rect data-part="accent" width="15" height="15" rx="2" className="fill-(--cb-accent)" />
          <path data-part="check" d="M3 7.5l3 3L12 3" strokeWidth="2.4" className="fill-none stroke-(--cb-check)" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
