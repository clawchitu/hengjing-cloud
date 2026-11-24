import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 文字提示（替换原生 title=）。Radix Tooltip：指针悬停延时出现、键盘聚焦立即出现、Esc / 指针离开 / 失焦关闭，
 * 触发器带 aria-describedby 指向提示内容。外观：白底、1px --line 描边、圆角 8、--shadow-pop、12px、--text-2，无箭头。
 * 每个 Tooltip 自带 Provider（同 shadcn 新版写法），不用改 main.tsx。延时 500ms，接近原生 title 的出现时间。
 * 内容走 Portal、z-50，脱离侧栏 / 顶栏的层叠上下文。
 *
 * 键盘聚焦时保持打开：Radix 在触发器的任一祖先滚动时关闭提示，而键盘 Tab 到视口外的触发器时，浏览器会先滚动把它带进视口，
 * 滚动事件在下一帧才派发，于是提示刚出现就被关掉。这里在“触发器仍是键盘焦点（:focus-visible）、且这次关闭不是 Esc”时
 * 忽略关闭请求；失焦、Esc 照常关闭。指针悬停打开的提示不受影响。
 * disabled：不显示提示（结构不变，触发器不重挂、键盘焦点不丢）。
 */
type Keep = { setTrigger: (el: HTMLElement | null) => void; markEscape: () => void }
const KeepContext = React.createContext<Keep | null>(null)

function Tooltip({ delayDuration = 500, open: openProp, onOpenChange, disabled = false, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root> & { delayDuration?: number; disabled?: boolean }) {
  const [inner, setInner] = React.useState(false)
  const trigger = React.useRef<HTMLElement | null>(null)
  const escape = React.useRef(false)
  const keep = React.useMemo<Keep>(() => ({ setTrigger: (el) => { trigger.current = el }, markEscape: () => { escape.current = true } }), [])
  const open = !disabled && (openProp ?? inner)
  const change = (next: boolean) => {
    const esc = escape.current
    escape.current = false
    const el = trigger.current
    if (!next && !esc && el && el === document.activeElement && el.matches(':focus-visible')) return
    setInner(next)
    onOpenChange?.(next)
  }
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <KeepContext.Provider value={keep}>
        <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={change} {...props} />
      </KeepContext.Provider>
    </TooltipPrimitive.Provider>
  )
}

function TooltipTrigger({ ref, onKeyDown, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const keep = React.useContext(KeepContext)
  const setRef = React.useCallback((el: HTMLButtonElement | null) => {
    keep?.setTrigger(el)
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }, [keep, ref])
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      ref={setRef}
      onKeyDown={(e) => { if (e.key === 'Escape') keep?.markEscape(); onKeyDown?.(e) }}
      {...props}
    />
  )
}

function TooltipContent({ className, sideOffset = 6, onEscapeKeyDown, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const keep = React.useContext(KeepContext)
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // Radix 在 document 捕获阶段处理 Esc，早于触发器自己的 keydown：这里先记下“这次关闭是 Esc”
        onEscapeKeyDown={(e) => { keep?.markEscape(); onEscapeKeyDown?.(e) }}
        className={cn('z-50 rounded-md border border-solid border-border bg-white px-[10px] py-[6px] text-[12px] text-text-2 shadow-pop', className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipTrigger }
