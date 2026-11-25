import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  faCloudSun, faLayerGroup, faSliders, faLeaf, faTemperatureHalf, faFan, faSitemap, faRightFromBracket,
  faChevronRight, faMagnifyingGlass, faHouse, faPlugCircleXmark,
} from '@fortawesome/free-solid-svg-icons'
import { Avatar, Icon, LogoMark } from './legacy'
import { SiteFooter } from './Icp'
import { Badge } from '@/components/ui/badge'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { AfterRender, itemById } from '@/components/ui/command-sync'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { OrgHint, ProjectSwitch } from './ProjectSwitch'
import { cn } from '@/lib/utils'
import { useApp } from '../app/store'
import { useCancelConfirmOnLeave, useConfirm } from '../app/feedback'
import { useIsFetching } from '@tanstack/react-query'
import { seqNames } from '@/lib/seqNames'
import { orgKeys, projectsInGroup, useOrgScope, whenProjectSet } from '../data/org'
import type { Project } from '../api'
import { OFFLINE_RECHECK_MS } from '../data/connections'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

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
const ALL = [...NAV_MAIN, ...NAV_PROJECT]

/** 项目搜索: only single projects inside the user's visible 集成项目; picking one makes it the 当前项目 */
function ProjectSearch() {
  const { setProjectId, toast, project } = useApp()
  const org = useOrgScope()
  const scope = org.data
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  // 结果列表与高亮项的 id 由 cmdk 生成，渲染后读出来，供输入框的 aria-controls / aria-activedescendant 声明式引用
  const [listId, setListId] = useState<string>()
  const [itemId, setItemId] = useState<string>()
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const contentId = useId()
  // Cmd+K / Ctrl+K：聚焦顶栏搜索（不做单独的命令面板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const s = q.trim().toLowerCase()
  const hits = s ? scope.projects.filter((p) => (p.name + ' ' + p.code).toLowerCase().includes(s)).slice(0, 8) : []
  // 一个项目可能属于多个集成项目：列出全部所属组名
  // 同名的集成项目（测试环境就有两个「五恒集成项目」）用序号区分，不显示编码（S13 走查：界面不显示 id）
  const gnames = seqNames(scope.groups, (g) => g.name, (g) => g.id)
  const pnames = seqNames(scope.projects, (p) => p.name, (p) => p.id)
  const gname = (p: Project) => scope.groups.filter((g) => projectsInGroup(g, [p]).length).map((g) => gnames.get(g.id) ?? g.name).join('、')
  const shown = open && !!s
  const active = shown && value && hits.some((p) => p.id === value) ? itemId : undefined
  // 关闭（Esc、Tab 离开、点外部、选中）和重新打开都清掉高亮：重开后回车只会选第一条，不会选到之前高亮过的项
  const show = () => { setValue(''); setOpen(true) }
  const close = () => { setValue(''); setOpen(false) }
  const pick = (p: Project) => { const r = setProjectId(p.id); setQ(''); close(); whenProjectSet(r, () => toast(`当前项目已切换为「${p.name}」`), (t) => toast(t, true)) }
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
                ref={inputRef}
                className="min-w-0 text-foreground placeholder:text-faint"
                placeholder="搜索项目名称 / 项目ID"
                aria-keyshortcuts="Meta+K Control+K"
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
              {org.staleError && <OrgHint text="项目列表刷新失败，搜索结果可能已过期" onRetry={org.refetch} />}
              <CommandList label="项目搜索结果">
                {hits.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={p.id}
                    onSelect={() => pick(p)}
                    data-current={p.id === project.id || undefined}
                    className={cn('gap-2.5 rounded-md text-foreground', p.id === project.id ? 'bg-primary-soft' : 'hover:bg-background')}
                  >
                    <div><b className="block text-[13px] font-semibold">{pnames.get(p.id) ?? p.name}</b><small className="mt-0.5 block text-[11.5px] text-faint">{gname(p)}</small></div>
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
 * 项目离线（项目列表的 online 不为 true：控制屏不在线，且没有在线的 DTU，见接口文档 4）。
 * 后端没有最后在线时间（Q9 ④），离线时也读不到设备数据（ctrl 返回 503），所以设备页不挂载、不显示旧数据，
 * 只显示横幅和空态（方案 1.2「离线横幅」、S11 验收）。
 */
function OfflineBanner({ p }: { p: Project }) {
  // 不显示 control_screen_id（S13 走查 P6：它是型号 id、不是屏号，三个项目共用同一个值），统一写「控制屏未连接」
  return (
    <div className="offline-banner" role="alert">
      <div className="ob-ico"><Icon icon={faPlugCircleXmark} /></div>
      <div className="ob-main">
        <b>项目离线 · {p.name}</b>
        <span>
          控制屏未连接，暂时读不到设备数据，也无法下发控制。
        </span>
      </div>
    </div>
  )
}

function OfflinePage({ p, title, onLeave }: { p: Project; title: string; onLeave: (hadFocus: boolean) => void }) {
  // 卸载时（DOM 移除之前）告诉 Layout 焦点是否在空态里：只有这种情况恢复在线后才移焦点
  const box = useRef<HTMLDivElement>(null)
  const leave = useRef(onLeave)
  useLayoutEffect(() => { leave.current = onLeave })
  useLayoutEffect(() => {
    const el = box.current
    return () => leave.current(!!el && el.contains(document.activeElement))
  }, [])
  const org = useOrgScope()
  // 组织数据（项目列表、集成项目等，都是只读接口）正在请求：按钮禁用，不重复发
  const fetching = useIsFetching({ queryKey: orgKeys.all }) > 0
  const [asked, setAsked] = useState(false)
  const refetch = org.refetch
  // 挂载期间每 60 秒只读重取一次（标签页不可见时跳过），项目恢复在线后自动显示页面
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') refetch() }, OFFLINE_RECHECK_MS)
    return () => clearInterval(t)
  }, [refetch])
  // 手动重取后失败（有旧数据时后台刷新失败记在 staleError）：提示可重试
  const failed = asked && !fetching ? org.staleError : null
  return (
    <div className="page offline-page" ref={box}>
      <OfflineBanner p={p} />
      <div className="page-head"><div><h1>{title}</h1><div className="sub">{p.name}</div></div></div>
      <Card className="placeholder" role="status">
        <div className="ph-ico"><Icon icon={faPlugCircleXmark} /></div>
        <h3>项目离线，暂无数据</h3>
        <p>项目恢复在线后即可查看实时数据。</p>
        <Button style={{ marginTop: 16 }} disabled={fetching} aria-busy={fetching} onClick={() => { setAsked(true); refetch() }}>重新获取在线状态</Button>
        {failed && <p role="alert" style={{ marginTop: 10, color: 'var(--red)' }}>获取在线状态失败：{failed.message}，请稍后重试</p>}
      </Card>
    </div>
  )
}

export default function Layout() {
  const { logout, project, user } = useApp()
  const confirm = useConfirm()
  const loc = useLocation()
  const nav = useNavigate()
  const cur = ALL.find((n) => loc.pathname.startsWith(n.to))
  const isProjectPage = NAV_PROJECT.some((n) => n.to === cur?.to)
  const offline = isProjectPage && !project.online
  // 没有可见项目（真实接口账号下无项目）时 project 是 id 为空的占位：不算离线，设备页显示空态、不挂载（下面先于 offline 判断）
  const noProject = !project.id

  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  // 同一项目由离线变为在线（看 project.online，不看路由），且焦点原本在即将卸载的离线空态里（如刚点的「重新获取在线状态」）：
  // 焦点会掉到 body，移到页面标题（tabIndex=-1），页面还没有标题时移到主区域。导航离开、焦点在侧栏等其他地方时不动
  const offlineHadFocus = useRef(false)
  const noteOfflineLeave = useCallback((had: boolean) => { offlineHadFocus.current = had }, [])
  const prevState = useRef({ id: project.id, online: project.online })
  useEffect(() => {
    const prev = prevState.current
    prevState.current = { id: project.id, online: project.online }
    const had = offlineHadFocus.current
    offlineHadFocus.current = false
    if (!(had && isProjectPage && prev.id === project.id && !prev.online && project.online)) return
    const t = setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return // 期间用户已把焦点放到别处
      const h = document.querySelector<HTMLElement>('.main .page h1') ?? document.querySelector<HTMLElement>('.main')
      if (!h) return
      if (!h.hasAttribute('tabindex')) h.tabIndex = -1
      h.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [project.id, project.online, isProjectPage])
  // 确认弹窗随离开失效：路由变化（含后退）或 Layout 卸载（如会话过期换成登录页）时按取消结算
  useCancelConfirmOnLeave()

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
          <OfflinePage p={project} title={cur?.label ?? ''} onLeave={noteOfflineLeave} />
        ) : <Fragment key={project.id}><Outlet /></Fragment>}
        <SiteFooter />
      </div>
    </div>
  )
}
