import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  faCloudSun, faLayerGroup, faSliders, faBell, faLeaf, faTemperatureHalf, faFan, faBolt, faGaugeHigh,
  faScrewdriverWrench, faSitemap, faTriangleExclamation, faGear, faRightFromBracket, faChevronDown, faChevronRight,
  faMagnifyingGlass, faHouse,
} from '@fortawesome/free-solid-svg-icons'
import { faBell as faBellR } from '@fortawesome/free-regular-svg-icons'
import { Avatar, Icon, LogoMark } from './ui'
import { useApp } from '../app/store'
import { groups, projects, user } from '../mock/data'

export const NAV_MAIN = [
  { to: '/home', label: '欢迎首页', icon: faCloudSun },
  { to: '/groups', label: '项目组管理', icon: faLayerGroup },
  { to: '/control', label: '统一控制', icon: faSliders },
  { to: '/alarm-center', label: '报警中心', icon: faBell, badge: 'all' as const },
]
export const NAV_PROJECT = [
  { to: '/sensors', label: '室内空气传感器', icon: faLeaf },
  { to: '/thermostat', label: '房间温控面板', icon: faTemperatureHalf },
  { to: '/fresh-air', label: '新风除湿机', icon: faFan },
  { to: '/meters', label: '电表数据', icon: faBolt },
  { to: '/realtime', label: '设备实时数据', icon: faGaugeHigh },
  { to: '/params', label: '工程参数设置', icon: faScrewdriverWrench },
  { to: '/connections', label: '设备连接状态', icon: faSitemap },
  { to: '/alarms', label: '报警信息', icon: faTriangleExclamation, badge: 'cur' as const },
]
const ALL = [...NAV_MAIN, ...NAV_PROJECT, { to: '/settings', label: '系统设置', icon: faGear }]

function ProjectSwitch() {
  const { project, setProjectId, toast } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div className="proj-switch" ref={ref} onClick={() => setOpen((o) => !o)}>
      <div className="lbl">当前项目</div>
      <div className="name">{project.name}<Icon className="chev" icon={faChevronDown} /></div>
      <div className="st">
        {project.online ? <span className="on"><span className="dot" /> 在线</span> : <span><span className="dot" /> 离线</span>}
        <span className="num">{project.id}</span>
      </div>
      {open && (
        <div className="proj-menu" onClick={(e) => e.stopPropagation()}>
          {groups.map((g) => (
            <div key={g.id}>
              <div className="grp">{g.name}</div>
              {projects.filter((p) => p.groupId === g.id).slice(0, 6).map((p) => (
                <div key={p.id} className={'opt' + (p.id === project.id ? ' cur' : '')}
                  onClick={() => { setProjectId(p.id); setOpen(false); toast(`已切换到「${p.name}」`) }}>
                  <span>{p.name}</span><small className="num">{p.online ? p.id : '离线'}</small>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Layout() {
  const { logout, alarmBadge, currentUnprocessed, project, confirm } = useApp()
  const loc = useLocation()
  const nav = useNavigate()
  const cur = ALL.find((n) => loc.pathname.startsWith(n.to))
  const isProjectPage = NAV_PROJECT.some((n) => n.to === cur?.to)
  const [q, setQ] = useState('')

  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])

  const onLogout = async () => {
    if (await confirm({ title: '退出登录', body: '确定要退出恒境云平台吗？', okText: '退出' })) { logout(); nav('/login') }
  }
  const onSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const hit = ALL.find((n) => q && n.label.includes(q))
    if (hit) nav(hit.to)
    else if (/AQ|传感/i.test(q)) nav('/sensors')
    else if (/FA|DH|新风|除湿/i.test(q)) nav('/fresh-air')
    else if (/HP|热泵/i.test(q)) nav('/realtime')
    else if (/报警|ALM/i.test(q)) nav('/alarms')
    else nav('/groups')
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
              <NavLink key={n.to} to={n.to} className="nav-item">
                <Icon className="ico" icon={n.icon} />{n.label}
                {n.badge && <span className="badge num">{alarmBadge}</span>}
              </NavLink>
            ))}
          </div>
          <ProjectSwitch />
          <div className="sb-label">项目数据</div>
          {NAV_PROJECT.map((n) => (
            <NavLink key={n.to} to={n.to} className="nav-item">
              <Icon className="ico" icon={n.icon} />{n.label}
              {n.badge && loc.pathname === '/alarms' && currentUnprocessed > 0 && <span className="badge num">{currentUnprocessed}</span>}
            </NavLink>
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
                <Link to="/groups">项目组管理</Link><Icon className="sep" icon={faChevronRight} />
                <Link to="/groups">{project.name}</Link><Icon className="sep" icon={faChevronRight} />
              </>
            ) : (
              <><Link to="/home"><Icon icon={faHouse} /></Link><Icon className="sep" icon={faChevronRight} /></>
            )}
            <span className="cur">{cur?.label ?? ''}</span>
          </div>
          <form className="search" onSubmit={onSearch}>
            <Icon icon={faMagnifyingGlass} />
            <input placeholder="搜索项目 / 设备 / 报警" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <button className="bell" onClick={() => nav('/alarm-center')} title="报警"><Icon icon={faBellR} /></button>
          <div className="user">
            <Avatar />
            <div className="who"><b>{user.name}</b><small>{user.org} · {user.role}</small></div>
          </div>
        </header>
        <Outlet />
      </div>
    </div>
  )
}
