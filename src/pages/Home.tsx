import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faLocationDot, faChevronDown, faRotateRight, faDroplet, faWind, faTemperatureLow, faGauge, faEye, faSun, faCloudSun, faCloudRain, faCloud, faMoon, faUmbrella, faLayerGroup, faBuilding, faSignal, faPlugCircleXmark, faArrowRight, faStar, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Chart, Icon, axis, tooltip, useAsync } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useApp } from '../app/store'
import { useFrequentProjects, useOrgStat, whenProjectSet, type FrequentProject, type Project } from '../data/org'
import { defaultText } from '../api/errors'
import * as api from '../api'

const WX: Record<string, [typeof faSun, string]> = { sun: [faSun, '#f59e0b'], cloudsun: [faCloudSun, '#f59e0b'], rain: [faCloudRain, '#0ea5e9'], cloud: [faCloud, '#94a3b8'], moon: [faMoon, '#818cf8'] }

function BigSun() {
  return (
    <svg width="130" height="110" viewBox="0 0 130 110">
      <g transform="translate(44 42)">
        {Array.from({ length: 12 }, (_, i) => <path key={i} d="M0 -38 L6 -26 L-6 -26 Z" fill="#fcd34d" transform={`rotate(${i * 30})`} />)}
        <circle r="25" fill="#fbbf24" /><circle r="17" fill="#fde68a" />
      </g>
      <path d="M48 98 h62 a18 18 0 0 0 -2 -36 a26 26 0 0 0 -48 -4 a20 20 0 0 0 -12 40z" fill="#fef3c7" />
      <path d="M48 98 h62 a18 18 0 0 0 -2 -36 a26 26 0 0 0 -48 -4 a20 20 0 0 0 -12 40z" fill="#fde68a" opacity=".5" transform="translate(0 4) scale(1 .96)" />
    </svg>
  )
}

export default function Home() {
  const nav = useNavigate()
  const { toast, setProjectId, user } = useApp()
  const [w] = useAsync(() => api.getWeather('上海'), [])
  // 统计卡：/integrated-projects/stat（演示数据、无权限或失败时按可见范围算，口径相同）；常用项目：/projects/frequent，只留可见范围里的
  const stat = useOrgStat()
  const favs = useFrequentProjects(4)
  const [spin, setSpin] = useState(false)
  // 交付包（__HJC_MOCK__ = false）没有天气接口：不等天气，整块显示「暂无天气数据」
  if (__HJC_MOCK__ && !w) return <div className="page" />
  const lo = 22, hi = 36
  const opt = w && {
    tooltip,
    grid: { left: 36, right: 40, top: 22, bottom: 30 },
    xAxis: { type: 'category' as const, boundaryGap: false, data: [...w.hours, '15时'], axisLabel: { ...axis.label, interval: 2 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: [
      { type: 'value' as const, min: 20, max: 35, interval: 5, axisLabel: { ...axis.label, formatter: '{value}°' }, splitLine: axis.split },
      { type: 'value' as const, min: 40, max: 100, interval: 10, axisLabel: { ...axis.label, formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      { name: '温度 °C', type: 'line' as const, smooth: true, data: w.hourTemp, symbol: 'circle', symbolSize: 5, lineStyle: { color: '#f28c38', width: 2.4 }, itemStyle: { color: '#f28c38' }, areaStyle: { color: 'rgba(249,115,22,.06)' } },
      { name: '湿度 %', type: 'line' as const, yAxisIndex: 1, smooth: true, data: w.hourHum, showSymbol: false, lineStyle: { color: '#06b6d4', width: 2, type: 'dotted' as const }, itemStyle: { color: '#06b6d4' } },
    ],
  }
  const st = stat.data
  const n = (v: number | undefined) => (v === undefined ? '—' : v)
  // 有在线状态未知的项目时（只在前端回退计算时出现），在线 / 离线只能给出范围：在线 ≥ 已知在线，离线 ≤ 已知离线 + 未知
  const unknown = st?.unknown ?? 0
  const range = (v: number | undefined, sign: '≥' | '≤') => (v === undefined ? '—' : unknown ? `${sign}${sign === '≥' ? v : v + unknown}` : v)
  const open = (p: Project) => whenProjectSet(setProjectId(p.id), () => { if (!p.online) toast(`${p.name} 当前离线，显示最后在线数据`, true); nav('/sensors') }, (t) => toast(t, true))
  const now = new Date()
  const hour = now.getHours()
  const greet = hour < 11 ? '上午好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{greet}，{user.name} 👋</h1><div className="sub">{__HJC_MOCK__ && w ? '今天是 2025年6月18日 星期三 · 农历五月廿三，以下是您所在区域的天气预报' : `今天是 ${now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}`}</div></div>
        {__HJC_MOCK__ && w && <div className="actions">
          <Button size="lg" style={{ fontWeight: 500, color: 'var(--text)' }} onClick={() => toast('演示环境仅提供上海市浦东新区天气')}><Icon icon={faLocationDot} className="cyan" />{w.city}<Icon icon={faChevronDown} size="xs" className="faint" /></Button>
          <Button size="lg" style={{ width: 42, padding: 0 }} onClick={() => { setSpin(true); setTimeout(() => { setSpin(false); toast('天气已更新') }, 800) }}><Icon icon={faRotateRight} spin={spin} /></Button>
        </div>}
      </div>

      {__HJC_MOCK__ && w && opt ? <>
      <div className="home-top">
        <div className="wx">
          <div className="wx-main">
            <BigSun />
            <div>
              <div className="wx-temp num">{w.temp}<sup>°C</sup></div>
              <div className="wx-desc">{w.text}<small>体感 {w.feels}°C · 最高 {w.high}° / 最低 {w.low}°</small></div>
            </div>
            <div className="wx-grid">
              <div><span><Icon icon={faDroplet} />相对湿度</span><b className="num">{w.humidity}%</b></div>
              <div><span><Icon icon={faWind} />{w.wind}</span><b className="num">{w.windLevel}</b></div>
              <div><span><Icon icon={faTemperatureLow} />露点</span><b className="num">{w.dew}°</b></div>
              <div><span><Icon icon={faGauge} />气压</span><b className="num">{w.pressure}<small>hPa</small></b></div>
              <div><span><Icon icon={faEye} />能见度</span><b className="num">{w.visibility}<small>km</small></b></div>
              <div><span><Icon icon={faSun} />紫外线</span><b>{w.uv}</b></div>
            </div>
          </div>
          <div className="wx-bot">
            <div><span className="aqi num">{w.aqi}</span><div><b>空气质量 · {w.aqiText}</b><small>PM2.5 {w.pm25} μg/m³</small></div></div>
            <div><Icon icon={faSun} style={{ color: '#fcd34d', fontSize: 20 }} /><div><b className="num">日出 {w.sunrise}</b><small className="num">日落 {w.sunset}</small></div></div>
            <div><Icon icon={faUmbrella} style={{ fontSize: 18 }} /><div><b className="num">降水概率 {w.rain}%</b><small>{w.rainNote}</small></div></div>
          </div>
        </div>
        <Card className="week">
          <CardHeader style={{ marginBottom: 8 }}><CardTitle>未来 7 天</CardTitle><span className="faint num" style={{ fontSize: 12 }}>更新于 14:30</span></CardHeader>
          {w.week.map((d) => {
            const [ic, c] = WX[d.icon]
            return (
              <div className="wd" key={d.d}>
                <b>{d.d}</b><Icon icon={ic} style={{ color: c }} /><span className="muted">{d.text}</span>
                <span className="faint num">{d.lo}°</span>
                <span className="rng"><i style={{ left: `${((d.lo - lo) / (hi - lo)) * 100}%`, right: `${100 - ((d.hi - lo) / (hi - lo)) * 100}%`, background: d.hi >= 34 ? 'linear-gradient(90deg,#fbbf24,#f97316)' : d.icon === 'rain' ? '#22d3ee' : 'linear-gradient(90deg,#22d3ee,#fbbf24,#f97316)' }} /></span>
                <b className="num" style={{ textAlign: 'right' }}>{d.hi}°</b>
              </div>
            )
          })}
        </Card>
      </div>

      <div className="home-mid full">
        <Card>
          <CardHeader style={{ marginBottom: 4 }}><div><CardTitle>24 小时预报</CardTitle><CardDescription>室外温度与相对湿度变化趋势</CardDescription></div>
            <div className="legend-dots"><span><i style={{ width: 14, height: 3, background: '#f28c38', display: 'inline-block' }} />温度 °C</span><span><i style={{ width: 14, height: 3, background: '#06b6d4', display: 'inline-block' }} />湿度 %</span></div></CardHeader>
          <Chart option={opt} height={236} />
          <div className="hourly">{w.hourIcons.map(([ic, h]) => <div key={h}><Icon icon={WX[ic][0]} style={{ color: WX[ic][1] }} /><span className="num">{h}</span></div>)}</div>
        </Card>
      </div>
      </> : (
        <Card style={{ marginBottom: 20 }}><CardHeader><div><CardTitle>天气</CardTitle><CardDescription>暂无天气数据</CardDescription></div></CardHeader></Card>
      )}

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
  return (
    <div className="proj-card" title={count === undefined ? undefined : `已选择 ${count} 次`} onClick={() => onOpen(p)}>
      <div className="pc-h"><Badge variant={p.online ? 'green' : 'gray'} style={{ color: p.online ? undefined : 'var(--muted)' }}>{p.online ? '在线' : '离线'}</Badge><span className="faint num" style={{ fontSize: 12 }}>{p.code}</span></div>
      <h4>{p.name}</h4>
      {loc && <div className="pc-loc">{loc}</div>}
    </div>
  )
}
