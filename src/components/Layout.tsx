import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  faCloudSun, faLayerGroup, faSliders, faLeaf, faTemperatureHalf, faFan, faSitemap, faGear, faRightFromBracket,
  faChevronDown, faChevronRight, faMagnifyingGlass, faHouse, faPlugCircleXmark, faClock,
} from '@fortawesome/free-solid-svg-icons'
import { Avatar, Icon, LogoMark } from './legacy'
import { Badge } from '@/components/ui/badge'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useApp } from '../app/store'
import { projectsInGroup, whenProjectSet } from '../data/org'
import { gatewayOf, type Project } from '../api'

export const NAV_MAIN = [
  { to: '/home', label: '欢迎首页', icon: faCloudSun },
  { to: '/groups', label: '集成项目', icon: faLayerGroup },
  { to: '/control', label: '统一控制', icon: faSliders },
]
export const NAV_PROJECT = [
  { to: '/sensors', label: '室内空气传感器', icon: faLeaf },
  { to: '/thermostat', label: '房间温控面板', icon: faTemperatureHalf },
  { to: '/fresh-air', label: '新风除湿机', icon: faFan },
  { to: '/connections', label: '设备连接状态', icon: faSitemap },
]
const ALL = [...NAV_MAIN, ...NAV_PROJECT, { to: '/settings', label: '系统设置', icon: faGear }]

/** 打开菜单时没有高亮（同旧版）；按上下键先高亮当前项目，回车选中 */
function ProjectSwitch() {
  const { project, setProjectId, toast, scope, user } = useApp()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef('')
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
   * | —（关着）   | 鼠标点触发器打开          | 列表（触发器先被按下聚焦）| —         | —        | —        |
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
  // 一个项目可能出现在多个集成项目下：菜单项的 cmdk 值用「组 id:项目 id」保证唯一（后端 ObjectId 与演示 id 都不含冒号），
  // 选中时仍传项目 id。当前项目的高亮落在菜单里它第一次出现的位置（按经销商 → 集成项目的渲染顺序）
  const currentValue = (() => {
    for (const d of scope.dealers) for (const g of scope.groups) if (g.dealerId === d.id && g.projectIds.includes(project.id)) return itemValue(g.id, project.id)
    return ''
  })()
  const show = (keyboard: boolean) => { setValue(keyboard ? currentValue : ''); scrolled.current = ''; if (keyboard) lastPointer.current = false; setOpen(true) }
  const pick = (p: Project) => { const r = setProjectId(p.id); setOpen(false); whenProjectSet(r, () => toast(`已切换到「${p.name}」`), () => toast('项目列表已更新，请稍后重试', true)) }
  // 打开后焦点在列表（listbox）上。高亮项的 id 写到列表的 aria-activedescendant：cmdk 只在它自己移动高亮时更新这个属性，
  // 高亮由这里改变（键盘打开、先高亮当前项目、鼠标移动清除）时它会过时，所以每次渲染后按实际高亮盖掉。
  // 高亮变化时滚进可视区（只滚一次，不跟用户的滚轮抢）。鼠标打开时没有高亮，菜单停在顶部（同旧版）
  const sync = () => {
    const el = value ? itemById(listRef.current, value) : null
    setActive(listRef.current, el)
    if (el && scrolled.current !== value) { el.scrollIntoView({ block: 'nearest' }); scrolled.current = value }
  }
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
            <span className="num">{project.code}</span>
          </div>
        </div>
      </PopoverTrigger>
      {/*
        旧菜单绝对定位在 .proj-switch 的内边距盒里（左右各让出 1px 边框、上沿距边框 5px），这里用对齐偏移复刻；
        旧菜单在侧栏的滚动区里，阴影被侧栏右沿裁掉，Portal 出来后用 clip-path 照裁。右沿在菜单右侧 15px 处 =
        global.css 的 .sb-scroll 右内边距 12px + .proj-switch 右外边距 2px + 右边框 1px（侧栏 232px 定宽）。例外：窗口矮到滚动区出现占宽的竖向滚动条时（Windows 等非覆盖式滚动条），旧版阴影在滚动条左沿就被裁掉，这里仍裁在侧栏右沿，阴影会多盖住滚动条那一窄条；
        改这几处数值时同步改这里。
        高度不超过视口里实际可用的高度（矮窗口下整个菜单仍在屏内，可滚动到最后一项）
      */}
      <PopoverContent
        asChild
        sideOffset={5}
        alignOffset={1}
        aria-label="切换当前项目"
        // 打开后焦点直接给列表（listbox），方向键与读屏的活动项都在它上面
        onOpenAutoFocus={(e) => { e.preventDefault(); listRef.current?.focus() }}
        onCloseAutoFocus={() => {
          pending.current = lastPointer.current
          queueMicrotask(() => { pending.current = false })
        }}
        onEscapeKeyDown={() => { lastPointer.current = false }}
        onPointerDown={() => { lastPointer.current = true }}
        className="max-h-[min(320px,var(--radix-popover-content-available-height))] w-[calc(var(--radix-popover-trigger-width)-2px)] cursor-pointer overflow-y-auto rounded-lg p-1.5 shadow-[0_10px_30px_rgba(2,6,23,.35)] [clip-path:inset(-60px_-15px_-60px_-60px)]"
      >
        <Command
          shouldFilter={false}
          value={value}
          onValueChange={setValue}
          onKeyDown={(e) => {
            lastPointer.current = false
            if (value === '' && currentValue && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setValue(currentValue) }
            // 菜单在 Portal 里，Tab / Shift+Tab 会跳到页面末尾：改为关闭菜单、焦点回到触发器
            if (e.key === 'Tab') { e.preventDefault(); setOpen(false) }
          }}
        >
          <CommandList ref={listRef} label="切换当前项目">
            {scope.dealers.map((d) => (
              <div key={d.id} role="presentation">
                {user.role === 'admin' && <div aria-hidden className="border-t border-line-2 px-2.5 pt-2.5 pb-0.5 text-[11px] font-bold text-primary">{d.short}</div>}
                {scope.groups.filter((g) => g.dealerId === d.id).map((g) => (
                  <div key={g.id} role="group" aria-label={user.role === 'admin' ? `${d.short} · ${g.name}` : g.name}>
                    <div aria-hidden className="px-2.5 pt-2 pb-1 text-[11px] text-faint">{g.name}</div>
                    {projectsInGroup(g, scope.projects).map((p) => (
                      <CommandItem
                        key={p.id}
                        value={itemValue(g.id, p.id)}
                        onSelect={() => pick(p)}
                        data-current={p.id === project.id || undefined}
                        className={cn('rounded-[7px] text-[13px]', p.id === project.id ? 'bg-primary-soft font-semibold text-primary' : 'hover:bg-background')}
                      >
                        <span>{p.name}</span><small className="num text-[11px] text-faint">{p.online ? p.code : '离线'}</small>
                      </CommandItem>
                    ))}
                  </div>
                ))}
              </div>
            ))}
            <AfterRender run={sync} />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** 项目搜索: only single projects inside the user's visible 集成项目; picking one makes it the 当前项目 */
function ProjectSearch() {
  const { scope, setProjectId, toast, project } = useApp()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  // 结果列表与高亮项的 id 由 cmdk 生成，渲染后读出来，供输入框的 aria-controls / aria-activedescendant 声明式引用
  const [listId, setListId] = useState<string>()
  const [itemId, setItemId] = useState<string>()
  const formRef = useRef<HTMLFormElement>(null)
  const contentId = useId()
  const s = q.trim().toLowerCase()
  const hits = s ? scope.projects.filter((p) => (p.name + ' ' + p.code).toLowerCase().includes(s)).slice(0, 8) : []
  // 一个项目可能属于多个集成项目：列出全部所属组名
  const gname = (p: Project) => scope.groups.filter((g) => projectsInGroup(g, [p]).length).map((g) => g.name).join('、')
  const shown = open && !!s
  const active = shown && value && hits.some((p) => p.id === value) ? itemId : undefined
  // 关闭（Esc、Tab 离开、点外部、选中）和重新打开都清掉高亮：重开后回车只会选第一条，不会选到之前高亮过的项
  const show = () => { setValue(''); setOpen(true) }
  const close = () => { setValue(''); setOpen(false) }
  const pick = (p: Project) => { const r = setProjectId(p.id); setQ(''); close(); whenProjectSet(r, () => toast(`当前项目已切换为「${p.name}」`), () => toast('项目列表已更新，请稍后重试', true)) }
  const inForm = (t: EventTarget | null) => t instanceof Node && !!formRef.current?.contains(t)
  const sync = () => {
    const c = document.getElementById(contentId), a = formRef.current?.getBoundingClientRect()
    setListId(c?.querySelector('[cmdk-list]')?.id)
    setItemId(value ? itemById(c, value)?.id : undefined)
    // Radix 把弹层坐标取整到整像素（x = 表单左沿，y = 表单下沿 + 6），而旧弹层跟着表单落在小数坐标上
    // （表单左沿取决于右侧用户名的宽度）。把取整丢掉的小数部分用外边距补回，文字落在与旧版完全相同的位置；
    // 只依赖锚点位置，与 Radix 异步定位的时序无关，窗口尺寸变化时重算
    if (c && a) {
      const dpr = window.devicePixelRatio || 1, frac = (n: number) => n - Math.round(n * dpr) / dpr
      c.style.margin = `${frac(a.bottom + 6)}px 0 0 ${frac(a.x)}px`
    }
  }
  return (
    <Popover open={shown} onOpenChange={(o) => { if (!o) close() }}>
      <PopoverAnchor asChild>
        <form className="relative w-[280px] text-[13px] text-faint" ref={formRef} onSubmit={(e) => { e.preventDefault(); if (hits[0]) pick(hits[0]) }}>
          {/* 输入框不是 cmdk 的 Command.Input（它把 aria-expanded 写死为 true），键盘事件冒泡到 Command 根上处理 */}
          <Command
            shouldFilter={false}
            tabIndex={undefined}
            value={value}
            onValueChange={setValue}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                // 弹层被 Esc 关掉后，上下键重新打开（不移动高亮）
                if (!shown) { e.preventDefault(); if (s) show() }
              } else if (e.key === 'Enter' && (!shown || value === '')) {
                // 没有键盘高亮时回车选第一条（同旧版的表单提交）
                e.preventDefault()
                if (hits[0]) pick(hits[0])
              }
            }}
          >
            <InputGroup variant="search">
              <Icon icon={faMagnifyingGlass} />
              <InputGroupInput
                className="min-w-0 text-foreground placeholder:text-faint"
                placeholder="搜索项目名称 / 项目ID"
                role="combobox"
                aria-label="搜索项目"
                aria-autocomplete="list"
                aria-expanded={shown}
                aria-controls={shown ? listId : undefined}
                aria-activedescendant={active}
                value={q}
                onFocus={show}
                onChange={(e) => { setQ(e.target.value); setValue(''); setOpen(true) }}
                // Home / End 留给输入框移动光标，不交给 cmdk 跳到首尾项
                onKeyDown={(e) => { if (e.key === 'Home' || e.key === 'End') e.stopPropagation() }}
              />
            </InputGroup>
            <PopoverContent
              id={contentId}
              aria-label="项目搜索结果"
              className="max-h-[360px] w-(--radix-popover-trigger-width) overflow-y-auto rounded-lg border border-border p-1.5 text-[13px] text-faint shadow-pop"
              // 焦点始终留在输入框：打开时不抢焦点，关闭时不回收；点输入框所在的表单不算点外部
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              onInteractOutside={(e) => { if (inForm(e.target)) e.preventDefault() }}
              // 点弹层任何地方（结果、空白、“未找到”文字）都不让输入框失焦
              onMouseDown={(e) => e.preventDefault()}
            >
              <CommandList label="项目搜索结果">
                {hits.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={p.id}
                    onSelect={() => pick(p)}
                    data-current={p.id === project.id || undefined}
                    className={cn('gap-2.5 rounded-md text-foreground', p.id === project.id ? 'bg-primary-soft' : 'hover:bg-background')}
                  >
                    <div><b className="block text-[13px] font-semibold">{p.name}</b><small className="mt-0.5 block text-[11.5px] text-faint">{gname(p)} · <span className="num">{p.code}</span></small></div>
                    <Badge variant={p.online ? 'green' : 'gray'}>{p.online ? '在线' : '离线'}</Badge>
                  </CommandItem>
                ))}
                <CommandEmpty className="px-2.5 py-3.5 text-[12.5px] text-muted-foreground">未找到匹配的项目（仅搜索您可见的集成项目内的项目）</CommandEmpty>
                <AfterRender run={sync} onResize />
              </CommandList>
            </PopoverContent>
          </Command>
        </form>
      </PopoverAnchor>
    </Popover>
  )
}

/**
 * 放在弹层内容里：弹层经 Portal 晚一拍挂载，父组件的 effect 看不到它；这里每次渲染后（含挂载）执行一次。
 * 用 useEffect 而不是 useLayoutEffect：挂载那一次，子组件的 layout effect 早于父元素的 ref 绑定
 */
function AfterRender({ run, onResize = false }: { run: () => void; onResize?: boolean }) {
  useEffect(run)
  // 窗口尺寸变化（含缩放）时也执行一次
  useEffect(() => {
    if (!onResize) return
    window.addEventListener('resize', run)
    return () => window.removeEventListener('resize', run)
  }, [onResize, run])
  return null
}
/** cmdk 选项上带 data-value（项目编号） */
const itemValue = (groupId: string, projectId: string) => groupId + ':' + projectId
const itemById = (root: Element | null, v: string) => root?.querySelector<HTMLElement>(`[cmdk-item][data-value="${CSS.escape(v)}"]`) ?? null
/** 组合框的 aria-activedescendant 指向当前高亮项（没有高亮时去掉） */
const setActive = (owner: Element | null, item: HTMLElement | null) => {
  if (item?.id) owner?.setAttribute('aria-activedescendant', item.id)
  else owner?.removeAttribute('aria-activedescendant')
}

function OfflineBanner({ p }: { p: Project }) {
  return (
    <div className="offline-banner" role="alert">
      <div className="ob-ico"><Icon icon={faPlugCircleXmark} /></div>
      <div className="ob-main">
        <b>项目离线 · {p.name}</b>
        <span>网关 <span className="num">{gatewayOf(p.id)}</span> 已失去连接，以下为最后在线时的数据（仅供参考），无法下发控制。</span>
      </div>
      <div className="ob-last"><small><Icon icon={faClock} /> 最后在线</small><b className="num">{p.lastOnline ?? '—'}</b><small>{p.lastOnlineAgo ?? ''}</small></div>
    </div>
  )
}

export default function Layout() {
  const { logout, project, confirm, user } = useApp()
  const loc = useLocation()
  const nav = useNavigate()
  const cur = ALL.find((n) => loc.pathname.startsWith(n.to))
  const isProjectPage = NAV_PROJECT.some((n) => n.to === cur?.to)
  const offline = isProjectPage && !project.online
  // 没有可见项目（真实接口账号下无项目）时 project 是 id 为空的占位：不算离线，设备页显示空态、不挂载（下面先于 offline 判断）
  const noProject = !project.id

  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])

  const onLogout = async () => {
    if (await confirm({ title: '退出登录', body: '确定要退出恒境云平台吗？', okText: '退出' })) { logout(); nav('/login') }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sb-logo">
          <LogoMark />
          <div className="logo-text"><b>恒境云</b><small>HVAC IoT PLATFORM</small></div>
        </div>
        <div className="sb-scroll">
          <div className="sb-label">主菜单</div>
          <div className="nav-main">
            {NAV_MAIN.map((n) => (
              <NavLink key={n.to} to={n.to} className="nav-item"><Icon className="ico" icon={n.icon} />{n.label}</NavLink>
            ))}
          </div>
          <ProjectSwitch />
          <div className="sb-label">项目数据</div>
          {NAV_PROJECT.map((n) => (
            <NavLink key={n.to} to={n.to} className="nav-item"><Icon className="ico" icon={n.icon} />{n.label}</NavLink>
          ))}
        </div>
        <div className="sb-foot">
          <NavLink to="/settings" className="nav-item"><Icon className="ico" icon={faGear} />系统设置</NavLink>
          <a className="nav-item" onClick={onLogout} style={{ cursor: 'pointer' }}><Icon className="ico" icon={faRightFromBracket} />退出登录</a>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            {isProjectPage ? (
              <>
                <Link to="/groups">集成项目</Link><Icon className="sep" icon={faChevronRight} />
                {/* 没有可见项目时不渲染空的项目名链接和离线标记 */}
                {!noProject && <>
                  <Link to="/groups">{project.name}</Link>
                  {!project.online && <Badge variant="red" className="crumb-off">离线</Badge>}
                  <Icon className="sep" icon={faChevronRight} />
                </>}
              </>
            ) : (
              <><Link to="/home"><Icon icon={faHouse} /></Link><Icon className="sep" icon={faChevronRight} /></>
            )}
            <span className="cur">{cur?.label ?? ''}</span>
          </div>
          <ProjectSearch />
          <div className="user">
            <Avatar />
            <div className="who"><b>{user.name}</b><small>{user.org} · {user.roleLabel}</small></div>
          </div>
        </header>
        {isProjectPage && noProject ? (
          <div className="page"><div className="empty-fav" role="status"><b>暂无可用项目</b><small>当前账号下没有可查看的项目，请到「集成项目」确认，或联系管理员</small></div></div>
        ) : offline ? (
          <div className="page offline-page">
            <OfflineBanner p={project} />
            <div className="offline-data" aria-disabled inert><Fragment key={project.id}><Outlet /></Fragment></div>
          </div>
        ) : <Fragment key={project.id}><Outlet /></Fragment>}
      </div>
    </div>
  )
}
