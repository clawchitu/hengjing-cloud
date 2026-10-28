import { useState } from 'react'
import { faBuilding, faLocationDot, faRotate, faTemperatureHalf, faDroplet, faTemperatureLow, faSmog, faLeaf, faDownload } from '@fortawesome/free-solid-svg-icons'
import { Card, Chart, Icon, Seg, axis, tooltip, useAsync, useClock } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'

type Metric = '温度' | '湿度' | '露点' | 'PM2.5' | 'CO₂'

export default function Sensors() {
  const { projectId, project, toast } = useApp()
  const clock = useClock()
  const [sensors] = useAsync(() => api.getSensors(projectId), [projectId])
  const [range, setRange] = useState<'今日' | '近7天' | '近30天'>('今日')
  const [sel, setSel] = useState('AQ-01')
  const [metric, setMetric] = useState<Metric>('温度')
  const [trend] = useAsync(() => api.sensorTrend(metric), [metric, sel, range])
  if (!sensors || !trend) return <div className="page" />
  const on = sensors.filter((s) => s.online)
  const avg = (k: 'temp' | 'hum' | 'dew' | 'pm25' | 'co2') => on.reduce((s, x) => s + x[k], 0) / on.length
  const mx = (k: 'temp' | 'hum' | 'dew' | 'pm25' | 'co2') => Math.max(...on.map((x) => x[k]))
  const mn = (k: 'temp' | 'hum' | 'dew' | 'pm25' | 'co2') => Math.min(...on.map((x) => x[k]))
  const cur = sensors.find((s) => s.id === sel)!

  const kpis = [
    ['平均温度', avg('temp').toFixed(1), '°C', `最高 ${mx('temp')} · 最低 24.3`, faTemperatureHalf, '#f97316', '#fff7ed'],
    ['平均湿度', avg('hum').toFixed(0), '%RH', `最高 ${mx('hum')} · 最低 47`, faDroplet, '#0891b2', '#ecfeff'],
    ['平均露点', avg('dew').toFixed(1), '°C', `最高 ${mx('dew')} · 最低 13.4`, faTemperatureLow, '#6366f1', '#eef2ff'],
    ['平均 PM2.5', avg('pm25').toFixed(0), 'μg/m³', `最高 ${mx('pm25')} · 最低 6`, faSmog, '#10b981', '#ecfdf5'],
    ['平均 CO₂', '684', 'ppm', null, faLeaf, '#f59e0b', '#fffbeb'],
  ] as const

  const opt = {
    tooltip,
    grid: { left: 36, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'value' as const, min: 0, max: 24, interval: 3, axisLabel: { ...axis.label, formatter: (v: number) => (v < 24 ? `${String(v).padStart(2, '0')}:00` : '') }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: { type: 'value' as const, scale: true, min: metric === '温度' ? 24 : undefined, max: metric === '温度' ? 27 : undefined, interval: metric === '温度' ? 1 : undefined, axisLabel: axis.label, splitLine: { show: false } },
    series: [{
      type: 'line' as const, smooth: 0.5, showSymbol: false, data: trend.xs.slice(2, 46).map((x, i) => [x, trend.ys[i + 2]]),
      lineStyle: { color: '#f28c38', width: 2.6 }, itemStyle: { color: '#f28c38' },
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: '#cbd5e1', type: [6, 6] as unknown as 'dashed', width: 1 }, data: trend.band.map((y) => ({ yAxis: y })) },
    }],
  }
  const rooms = on.map((s) => ({ n: s.room, v: s.co2 }))
  const bar = {
    tooltip: { trigger: 'axis' as const },
    grid: { left: 52, right: 40, top: 10, bottom: 26 },
    xAxis: { type: 'value' as const, max: 1150, interval: 500, axisLabel: { ...axis.label, formatter: (v: number) => (v <= 1000 ? String(v) : '') }, splitLine: { show: false } },
    yAxis: { type: 'category' as const, inverse: true, data: rooms.map((r) => r.n), axisLabel: { color: '#64748b', fontSize: 11 }, axisLine: { lineStyle: { color: '#94a3b8' } }, axisTick: { show: false } },
    series: [{ type: 'bar' as const, barWidth: '52%', data: rooms.map((r) => ({ value: r.v, itemStyle: { color: r.v > 1000 ? '#f59e0b' : '#06b6d4' } })), label: { show: true, position: 'right' as const, fontSize: 11, color: '#475569', fontFamily: 'Barlow' },
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: '#f43f5e', type: 'dashed' as const, width: 1.4 }, data: [{ xAxis: 1000 }] } }],
  }
  const tag = (t: string) => t === '良好' ? 'green' : t === '离线' ? 'gray' : 'orange'

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>室内空气传感器</h1>
          <div className="sub" style={{ gap: 14 }}><span><Icon icon={faBuilding} /> {project.name}</span><span className="num">{project.id}</span><span><Icon icon={faLocationDot} /> {project.city} · {project.district}</span><span className="green"><span className="dot" /> 在线</span><span className="num">{project.version}</span></div></div>
        <div className="actions"><Seg className="primary" value={range} options={['今日', '近7天', '近30天']} onChange={setRange} /><span className="faint num" style={{ fontSize: 12 }}><Icon icon={faRotate} /> {clock} 更新</span></div>
      </div>
      <div className="grid g5" style={{ marginBottom: 20 }}>
        {kpis.map(([l, v, u, foot, ic, c, bg]) => (
          <Card key={l} className="kpi">
            <div className="k-label">{l}<span className="k-ico" style={{ background: bg, color: c }}><Icon icon={ic} /></span></div>
            <div className="k-val num">{v}<small>{u}</small></div>
            <div className="k-foot" style={{ color: 'var(--text-2)' }}>{foot ?? <>最高 <span className="red">1,126</span> · 最低 452</>}</div>
          </Card>
        ))}
      </div>
      <Card style={{ marginBottom: 20 }}>
        <div className="card-head"><h3 className="card-title">传感器列表 <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>{sensors.length} 台</span></h3>
          <div className="legend-dots"><span><span className="dot green" style={{ width: 7, height: 7 }} />良好</span><span><span className="dot" style={{ color: '#f59e0b', width: 7, height: 7 }} />超标</span><span><span className="dot" style={{ color: '#cbd5e1', width: 7, height: 7 }} />离线</span></div></div>
        <div className="grid g4">
          {sensors.map((s) => (
            <div key={s.id} className={'sensor' + (s.id === sel ? ' on' : '') + (!s.online ? ' off' : '')} onClick={() => (s.online ? setSel(s.id) : toast(`${s.room}传感器离线，最后在线 ${s.last}`, true))}>
              <div className="sh"><div><b>{s.room}</b><small className="num">{s.id} · {s.floor}</small></div><span className={'pill ' + tag(s.tag)}>{s.tag}</span></div>
              <div className="sv num">
                <div><span>温度</span><b>{s.online ? `${s.temp}°` : '—'}</b></div>
                <div><span>湿度</span><b>{s.online ? `${s.hum}%` : '—'}</b></div>
                <div><span>露点</span><b>{s.online ? `${s.dew}°` : '—'}</b></div>
                <div><span>PM2.5</span><b className={s.pm25 > 20 ? 'orange' : ''}>{s.online ? s.pm25 : '—'}</b></div>
                {s.online ? <div style={{ gridColumn: 'span 2' }}><span>CO₂</span><b className={s.co2 > 1000 ? 'orange' : ''}>{s.co2.toLocaleString()}<small>ppm</small></b></div> : <div style={{ gridColumn: 'span 2' }}><span>最后在线</span><b>{s.last}</b></div>}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 330px', gap: 20, marginBottom: 20 }}>
        <Card>
          <div className="card-head"><div><h3 className="card-title">数据统计 · {cur.room}</h3><div className="card-sub">24 小时趋势，虚线为舒适区阈值</div></div><Seg value={metric} options={['温度', '湿度', '露点', 'PM2.5', 'CO₂']} onChange={setMetric} /></div>
          <Chart option={opt} height={330} />
        </Card>
        <Card>
          <h3 className="card-title">各房间 CO₂ 对比</h3><div className="card-sub">当前值 · 标准 ≤ 1000 ppm</div>
          <Chart option={bar} height={350} />
        </Card>
      </div>
      <Card pad={false}>
        <div className="card-head card-pad" style={{ marginBottom: 0, paddingBottom: 14 }}><h3 className="card-title">指标统计汇总</h3><button className="btn" onClick={() => toast('已导出：空气质量统计_2025-06-18.csv')}><Icon icon={faDownload} />导出</button></div>
        <table className="table">
          <thead><tr><th>指标</th><th className="r">平均值</th><th className="r">最大值</th><th className="r">最小值</th><th className="r">标准范围</th><th className="r">超标时长</th><th style={{ paddingLeft: 40 }}>达标率</th></tr></thead>
          <tbody>
            {[['温度 (°C)', '25.6', '26.8', '24.3', '24 – 27', '0 h', 100], ['湿度 (%RH)', '52', '58', '47', '40 – 60', '0 h', 100], ['露点 (°C)', '15.1', '17.2', '13.4', '≤ 17.0', '0.5 h', 98], ['PM2.5 (μg/m³)', '12', '23', '6', '≤ 35', '0 h', 100], ['CO₂ (ppm)', '684', '1,126', '452', '≤ 1000', '2.3 h', 90]].map(([n, a, b, c, r, t, pct]) => (
              <tr key={n as string}>
                <td>{n}</td><td className="r num">{a}</td><td className={'r num ' + (b === '1,126' ? 'red' : '')}>{b}</td><td className="r num">{c}</td><td className="r num muted">{r}</td>
                <td className={'r num ' + (t !== '0 h' ? 'amber' : '')} style={{ fontWeight: t !== '0 h' ? 600 : 400 }}>{t}</td>
                <td style={{ paddingLeft: 40, width: 240 }}><div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: pct + '%', background: (pct as number) < 95 ? '#f59e0b' : undefined }} /></div><span className="num" style={{ width: 36, textAlign: 'right' }}>{pct}%</span></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
