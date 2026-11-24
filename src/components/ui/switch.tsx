import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * 开关（原 legacy.tsx 的 Toggle 与 global.css 的 .toggle）：40×22、全圆角，关 #e2e8f0、开 --primary-2；
 * 滑块 16px 白底带阴影，距边 3px，开时 left 21px。旧滑块是 ::after，这里是 Thumb 元素，位置和过渡写法照旧（left，不用 translate）。
 * 根元素不设 display：保持 <button> 默认的 inline-block，滑块绝对定位、没有流内内容，基线与旧 .toggle 相同。
 * 行为来自 Radix：role="switch"、aria-checked、空格 / 回车切换。
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative h-[22px] w-10 flex-none rounded-[22px] bg-[#e2e8f0] [transition:background_.2s] data-[state=checked]:bg-primary-2',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="absolute top-[3px] left-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] [transition:left_.2s] data-[state=checked]:left-[21px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
