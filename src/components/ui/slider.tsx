import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 滑块（原 Control 温度设定的原生 <input type="range">，accent-color: var(--primary)）。
 * 行为用 Radix Slider（role=slider、aria-valuenow、方向键 / Home / End、拖动），外观逐像素复刻 Chromium 原生滑块：
 * 在与 CI 同镜像的 Chromium 里，与原生控件的默认、悬停轨道、悬停滑钮、按下、键盘焦点五种状态逐像素比对一致。
 *
 * 原生的绘制（Chromium NativeThemeBase::PaintSliderTrack / PaintSliderThumb）：
 * - 控件盒 16px 高；轨道 8px 高、圆角 4px，左右各内缩 1px，底色 #efefef；
 * - 已填充段从轨道左端画到「滑钮中心 + 4px」，颜色 = accent；
 * - 轨道描边 1px，颜色为 #767676 的 50% 透明（压在填充段上显得更深）；
 * - 滑钮直径 15px 的圆，圆心在控件盒内 8 + (宽 − 16) × 比例 处（即两端各留 8px 行程余量）；
 * - 悬停：填充 / 描边 / 底色变深（#06657c / #4f4f4f 50% / #e5e5e5），指针在滑钮上时滑钮也变深；
 *   按下：变浅（#0abde8 / #8d8d8d 50% / #f5f5f5）；这几个颜色是 Chromium 由 accent #0891b2 推出来的，写死；
 * - 键盘焦点：控件盒外圈 outline: auto（画在滑钮之上）。
 *
 * 结构：外层 span 是“控件盒”（使用方给宽度和外边距，同原生 input 的盒子）；Radix Root 在盒内左右各缩 8px，正好是滑钮圆心的行程，
 * 这样 Radix 由指针位置换算数值时与原生一致（滑钮中心跟着指针走），滑钮元素本身宽 0（Radix 不再做“留在边界内”的偏移），
 * 圆用 ::before 画、::after 做 16×16 的命中区。轨道、填充、描边都相对 Root 用整数像素反向外扩，和原生同样按像素取整。
 *
 * 焦点外圈：Radix 指针按下时用 focus({ focusVisible: false }) 聚焦滑钮，键盘改值时用 focusVisible: true，
 * Chromium 159 支持这个选项，所以鼠标点击不会命中 :focus-visible（同原生），不需要 tabs.tsx 那套 data-pointer-focus 标记。
 * | 操作                               | 外圈 |
 * | 鼠标 / 触屏按下拖动（之前用没用过键盘都一样） | 无   |
 * | 鼠标点过之后按任意非修饰键（data-keyboard，失焦清除） | 有   |
 * | 有外圈时再用鼠标点 / 拖              | 有（不变，同原生）|
 * | Tab 进入                           | 有   |
 *
 * 键盘步长与原生一致（Radix 默认 PageUp/PageDown、Shift+方向键是 10 步）：PageUp/PageDown 为 max(step, 量程/10)，
 * 结果按步长取整；Shift+方向键仍是 1 步。
 */
type SliderProps = Omit<React.ComponentProps<typeof SliderPrimitive.Root>, 'value' | 'defaultValue' | 'onValueChange'> & {
  value: number[]
  onValueChange: (value: number[]) => void
  /** 滑钮的可访问名称 */
  'aria-label'?: string
}

const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta']
const STEP_KEYS = ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

function Slider({ className, style, value, onValueChange, min = 0, max = 100, step = 1, disabled, onKeyDown, 'aria-label': label, ...props }: SliderProps) {
  // 键盘接管：鼠标聚焦后再按键，Chromium 不会让已聚焦的元素改为命中 :focus-visible（原生 range 会出外圈），这里补一个标记，失焦清除
  const [keyboard, setKeyboard] = React.useState(false)
  const v = value[0] ?? min
  const f = max > min ? (Math.min(max, Math.max(min, v)) - min) / (max - min) : 0
  const decimals = (String(step).split('.')[1] ?? '').length
  const snap = (n: number) => Math.min(max, Math.max(min, +(Math.round((n - min) / step) * step + min).toFixed(decimals)))
  return (
    <span
      data-slot="slider"
      data-disabled={disabled ? '' : undefined}
      className={cn(
        'group/slider relative inline-block h-4 touch-none select-none align-baseline',
        // 颜色变量：默认 / 悬停 / 按下（见上）
        '[--sl-fill:var(--primary)] [--sl-thumb:var(--primary)] [--sl-track:#efefef] [--sl-border:rgba(118,118,118,.5)]',
        'hover:[--sl-fill:#06657c] hover:[--sl-track:#e5e5e5] hover:[--sl-border:rgba(79,79,79,.5)]',
        // 指针在滑钮上时滑钮变深；按下时一律变浅（按下且悬停在滑钮上的规则权重更高，压过悬停）
        'has-[[data-slot=slider-thumb]:hover]:[--sl-thumb:#06657c]',
        'active:[--sl-fill:#0abde8] active:[--sl-thumb:#0abde8] active:[--sl-track:#f5f5f5] active:[--sl-border:rgba(141,141,141,.5)]',
        'active:has-[[data-slot=slider-thumb]:hover]:[--sl-thumb:#0abde8]',
        // 键盘焦点外圈：画在 ::after（z-index 1，盖在滑钮之上，同原生）
        "after:pointer-events-none after:absolute after:inset-0 after:z-[1] after:content-['']",
        'has-[[data-slot=slider-thumb]:focus-visible]:after:[outline:auto_1px_-webkit-focus-ring-color]',
        'has-[[data-slot=slider-thumb][data-keyboard]:focus]:after:[outline:auto_1px_-webkit-focus-ring-color]',
        className,
      )}
      style={style}
    >
      <SliderPrimitive.Root
        data-slot="slider-root"
        // ::before 把命中区补回整个控件盒（左右 8px 的行程余量处按下也能拖动，同原生）
        className="absolute inset-y-0 left-2 right-2 before:absolute before:-inset-x-2 before:inset-y-0 before:content-['']"
        value={value}
        onValueChange={onValueChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (e.defaultPrevented || disabled || !STEP_KEYS.includes(e.key)) return
          const page = e.key === 'PageUp' || e.key === 'PageDown'
          if (!page && !e.shiftKey) return // 普通方向键交给 Radix
          const up = e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'ArrowRight'
          const delta = page ? Math.max(step, (max - min) / 10) : step
          e.preventDefault() // Radix 看到 defaultPrevented 就不再处理
          const next = snap(v + (up ? delta : -delta))
          if (next !== v) onValueChange([next])
        }}
        {...props}
      >
        <SliderPrimitive.Track data-slot="slider-track" className="absolute -inset-x-[7px] top-1 h-2 rounded-[4px] bg-[var(--sl-track)]" />
        <span data-slot="slider-range" className="absolute -left-[7px] top-1 h-2 rounded-[4px] bg-[var(--sl-fill)]" style={{ width: `calc(${f * 100}% + 11px)` }} />
        <span data-slot="slider-border" className="absolute -inset-x-[7px] top-1 h-2 rounded-[4px] border border-solid border-[var(--sl-border)]" />
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          aria-label={label}
          className={cn(
            'block h-4 w-0 outline-none',
            "before:absolute before:-left-2 before:top-0 before:h-[15px] before:w-[15px] before:translate-[.5px] before:rounded-full before:bg-[var(--sl-thumb)] before:content-['']",
            "after:absolute after:-left-2 after:top-0 after:size-4 after:content-['']",
          )}
          data-keyboard={keyboard ? '' : undefined}
          onKeyDown={(e) => { if (!MODIFIER_KEYS.includes(e.key)) setKeyboard(true) }}
          onBlur={() => setKeyboard(false)}
        />
      </SliderPrimitive.Root>
    </span>
  )
}

export { Slider }
