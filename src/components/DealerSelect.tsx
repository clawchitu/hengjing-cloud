// 经销商选择（只给平台账号用）：可搜索下拉（Popover + Command），替代原来的「搜索框 + Select」两件套
// （docs/plan-s1-s3.md 负责人确认 1：合并为可搜索下拉，放到改界面阶段，即 S6b）。
// 行为沿用 S3b 的两个弹层：
// - 触发器是原生 <button>，用浏览器默认焦点环：Radix 关闭时用脚本把焦点还给它，Chromium 对原生按钮只在键盘操作
//   （回车选中、Esc、Tab）后显示外圈，鼠标点选后不显示，所以不需要项目切换菜单那套 data-pointer-focus（e2e/dealer-select.spec.ts 验证）；
// - 打开后焦点在弹层里的搜索框（role=combobox），方向键移动高亮、回车选中，aria-activedescendant 指向高亮项；
//   打开时高亮当前经销商，输入时高亮第一条命中，鼠标移动清掉键盘高亮（ui/command.tsx），没有高亮时回车选第一条；
// - Esc 关闭、Tab / Shift+Tab 关闭并把焦点还给触发器（弹层在 Portal 里，不让焦点跳到页面末尾）。
// 列表加载中、为空、/distributors 失败（DealersError 显示错误和重试；「平台」虚拟分组仍可选）各有状态。
import { useId, useRef, useState } from 'react'
import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { AfterRender, itemById } from '@/components/ui/command-sync'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { selectArrow } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { DealersError } from './DealersError'
import { Icon } from './legacy'
import type { Dealer, Loadable } from '../data/org'

/** 选项右侧的小字：经销商编码；演示数据没有编码，用大区名（真实接口的 region 是行政区划码，不显示） */
const noteOf = (d: Dealer) => d.code || (/^\d/.test(d.region) ? '' : d.region)

/** 按名称、简称、编码、区域（演示数据还有经销商编号）匹配 */
const matchDealer = (d: Dealer, q: string) => {
  const s = q.trim().toLowerCase()
  return !s || [d.name, d.short, d.code, d.region, d.id].some((v) => !!v && v.toLowerCase().includes(s))
}

export function DealerSelect({ dealers, value, onChange }: { dealers: Loadable<Dealer[]>; value: string; onChange: (id: string) => void }) {
  const list = dealers.data
  const cur = list.find((d) => d.id === value)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hl, setHl] = useState('')
  // 搜索框的 aria-controls / aria-activedescendant 指向 cmdk 生成的列表与选项 id，渲染后读出来
  const [listId, setListId] = useState<string>()
  const [itemId, setItemId] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const contentId = useId()
  const labelId = useId()
  const valueId = useId()
  // 高亮变化时滚进可视区（只滚一次，不跟用户的滚轮抢）
  const scrolled = useRef('')
  const hits = list.filter((d) => matchDealer(d, q))
  const empty = !list.length
  const placeholder = dealers.status === 'loading' ? '正在加载经销商…' : dealers.status === 'error' ? '经销商列表加载失败' : '暂无经销商'

  const show = () => { scrolled.current = ''; setQ(''); setHl(cur ? cur.id : ''); setOpen(true) }
  const pick = (d: Dealer) => { setOpen(false); if (d.id !== value) onChange(d.id) }
  const sync = () => {
    const c = document.getElementById(contentId)
    setListId(c?.querySelector('[cmdk-list]')?.id)
    setItemId(hl ? itemById(c, hl)?.id : undefined)
    if (hl && scrolled.current !== hl) { itemById(c, hl)?.scrollIntoView({ block: 'nearest' }); scrolled.current = hl }
  }

  return (
    <div className="dealer-pick">
      <label id={labelId}>经销商</label>
      <Popover open={open} onOpenChange={(o) => (o ? show() : setOpen(false))}>
        <PopoverTrigger asChild>
          <button
            type="button"
            // 可访问名称 = 「经销商」+ 当前值，读屏回到触发器时能听到选的是谁
            aria-labelledby={`${labelId} ${valueId}`}
            disabled={empty}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!open) show() }
            }}
            className={cn(
              'flex h-[38px] w-full cursor-pointer items-center rounded-md border border-border pr-[30px] pl-3 text-left font-medium text-foreground disabled:cursor-default disabled:text-faint',
              selectArrow,
            )}
          >
            <span id={valueId} className="min-w-0 grow truncate">{cur ? cur.name : placeholder}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          id={contentId}
          aria-label="选择经销商"
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus() }}
          className="flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) flex-col rounded-lg border border-border p-1.5 text-[13px] shadow-pop"
        >
          <Command
            shouldFilter={false}
            value={hl}
            onValueChange={setHl}
            className="flex min-h-0 flex-col"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              // 没有键盘高亮时回车选第一条命中
              if (e.key === 'Enter' && !hl) { e.preventDefault(); if (hits[0]) pick(hits[0]) }
              if (e.key === 'Tab') { e.preventDefault(); setOpen(false) }
            }}
          >
            <InputGroup className="mb-1.5 shrink-0 px-2.5">
              <Icon icon={faMagnifyingGlass} />
              <InputGroupInput
                ref={inputRef}
                className="min-w-0 text-foreground"
                placeholder="搜索经销商名称 / 编码 / 区域"
                role="combobox"
                aria-label="搜索经销商"
                aria-autocomplete="list"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={itemId}
                value={q}
                onChange={(e) => { const v = e.target.value; setQ(v); setHl(list.find((d) => matchDealer(d, v))?.id ?? '') }}
                // Home / End 留给输入框移动光标，不交给 cmdk 跳到首尾项
                onKeyDown={(e) => { if (e.key === 'Home' || e.key === 'End') e.stopPropagation() }}
              />
            </InputGroup>
            <CommandList label="经销商" className="min-h-0 overflow-y-auto">
              {hits.map((d) => (
                <CommandItem
                  key={d.id}
                  value={d.id}
                  onSelect={() => pick(d)}
                  data-current={d.id === value || undefined}
                  className={cn('gap-3 rounded-[7px]', d.id === value ? 'bg-primary-soft font-semibold text-primary' : 'text-foreground hover:bg-background')}
                >
                  <span className="min-w-0 truncate">{d.name}</span>
                  {noteOf(d) && <small className="shrink-0 text-[11.5px] font-normal text-faint">{noteOf(d)}</small>}
                </CommandItem>
              ))}
              <CommandEmpty className="px-2.5 py-3 text-[12.5px] text-muted-foreground">未找到匹配的经销商</CommandEmpty>
              <AfterRender run={sync} />
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <small>{list.length} 个经销商 · 先选择经销商，再查看其集成项目</small>
      <DealersError dealers={dealers} />
    </div>
  )
}
