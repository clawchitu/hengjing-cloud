import { useNavigate } from 'react-router-dom'
import { faLayerGroup, faBuilding, faSignal, faPlugCircleXmark, faArrowRight, faStar, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Icon } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp } from '../app/store'
import { useFrequentProjects, useOrgStat, whenProjectSet, type FrequentProject, type Project } from '../data/org'
import { defaultText } from '../api/errors'
import { useHomeWeather, WeatherActions, WeatherSection } from './home/WeatherSection'

export default function Home() {
  const nav = useNavigate()
  const { toast, setProjectId, user } = useApp()
  // 统计卡：/integrated-projects/stat（演示数据、无权限或失败时按可见范围算，口径相同）；常用项目：/projects/frequent，只留可见范围里的
  const weather = useHomeWeather()
  const stat = useOrgStat()
  const favs = useFrequentProjects(4)
  const st = stat.data
  const n = (v: number | undefined) => (v === undefined ? '—' : v)
  // 有在线状态未知的项目时（只在前端回退计算时出现），在线 / 离线只能给出范围：在线 ≥ 已知在线，离线 ≤ 已知离线 + 未知
  const unknown = st?.unknown ?? 0
  const range = (v: number | undefined, sign: '≥' | '≤') => (v === undefined ? '—' : unknown ? `${sign}${sign === '≥' ? v : v + unknown}` : v)
  const open = (p: Project) => whenProjectSet(setProjectId(p.id), () => { if (!p.online) toast(`${p.name} 当前离线，暂无实时数据`, true); nav('/sensors') }, (t) => toast(t, true))
  const now = new Date()
  const hour = now.getHours()
  const greet = hour < 11 ? '上午好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{greet}，{user.name} 👋</h1><div className="sub">今天是 {now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</div></div>
        {/* 天气（S7b）：城市选择和刷新在页头右侧，三块（实时、7 天、24 小时）在统计卡上方，见 ./home/WeatherSection */}
        <WeatherActions w={weather} />
      </div>

      <WeatherSection w={weather} />

      <div className="hj-grid g4" style={{ marginBottom: unknown ? 8 : 20 }}>
        <Card className="stat" pad={false}><div className="si" style={{ background: '#ecfeff', color: '#0891b2' }}><Icon icon={faLayerGroup} /></div><div><span>集成项目</span><b className="num">{n(st?.groups)}</b></div></Card>
        <Card className="stat" pad={false}><div className="si" style={{ background: '#eff6ff', color: '#2563eb' }}><Icon icon={faBuilding} /></div><div><span>项目总数</span><b className="num">{n(st?.projects)}</b></div></Card>
        <Card className="stat" pad={false}><div className="si" style={{ background: '#ecfdf5', color: '#059669' }}><Icon icon={faSignal} /></div><div><span>在线项目</span><b className="num">{range(st?.online, '≥')}<small> / {n(st?.projects)}</small></b></div></Card>
        <Card className="stat" pad={false}><div className="si" style={{ background: '#fff1f2', color: '#e11d48' }}><Icon icon={faPlugCircleXmark} /></div><div><span>离线项目</span><b className="num">{range(st?.offline, '≤')}<small> / {n(st?.projects)}</small></b></div></Card>
      </div>
      {/* 只在前端回退计算、且有关联项目不在项目列表里时出现（演示数据不会出现）：这些项目在线状态未知，不算在线也不算离线 */}
      {!!unknown && <div role="status" className="orange" style={{ fontSize: 12.5, marginBottom: 20 }}>数据不完整：{unknown} 个项目在线状态未知（集成项目关联了，但不在项目列表中），在线 / 离线数为范围</div>}

      <Card>
        {/* 「演示计数」开关去掉（方案 1.2）；卡片里的温湿度 / CO₂ 与「最后在线」接口无此字段（Q9 ③④），去掉 */}
        <CardHeader><div><CardTitle>常用项目</CardTitle><CardDescription>按您切换当前项目的次数统计，显示最常用的 4 个</CardDescription></div>
          <Button variant="link" onClick={() => nav('/groups')}>全部项目 <Icon icon={faArrowRight} /></Button></CardHeader>
        <Favorites favs={favs} onOpen={open} />
      </Card>
    </div>
  )
}

function Favorites({ favs, onOpen }: { favs: ReturnType<typeof useFrequentProjects>; onOpen: (p: Project) => void }) {
  if (!favs.permitted) return <div className="empty-fav" role="status"><Icon icon={faStar} /><b>常用项目暂不可用</b><small>当前账号未开通常用项目功能，可在「集成项目」或顶部搜索中选择项目</small></div>
  if (favs.status === 'loading') return null
  if (favs.status === 'error') return (
    <div className="empty-fav" role="alert"><Icon icon={faTriangleExclamation} /><b>常用项目加载失败</b><small>{favs.error?.message || defaultText('server')}</small>
      <Button variant="link" onClick={favs.refetch}>重试</Button></div>
  )
  if (favs.isEmpty) return <div className="empty-fav"><Icon icon={faStar} /><b>暂无常用项目</b><small>在「集成项目」或顶部搜索中选择项目后，这里会显示您最常用的项目</small></div>
  return <div className="hj-grid g4">{favs.data.map((f) => <FavCard key={f.project.id} fav={f} onOpen={onOpen} />)}</div>
}

function FavCard({ fav: { project: p, count }, onOpen }: { fav: FrequentProject; onOpen: (p: Project) => void }) {
  // 真实接口只有行政区划码，城市 / 区县名为空：只拼有值的部分
  const loc = [p.city, p.district, p.kind || p.appName].filter(Boolean).join(' · ')
  // 原生 title= 换成 Tooltip；卡片补上键盘可达：Tab 聚焦、Enter / 空格打开（同点击；按住不连发），
  // 键盘聚焦时提示立即出现。可访问名称用项目名、在线状态和编号（不读整张卡的文字）
  const card = (
    <div className="proj-card" role="button" tabIndex={0} aria-label={`${p.name}，${p.online ? '在线' : '离线'}，${p.code}`} onClick={() => onOpen(p)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!e.repeat) onOpen(p) } }}>
      <div className="pc-h"><Badge variant={p.online ? 'green' : 'gray'} style={{ color: p.online ? undefined : 'var(--muted)' }}>{p.online ? '在线' : '离线'}</Badge><span className="faint num" style={{ fontSize: 12 }}>{p.code}</span></div>
      <h4>{p.name}</h4>
      {loc && <div className="pc-loc">{loc}</div>}
    </div>
  )
  // 结构始终是 Tooltip 包着卡片：次数晚到时不换结构，卡片不重挂、键盘焦点不丢；没有次数时不显示提示
  return (
    <Tooltip disabled={count === undefined}>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      {count !== undefined && <TooltipContent side="bottom">已选择 {count} 次</TooltipContent>}
    </Tooltip>
  )
}
