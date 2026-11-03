import { Fragment } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  faCloudSun, faLayerGroup, faSliders, faLeaf, faTemperatureHalf, faFan, faSitemap, faGear, faRightFromBracket,
  faChevronDown, faChevronRight, faMagnifyingGlass, faHouse, faPlugCircleXmark, faClock,
} from '@fortawesome/free-solid-svg-icons'
import { Avatar, Icon, LogoMark } from './ui'
import { useApp } from '../app/store'
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

function useOutside<T extends HTMLElement>(close: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [close])
  return ref
}

function ProjectSwitch() {
  const { project, setProjectId, toast, scope, user } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useOutside<HTMLDivElement>(() => setOpen(false))
  const pick = (p: Project) => { setProjectId(p.id); setOpen(false); toast(`已切换到「${p.name}」`) }
  return (
    <div className="proj-switch" ref={ref} onClick={() => setOpen((o) => !o)}>
      <div className="lbl">当前项目</div>
      <div className="name">{project.name}<Icon className="chev" icon={faChevronDown} /></div>
      <div className="st">
        {project.online ? <span className="on"><span className="dot" /> 在线</span> : <span className="off"><span className="dot" /> 离线</span>}
        <span className="num">{project.id}</span>
      </div>
      {open && (
        <div className="proj-menu" onClick={(e) => e.stopPropagation()}>
          {scope.dealers.map((d) => (
            <div key={d.id}>
              {user.role === 'admin' && <div className="dlr">{d.short}</div>}
              {scope.groups.filter((g) => g.dealerId === d.id).map((g) => (
                <div key={g.id}>
                  <div className="grp">{g.name}</div>
                  {scope.projects.filter((p) => p.groupId === g.id).map((p) => (
                    <div key={p.id} className={'opt' + (p.id === project.id ? ' cur' : '')} onClick={() => pick(p)}>
                      <span>{p.name}</span><small className={'num' + (p.online ? '' : ' red')}>{p.online ? p.id : '离线'}</small>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 项目搜索: only single projects inside the user's visible 集成项目; picking one makes it the 当前项目 */
function ProjectSearch() {
  const { scope, setProjectId, toast, project } = useApp()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useOutside<HTMLFormElement>(() => setOpen(false))
  const s = q.trim().toLowerCase()
  const hits = s ? scope.projects.filter((p) => (p.name + ' ' + p.id).toLowerCase().includes(s)).slice(0, 8) : []
  const gname = (id: string) => scope.groups.find((g) => g.id === id)?.name ?? ''
  const pick = (p: Project) => { setProjectId(p.id); setQ(''); setOpen(false); toast(`当前项目已切换为「${p.name}」`) }
  return (
    <form className="search" ref={ref} onSubmit={(e) => { e.preventDefault(); if (hits[0]) pick(hits[0]) }}>
      <Icon icon={faMagnifyingGlass} />
      <input placeholder="搜索项目名称 / 项目ID" value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true) }} />
      {open && s && (
        <div className="search-pop">
          {hits.length ? hits.map((p) => (
            <div key={p.id} className={'sp-row' + (p.id === project.id ? ' cur' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
              <div><b>{p.name}</b><small>{gname(p.groupId)} · <span className="num">{p.id}</span></small></div>
              <span className={'pill ' + (p.online ? 'green' : 'gray')}>{p.online ? '在线' : '离线'}</span>
            </div>
          )) : <div className="sp-empty">未找到匹配的项目（仅搜索您可见的集成项目内的项目）</div>}
        </div>
      )}
    </form>
  )
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
                <Link to="/groups">{project.name}</Link>
                {!project.online && <span className="pill red crumb-off">离线</span>}
                <Icon className="sep" icon={faChevronRight} />
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
        {offline ? (
          <div className="page offline-page">
            <OfflineBanner p={project} />
            <div className="offline-data" aria-disabled inert><Fragment key={project.id}><Outlet /></Fragment></div>
          </div>
        ) : <Fragment key={project.id}><Outlet /></Fragment>}
      </div>
    </div>
  )
}
