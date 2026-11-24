import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/*
 * 状态标签（原 global.css 的 .pill.*）：高 22px、0 8px、6px 圆角、11.5px/500、无边框。
 * 颜色取 tailwind.css 里映射到 :root 的 --color-*-soft。variant 名 dark 只是颜色名，不输出 dark 类。
 */
const badgeVariants = cva(
  'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-sm px-2 text-[11.5px] font-medium',
  {
    variants: {
      variant: {
        green: 'bg-green-soft text-green-soft-foreground',
        gray: 'bg-gray-soft text-gray-soft-foreground',
        cyan: 'bg-primary-soft text-primary',
        orange: 'bg-orange-soft text-orange-soft-foreground',
        amber: 'bg-amber-soft text-amber-soft-foreground',
        red: 'bg-red-soft text-red-soft-foreground',
        blue: 'bg-blue-soft text-blue-soft-foreground',
        purple: 'bg-purple-soft text-purple-soft-foreground',
        dark: 'bg-[#e2e8f0] text-text-2',
        none: '',
      },
    },
    defaultVariants: { variant: 'none' },
  },
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

function Badge({ className, variant = 'none', ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants, type BadgeVariant }
