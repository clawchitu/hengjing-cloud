import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faLocationDot, faChevronDown, faRotateRight, faDroplet, faWind, faTemperatureLow, faGauge, faEye, faSun, faCloudSun, faCloudRain, faCloud, faMoon, faUmbrella, faSnowflake, faDropletSlash, faLeaf, faLayerGroup, faBuilding, faSignal, faBell, faArrowRight, faTemperatureHalf, faClock } from '@fortawesome/free-solid-svg-icons'
import { Card, Chart, Icon, axis, tooltip, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import { groups, projects } from '../mock/data'
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
  const { toast, setProjectId, alarmBadge } = useApp()
  const [w] = useAsync(() => api.getWeather('上海'), [])
  const [spin, setSpin] = useState(false)
  if (!w) return <div className="page" />
  const lo = 22, hi = 36
  const opt = {
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
  const favs = ['PRJ-10241', 'PRJ-10242', 'PRJ-20117', 'PRJ-30056'].map((id) => projects.find((p) => p.id === id)!)
  const online = projects.filter((p) => p.online).length
  const hour = new Date().getHours()
  const greet = hour < 11 ? '上午好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{greet}，张建国 👋</h1><div className="sub">今天是 2025年6月18日 星期三 · 农历五月廿三，以下是您所在区域的天气预报</div></div>
        <div className="actions">
          <button className="btn lg" style={{ fontWeight: 500, color: 'var(--text)' }} onClick={() => toast('演示环境仅提供上海市浦东新区天气')}><Icon icon={faLocationDot} className="cyan" />{w.city}<Icon icon={faChevronDown} size="xs" className="faint" /></button>
          <button className="btn lg" style={{ width: 42, padding: 0 }} onClick={() => { setSpin(true); setTimeout(() => { setSpin(false); toast('天气已更新') }, 800) }}><Icon icon={faRotateRight} spin={spin} /></button>
        </div>
      </div>

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
          <div className="card-head" style={{ marginBottom: 8 }}><h3 className="card-title">未来 7 天</h3><span className="faint num" style={{ fontSize: 12 }}>更新于 14:30</span></div>
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

      <div className="home-mid">
        <Card>
          <div className="card-head" style={{ marginBottom: 4 }}><div><h3 className="card-title">24 小时预报</h3><div className="card-sub">室外温度与相对湿度变化趋势</div></div>
            <div className="legend-dots"><span><i style={{ width: 14, height: 3, background: '#f28c38', display: 'inline-block' }} />温度 °C</span><span><i style={{ width: 14, height: 3, background: '#06b6d4', display: 'inline-block' }} />湿度 %</span></div></div>
          <Chart option={opt} height={262} />
          <div className="hourly">{w.hourIcons.map(([ic, h]) => <div key={h}><Icon icon={WX[ic][0]} style={{ color: WX[ic][1] }} /><span className="num">{h}</span></div>)}</div>
        </Card>
        <Card>
          <h3 className="card-title">运行建议</h3><div className="card-sub" style={{ marginBottom: 16 }}>基于今日天气的系统运行参考</div>
          <div className="advice" style={{ background: '#f0f9ff' }}><div className="ai" style={{ background: '#0ea5e9' }}><Icon icon={faSnowflake} /></div><div><b>建议制冷模式</b><small>室外最高 32°C，推荐室内设定 26°C</small></div></div>
          <div className="advice" style={{ background: '#ecfdf5' }}><div className="ai" style={{ background: '#10b981' }}><Icon icon={faDropletSlash} /></div><div><b>加强新风除湿</b><small>室外露点 21.6°C，顶辐射有结露风险</small></div></div>
          <div className="advice" style={{ background: '#fffbeb' }}><div className="ai" style={{ background: '#f59e0b' }}><Icon icon={faLeaf} /></div><div><b>夜间节能运行</b><small>22:00 后可切换节能模式，预计节电 12%</small></div></div>
        </Card>
      </div>

      <div className="grid g4" style={{ marginBottom: 20 }}>
        <Card className="stat" pad={false}><div className="si" style={{ background: '#ecfeff', color: '#0891b2' }}><Icon icon={faLayerGroup} /></div><div><span>项目组</span><b className="num">{groups.length}</b></div></Card>
        <Card className="stat" pad={false}><div className="si" style={{ background: '#eff6ff', color: '#2563eb' }}><Icon icon={faBuilding} /></div><div><span>项目总数</span><b className="num">{projects.length}</b></div></Card>
        <Card className="stat" pad={false}><div className="si" style={{ background: '#ecfdf5', color: '#059669' }}><Icon icon={faSignal} /></div><div><span>在线项目</span><b className="num">{online}<small> / {projects.length}</small></b></div></Card>
        <Card className="stat" pad={false} style={{ cursor: 'pointer' }}><div className="si" style={{ background: '#fff1f2', color: '#e11d48' }} onClick={() => nav('/alarm-center')}><Icon icon={faBell} /></div><div onClick={() => nav('/alarm-center')}><span>未处理报警</span><b className="num">{alarmBadge}</b></div></Card>
      </div>

      <Card>
        <div className="card-head"><h3 className="card-title">常用项目</h3><button className="link" onClick={() => nav('/groups')}>全部项目 <Icon icon={faArrowRight} /></button></div>
        <div className="grid g4">
          {favs.map((p) => (
            <div key={p.id} className="proj-card" onClick={() => { if (!p.online) return toast(`${p.name} 当前离线`, true); setProjectId(p.id); nav('/sensors') }}>
              <div className="pc-h"><span className={'pill ' + (p.online ? 'green' : 'gray')} style={{ color: p.online ? undefined : 'var(--muted)' }}>{p.online ? '在线' : '离线'}</span><span className="faint num" style={{ fontSize: 12 }}>{p.id}</span></div>
              <h4>{p.name}</h4>
              <div className="pc-loc">{p.city} · {p.district} · {p.kind}</div>
              {p.online ? (
                <div className="pc-m num"><span><Icon icon={faTemperatureHalf} style={{ color: '#f97316' }} /> {p.temp}°</span><span><Icon icon={faDroplet} style={{ color: '#06b6d4' }} /> {p.humidity}%</span><span><Icon icon={faLeaf} style={{ color: '#10b981' }} /> {p.co2}ppm</span></div>
              ) : <div className="pc-m faint"><span><Icon icon={faClock} /> 最后在线 {p.lastOnline}</span></div>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
