// 侧栏「当前项目」切换器（负责人 11/25 确认的方案）：
// - 弹层顶部是搜索框，打开即聚焦；按项目名称、项目 ID、经销商名搜索（界面不显示 ID，但能用 ID 搜到）；
// - 不搜索时：经销商账号列 已置顶 → 最近使用（最多 5 个）→ 全部项目；平台账号只列 已置顶 和 最近使用，靠搜索找项目；
//   不按经销商 / 集成项目分组，按项目 id 去重（规则在 data/org/switcher.ts）；
// - 每行：在线状态点（离线再加「离线」两字，照常可选、不排后）+ 项目名 + 副标题经销商名（经销商账号的默认列表不显示）+ 星标置顶；
// - 最近使用、已置顶按账号存在 localStorage（data/org/prefs.ts）。打开时给分段拍一次快照：开着菜单点星标只改星标，
//   不让行在分段间跳动（也避开 cmdk「高亮项被卸载就跳到第一项」）；下次打开按新的置顶排；
// - 搜不到：提示；经销商账号多一行「只显示你名下的项目」（「去集成项目页搜索」入口暂不做：集成项目页还不能跨集成项目搜索，见 docs/待办.md）；
// - 底部固定一行「查看全部项目 →」，不跟列表滚动。
//
// 键盘与焦点：
// - 触发器的焦点环沿用旧版的 data-pointer-focus 状态机（下面注释的表格），e2e/popover.spec.ts 逐格验证；
// - 焦点在搜索框（role=combobox），方向键移动高亮、回车选中，aria-activedescendant 指向高亮项；
//   鼠标打开时没有高亮，键盘打开时高亮当前项目（在列表里时）；没有高亮时按上下键先高亮当前项目；
//   输入时高亮第一条命中，清空后回到打开时的高亮规则；没有高亮时回车选第一条命中（只在搜索时）；
// - cmdk 在高亮项被卸载时会把高亮改成新列表的第一项（同一次提交的 layout 阶段，晚于我们的 setHl），
//   换列表（输入 / 清空）后两帧内高亮不是目标值就设回去（同 pages/home/WeatherSection.tsx 的 arm）；
// - Esc 关闭；Tab / Shift+Tab 关闭并把焦点还给触发器；Home / End 留给输入框移动光标。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { faChevronDown, faMagnifyingGlass, faStar as faStarSolid } from '@fortawesome/free-solid-svg-icons'
import { faStar as faStarRegular } from '@fortawesome/free-regular-svg-icons'
import { Icon } from './legacy'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { AfterRender, itemById } from '@/components/ui/command-sync'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { seqNames } from '@/lib/seqNames'
import { useApp } from '../app/store'
import { useSession } from '../data/session'
import { dealerNames, defaultSections, searchProjects, togglePinned, useOrgScope, useProjectPrefs, whenProjectSet, type SwitchSection } from '../data/org'
import type { Project } from '../api'

/** 组织数据后台刷新失败（有旧数据）、经销商列表失败时，弹层顶部的提示；可重试 */
export function OrgHint({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="status" className="flex items-center justify-between gap-2 px-2.5 pt-1 pb-1.5 text-[11.5px] text-orange">
      <span>{text}</span>
      <button type="button" className="shrink-0 cursor-pointer text-primary hover:underline" onMouseDown={(e) => e.preventDefault()} onClick={onRetry}>重试</button>
    </div>
  )
}

export function ProjectSwitch() {
  const { project, setProjectId, toast } = useApp()
  const { userKey, dealerAccount } = useSession()
  const org = useOrgScope()
  const scope = org.data
  const prefs = useProjectPrefs(userKey)
  const names = useMemo(() => dealerNames(scope), [scope])
  const pname = useMemo(() => seqNames(scope.projects, (p) => p.name, (p) => p.id), [scope.projects])
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hl, setHl] = useState('')
  // 打开时的置顶 / 最近快照（见文件头）
  const [snap, setSnap] = useState<{ recent: readonly string[]; pinned: readonly string[] }>({ recent: [], pinned: [] })
  const [itemId, setItemId] = useState<string>()
  const [listId, setListId] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef('')
  const searching = !!q.trim()

  const sectionsFor = (s: typeof snap): SwitchSection[] => defaultSections({ projects: scope.projects, recent: s.recent, pinned: s.pinned, dealerAccount })
  const sections = searching ? [] : sectionsFor(snap)
  const hits = searching ? searchProjects(scope.projects, names, q) : []
  const rows = searching ? hits : sections.flatMap((s) => s.rows)
  const curInList = (list: readonly Project[]) => (list.some((p) => p.id === project.id) ? project.id : '')

  // 换列表后的目标高亮（见文件头）
  const want = useRef<string | null>(null)
  const wantGen = useRef(0)
  const arm = (target: string) => {
    want.current = target
    setHl(target)
    const gen = ++wantGen.current
    requestAnimationFrame(() => requestAnimationFrame(() => { if (wantGen.current === gen) want.current = null }))
  }
  useEffect(() => {
    if (want.current !== null && hl !== want.current) setHl(want.current)
  }, [hl])

  /*
   * 触发器的键盘焦点环（浏览器默认外圈，只在 :focus-visible 时出现）。
   * 问题：菜单关闭时 Radix 用脚本把焦点还给触发器；若之前用过键盘，Chromium 会让这次脚本聚焦也命中 :focus-visible，
   * 于是鼠标点选项目后触发器上冒出焦点环（原生按钮不会）。做法同 ui/tabs.tsx：只给“由这次指针操作关闭、
   * 并且 Radix 确实把焦点还给了触发器”的那一次聚焦打 data-pointer-focus，去掉外圈。
   *
   * 期望（“Tab 回来”= 焦点先在别处，再按 Tab 回到触发器；“直接按键”= 关闭后焦点就在触发器上，按一个非修饰键）
   * | 打开方式    | 关闭方式                  | 关闭后焦点               | 触发器外圈 | Tab 回来 | 直接按键 |
   * | 鼠标 / 键盘 | 鼠标点选项                | 触发器（Radix 还焦点）   | 无         | 有       | 有       |
   * | 鼠标 / 键盘 | 鼠标再点触发器            | 触发器（鼠标按下聚焦）   | 无         | 有       | 有       |
   * | —（关着）   | 鼠标点触发器打开          | 搜索框（触发器先被按下聚焦）| —       | —        | —        |
   * | 鼠标 / 键盘 | 方向键 + 回车选中         | 触发器（Radix 还焦点）   | 有         | 有       | 有       |
   * | 鼠标 / 键盘 | Esc                       | 触发器（Radix 还焦点）   | 有         | 有       | 有       |
   * | 鼠标 / 键盘 | Tab / Shift+Tab           | 触发器（Radix 还焦点）   | 有         | 有       | 有       |
   * | 鼠标 / 键盘 | 点外部                    | 不还（Radix 尊重外部交互）| —         | 有       | —        |
   *
   * 状态：
   * - lastPointer（ref）：菜单打开期间最后一次操作是不是指针。在菜单或触发器上指针按下置 true；
   *   菜单里按键、Esc（Radix 在 document 捕获阶段处理，菜单自己的 keydown 不一定执行，所以走 onEscapeKeyDown）、键盘打开置 false；
   * - pending（ref）：“触发器马上要因指针操作获得焦点”。两个来源：
   *   ① onCloseAutoFocus 里记“这次关闭由指针造成”，Radix 紧接着同步调用 trigger.focus()；没还焦点（点外部）时
   *      pending 在本次事件之后的微任务里清掉，不会留到以后的键盘聚焦；
   *   ② 在未聚焦的触发器上左键（无 Ctrl）/ 触屏按下，浏览器随后聚焦它（再点触发器关菜单就是这条）；click / pointercancel 时清掉；
   *   触发器 onFocus 时若 pending 则打标记，随即清 pending；
   * - data-pointer-focus：只在上面那一次聚焦落地时打上；触发器失焦或在它上面按非修饰键时清除。
   */
  const lastPointer = useRef(false)
  const pending = useRef(false)
  const [pointerFocus, setPointerFocus] = useState(false)

  const show = (keyboard: boolean) => {
    const s = { recent: prefs.recent, pinned: prefs.pinned }
    setSnap(s)
    setQ('')
    want.current = null
    setHl(keyboard ? curInList(sectionsFor(s).flatMap((x) => x.rows)) : '')
    scrolled.current = ''
    if (keyboard) lastPointer.current = false
    setOpen(true)
  }
  const pick = (p: Project) => {
    const r = setProjectId(p.id)
    setOpen(false)
    whenProjectSet(r, () => toast(`已切换到「${p.name}」`), (t) => toast(t, true))
  }
  const onQuery = (v: string) => {
    setQ(v)
    scrolled.current = ''
    if (v.trim()) arm(searchProjects(scope.projects, names, v)[0]?.id ?? '')
    else arm('')
  }
  const sync = () => {
    const el = hl ? itemById(listRef.current, hl) : null
    setListId(listRef.current?.id || undefined)
    setItemId(el?.id || undefined)
    if (el && scrolled.current !== hl) { el.scrollIntoView({ block: 'nearest' }); scrolled.current = hl }
  }

  const row = (p: Project, sub: boolean) => {
    const pinned = prefs.pinned.includes(p.id)
    const name = pname.get(p.id) ?? p.name
    const dealer = sub ? names.label.get(p.id) : ''
    const cur = p.id === project.id
    return (
      <CommandItem
        key={p.id}
        value={p.id}
        onSelect={() => pick(p)}
        data-current={cur || undefined}
        className={cn('gap-2 rounded-[7px] py-1.5 pr-1 text-[13px]', cur ? 'bg-primary-soft font-semibold text-primary' : 'text-foreground hover:bg-background')}
      >
        <div className="min-w-0 grow">
          <div className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className={cn('dot', p.online ? 'text-green-2' : 'text-faint')} />
            {!p.online && <span className="shrink-0 text-[11px] font-normal text-faint">离线</span>}
            <span className="min-w-0 truncate">{name}</span>
          </div>
          {dealer && <small className="mt-0.5 block truncate pl-3 text-[11px] font-normal text-faint">{dealer}</small>}
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-pressed={pinned}
          aria-label={pinned ? `取消置顶「${name}」` : `置顶「${name}」`}
          title={pinned ? '取消置顶' : '置顶'}
          data-pin
          // 项目没有 preflight，裸 <button> 的浏览器默认 2px outset 边框 / 灰底 / 内边距要自己清掉（这就是之前的粗框）；焦点环沿用浏览器默认（随圆角变圆）
          className={cn('grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-[13px] hover:bg-black/[.07]', pinned ? 'text-amber' : 'text-faint/70 hover:text-faint')}
          // 不让搜索框失焦、不触发选中
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePinned(userKey, p.id) }}
        >
          <Icon icon={pinned ? faStarSolid : faStarRegular} />
        </button>
      </CommandItem>
    )
  }

  const emptyText = searching
    ? null
    : dealerAccount
      ? (scope.projects.length ? null : '暂无可用项目')
      : (scope.projects.length ? '输入项目名称、项目 ID 或经销商名搜索；点星标可置顶常用项目' : '暂无可用项目')

  return (
    <Popover open={open} onOpenChange={(o) => (o ? show(false) : setOpen(false))}>
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-pointer-focus={pointerFocus || undefined}
          className="proj-switch data-[pointer-focus]:outline-none"
          onPointerDown={(e) => {
            lastPointer.current = true
            // 鼠标 / 触屏按下未聚焦的触发器，浏览器随后聚焦它（同 tabs.tsx：左键无 Ctrl）
            pending.current = e.button === 0 && !e.ctrlKey && document.activeElement !== e.currentTarget
          }}
          onPointerCancel={() => { pending.current = false }}
          onClick={() => { pending.current = false }}
          onFocus={() => { if (pending.current) setPointerFocus(true); pending.current = false }}
          onBlur={() => setPointerFocus(false)}
          // Radix 触发器默认是 <button type="button">，asChild 到 div 上时去掉这个无意义的 type
          {...{ type: undefined }}
          onKeyDown={(e) => {
            if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) setPointerFocus(false)
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(true) }
          }}
        >
          <div className="lbl">当前项目</div>
          <div className="name">{project.name}<Icon className="chev" icon={faChevronDown} /></div>
          <div className="st">
            {!project.id ? <span>暂无可用项目</span> : project.online ? <span className="on"><span className="dot" /> 在线</span> : <span className="off"><span className="dot" /> 离线</span>}
          </div>
        </div>
      </PopoverTrigger>
      {/*
        弹层比侧栏宽（搜索结果要放项目名 + 经销商名 + 星标），左沿对齐触发器，盖住主区域左侧。
        高度不超过视口里实际可用的高度（矮窗口下整个弹层仍在屏内）：搜索框、底部链接固定，中间列表限高滚动
      */}
      <PopoverContent
        sideOffset={5}
        alignOffset={1}
        aria-label="切换当前项目"
        onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus() }}
        onCloseAutoFocus={() => {
          pending.current = lastPointer.current
          queueMicrotask(() => { pending.current = false })
        }}
        onEscapeKeyDown={() => { lastPointer.current = false }}
        onPointerDown={() => { lastPointer.current = true }}
        className="flex max-h-[min(480px,var(--radix-popover-content-available-height))] w-[300px] flex-col rounded-lg border border-border p-1.5 shadow-[0_10px_30px_rgba(2,6,23,.35)]"
      >
        <Command
          shouldFilter={false}
          value={hl}
          onValueChange={setHl}
          className="flex min-h-0 flex-col"
          onKeyDown={(e) => {
            lastPointer.current = false
            want.current = null // 用户自己动了高亮，不再恢复
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            const cur = curInList(rows)
            if (hl === '' && cur && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setHl(cur) }
            // 没有键盘高亮时回车选第一条命中（只在搜索时）
            if (e.key === 'Enter' && hl === '') { e.preventDefault(); if (searching && hits[0]) pick(hits[0]) }
            // 弹层在 Portal 里，Tab / Shift+Tab 会跳到页面末尾：改为关闭、焦点回到触发器
            if (e.key === 'Tab') { e.preventDefault(); setOpen(false) }
          }}
        >
          {/* 演示数据不会出现：后台刷新失败时项目在线状态可能过期 */}
          {org.staleError && <OrgHint text="项目列表刷新失败，数据可能已过期" onRetry={org.refetch} />}
          {/* 平台账号：经销商列表失败时副标题可能缺经销商名，也搜不到经销商名；项目本身照常列出 */}
          {!dealerAccount && org.dealersError && <OrgHint text="经销商列表加载失败，部分项目暂不显示经销商名" onRetry={org.refetch} />}
          <InputGroup className="mb-1.5 shrink-0 px-2.5">
            <Icon icon={faMagnifyingGlass} />
            <InputGroupInput
              ref={inputRef}
              className="min-w-0 text-[13px] text-foreground"
              placeholder="搜索项目名称 / ID / 经销商"
              role="combobox"
              aria-label="搜索要切换的项目"
              aria-autocomplete="list"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={itemId}
              value={q}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Home' || e.key === 'End') e.stopPropagation() }}
            />
          </InputGroup>
          <CommandList ref={listRef} label="切换当前项目" className="max-h-[320px] min-h-0 overflow-y-auto">
            {searching
              ? hits.map((p) => row(p, true))
              : sections.map((s) => (
                <div key={s.key} role="group" aria-label={s.label} data-section={s.key}>
                  <div aria-hidden className="px-2.5 pt-2 pb-1 text-[11px] text-faint">{s.label}</div>
                  {s.rows.map((p) => row(p, !dealerAccount))}
                </div>
              ))}
            {searching && (
              <CommandEmpty className="px-2.5 py-3 text-[12.5px] text-muted-foreground">
                <div>没有匹配“{q.trim()}”的项目</div>
                {dealerAccount && <small className="mt-1 block text-[11px] text-faint">只显示你名下的项目</small>}
              </CommandEmpty>
            )}
            {emptyText && <div role="status" className="px-2.5 py-3 text-[12.5px] text-muted-foreground">{emptyText}</div>}
            <AfterRender run={sync} />
          </CommandList>
        </Command>
        <div className="mt-1 shrink-0 border-t border-line-2 px-2.5 pt-2 pb-1">
          <Link to="/groups" className="text-[12.5px] text-primary hover:underline" onClick={() => setOpen(false)}>查看全部项目 →</Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}
