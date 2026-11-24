// 经销商列表（/distributors）加载失败时在经销商选择处显示的独立错误与重试。
// 只影响经销商选择，不拖垮整个组织范围；「平台」虚拟分组仍然可选（见 src/data/org/hooks.ts useDealers）。
import { Button } from '@/components/ui/button'
import { defaultText } from '../api/errors'
import type { Dealer, Loadable } from '../data/org'

export function DealersError({ dealers }: { dealers: Loadable<Dealer[]> }) {
  if (dealers.status !== 'error') return null
  return (
    <div role="alert" className="red" style={{ fontSize: 12.5, marginTop: 6 }}>
      经销商列表加载失败：{dealers.error?.message || defaultText('server')}
      <Button variant="link" onClick={dealers.refetch}>重试</Button>
    </div>
  )
}
