import { useEffect, useState } from 'react'
import { faBuilding, faLocationDot, faRotate, faTemperatureHalf, faDroplet, faTemperatureLow, faSmog, faLeaf, faDownload, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { Card, Chart, Icon, Seg, axis, tooltip, useAsync, useClock } from '../components/legacy'
import { useApp } from '../app/store'
import * as api from '../api'
import type { DayPoint, HourPoint, MetricKey, Sensor } from '../api'

export type Range = '24小时' | '7日' | '30日'

interface MetricDef { key: MetricKey; tab: string; label: string; unit: string; kpiUnit: string; icon: IconDefinition; color: string; bg: string; digits: number; lo?: number; hi: number; rangeText: string }
export const METRICS: MetricDef[] = [
  { key: 'temp', tab: '温度', label: '温度 (°C)', unit: '°C', kpiUnit: '°C', icon: faTemperatureHalf, color: '#f97316', bg: '#fff7ed', digits: 1, lo: 24, hi: 27, rangeText: '24 – 27' },
  { key: 'hum', tab: '湿度', label: '湿度 (%RH)', unit: '%', kpiUnit: '%RH', icon: faDroplet, color: '#0891b2', bg: '#ecfeff', digits: 0, lo: 40, hi: 60, rangeText: '40 – 60' },
  { key: 'dew', tab: '露点', label: '露点 (°C)', unit: '°C', kpiUnit: '°C', icon: faTemperatureLow, color: '#6366f1', bg: '#eef2ff', digits: 1, hi: 17, rangeText: '≤ 17.0' },
  { key: 'pm25', tab: 'PM2.5', label: 'PM2.5 (μg/m³)', unit: '', kpiUnit: 'μg/m³', icon: faSmog, color: '#10b981', bg: '#ecfdf5', digits: 0, hi: 35, rangeText: '≤ 35' },
  { key: 'co2', tab: 'CO₂', label: 'CO₂ (ppm)', unit: 'ppm', kpiUnit: 'ppm', icon: faLeaf, color: '#f59e0b', bg: '#fffbeb', digits: 0, hi: 1000, rangeText: '≤ 1000' },
]
const has = (s: Sensor, k: MetricKey) => s[k] !== undefined
const out = (m: MetricDef, v: number) => v > m.hi || (m.lo !== undefined && v < m.lo)
const fmtN = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/** shared: fetch stats for one device through the 24h API or the shared daily API */
export function useStats(range: Range, fetch24: () => Promise<HourPoint[]>, fetchDaily: (days: 7 | 30) => Promise<DayPoint[]>, deps: unknown[]) {
  const [data, setData] = useState<{ range: Range; hours?: HourPoint[]; days?: DayPoint[] }>()
  useEffect(() => {
    let live = true
    if (range === '24小时') fetch24().then((hours) => live && setData({ range, hours }))
    else fetchDaily(range === '7日' ? 7 : 30).then((days) => live && setData({ range, days }))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, ...deps])
  return data?.range === range ? data : undefined
}

export default function Sensors() {
  const { projectId, project, toast } = useApp()
  const clock = useClock()
  const [sensors] = useAsync(() => api.getSensors(projectId), [projectId])
  const [range, setRange] = useState<Range>('24小时')
  const [selRaw, setSel] = useState('')
  const [metricRaw, setMetric] = useState<MetricKey>('temp')
  const firstOnline = sensors?.find((s) => s.online)
  const cur = sensors?.find((s) => s.id === selRaw && s.online) ?? firstOnline
  const stats = useStats(range, () => api.getSensorStats24h(projectId, cur?.id ?? ''), (d) => api.getSensorStatsDaily(projectId, cur?.id ?? '', d), [projectId, cur?.id])
  if (!sensors) return <div className="page" />

  const on = sensors.filter((s) => s.online)
  // KPIs: metrics that at least one online sensor measures
  const kpis = METRICS.filter((m) => on.some((s) => has(s, m.key)))
  const curMetrics = cur ? METRICS.filter((m) => has(cur, m.key)) : []
  const metric = curMetrics.find((m) => m.key === metricRaw) ?? curMetrics[0]
  const tag = (t: string) => t === '良好' ? 'green' : t === '离线' ? 'gray' : 'orange'

  // chart
  const isDaily = !!stats?.days
  const xs = stats?.hours?.map((h) => h.t) ?? stats?.days?.map((d) => d.date) ?? []
  // comfort thresholds drawn as flat dashed series (markLine collapses on a category axis)
  const thresholdSeries = metric ? [metric.lo, metric.hi].filter((v): v is number => v !== undefined).map((y) => ({
    name: y === metric.hi ? `上限 ${y}` : `下限 ${y}`, type: 'line' as const, silent: true, showSymbol: false, data: xs.map(() => y), tooltip: { show: false },
    lineStyle: { color: '#94a3b8', type: [6, 6] as unknown as 'dashed', width: 1.2 }, itemStyle: { color: '#94a3b8' },
    endLabel: { show: true, formatter: y === metric.hi ? `上限 ${y}` : `下限 ${y}`, color: '#64748b', fontSize: 11 },
  })) : []
  const opt = metric && stats ? {
    tooltip,
    legend: isDaily ? { data: ['日均值', '日最高', '日最低'], top: 0, right: 0, icon: 'rect', itemWidth: 16, itemHeight: 3, textStyle: { color: '#64748b', fontSize: 11 } } : undefined,
    grid: { left: 44, right: 64, top: 30, bottom: 30 },
    xAxis: { type: 'category' as const, boundaryGap: false, data: xs, axisLabel: { ...axis.label, interval: isDaily ? 'auto' as const : 2 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: 'value' as const, scale: true,
      // keep the comfort thresholds inside the plotted range so the dashed lines are always visible
      min: (v: { min: number; max: number }) => { const lo = Math.min(v.min, metric.lo ?? v.min); const pad = (Math.max(v.max, metric.hi) - lo) * 0.08; return +(lo - pad).toFixed(metric.digits) },
      max: (v: { min: number; max: number }) => { const hi = Math.max(v.max, metric.hi); const pad = (hi - Math.min(v.min, metric.lo ?? v.min)) * 0.08; return +(hi + pad).toFixed(metric.digits) },
      axisLabel: axis.label, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    series: isDaily ? [
      { name: '日均值', type: 'line' as const, smooth: true, showSymbol: false, data: stats.days!.map((d) => d[metric.key]?.avg), lineStyle: { color: '#f28c38', width: 2.6 }, itemStyle: { color: '#f28c38' } },
      { name: '日最高', type: 'line' as const, smooth: true, showSymbol: false, data: stats.days!.map((d) => d[metric.key]?.max), lineStyle: { color: '#f43f5e', width: 1.2, type: 'dashed' as const }, itemStyle: { color: '#f43f5e' } },
      { name: '日最低', type: 'line' as const, smooth: true, showSymbol: false, data: stats.days!.map((d) => d[metric.key]?.min), lineStyle: { color: '#06b6d4', width: 1.2, type: 'dashed' as const }, itemStyle: { color: '#06b6d4' } },
      ...thresholdSeries,
    ] : [{
      name: metric.tab, type: 'line' as const, smooth: 0.5, showSymbol: false, data: stats.hours!.map((h) => h[metric.key]),
      lineStyle: { color: '#f28c38', width: 2.6 }, itemStyle: { color: '#f28c38' },
    }, ...thresholdSeries],
  } : null

  // summary rows computed from the API data for the selected sensor
  const rows = stats && cur ? curMetrics.map((m) => {
    if (stats.hours) {
      const vs = stats.hours.map((h) => h[m.key]).filter((v): v is number => v !== undefined)
      if (!vs.length) return null
      const bad = vs.filter((v) => out(m, v)).length
      return { m, avg: vs.reduce((a, b) => a + b, 0) / vs.length, max: Math.max(...vs), min: Math.min(...vs), over: `${bad} h`, overN: bad, pct: Math.round(((vs.length - bad) / vs.length) * 100) }
    }
    const ds = stats.days!.map((d) => d[m.key]).filter((a) => a !== undefined)
    if (!ds.length) return null
    const bad = ds.filter((a) => out(m, a.max) || out(m, a.min)).length
    return { m, avg: ds.reduce((a, b) => a + b.avg, 0) / ds.length, max: Math.max(...ds.map((a) => a.max)), min: Math.min(...ds.map((a) => a.min)), over: `${bad} 天`, overN: bad, pct: Math.round(((ds.length - bad) / ds.length) * 100) }
  }).filter((r) => r !== null) : []

  const avg = (k: MetricKey) => { const v = on.filter((s) => has(s, k)).map((s) => s[k] as number); return { a: v.reduce((x, y) => x + y, 0) / v.length, mx: Math.max(...v), mn: Math.min(...v), n: v.length } }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>室内空气传感器</h1>
          <div className="sub" style={{ gap: 14 }}><span><Icon icon={faBuilding} /> {project.name}</span><span className="num">{project.id}</span><span><Icon icon={faLocationDot} /> {project.city} · {project.district}</span>{project.online ? <span className="green"><span className="dot" /> 在线</span> : <span className="red"><span className="dot" /> 离线</span>}<span className="num">{project.version}</span></div></div>
        <div className="actions"><Seg className="primary" value={range} options={['24小时', '7日', '30日']} onChange={setRange} /><span className="faint num" style={{ fontSize: 12 }}><Icon icon={faRotate} /> {project.online ? `${clock} 更新` : `最后更新 ${project.lastOnline?.slice(11) ?? '—'}`}</span></div>
      </div>
      <div className="hj-grid" style={{ gridTemplateColumns: `repeat(${Math.max(3, kpis.length)}, minmax(0, 1fr))`, marginBottom: 20 }}>
        {kpis.map((m) => {
          const s = avg(m.key)
          return (
            <Card key={m.key} className="kpi">
              <div className="k-label">平均 {m.tab}<span className="k-ico" style={{ background: m.bg, color: m.color }}><Icon icon={m.icon} /></span></div>
              <div className="k-val num">{fmtN(s.a, m.digits)}<small>{m.kpiUnit}</small></div>
              <div className="k-foot" style={{ color: 'var(--text-2)' }}>最高 <span className={s.mx > m.hi ? 'red' : ''}>{fmtN(s.mx, m.digits)}</span> · 最低 {fmtN(s.mn, m.digits)}{s.n < on.length && <span className="faint"> · {s.n}/{on.length} 台具备</span>}</div>
            </Card>
          )
        })}
      </div>
      <Card style={{ marginBottom: 20 }}>
        <div className="card-head"><h3 className="card-title">传感器列表 <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>{sensors.length} 台</span></h3>
          <div className="legend-dots"><span><span className="dot green" style={{ width: 7, height: 7 }} />良好</span><span><span className="dot" style={{ color: '#f59e0b', width: 7, height: 7 }} />超标</span><span><span className="dot" style={{ color: '#cbd5e1', width: 7, height: 7 }} />离线</span></div></div>
        <div className="hj-grid g4">
          {sensors.map((s) => (
            <div key={s.id} className={'sensor' + (s.id === cur?.id ? ' on' : '') + (!s.online ? ' off' : '')} onClick={() => (s.online ? setSel(s.id) : toast(`${s.room}传感器离线，最后在线 ${s.last}`, true))}>
              <div className="sh"><div><b>{s.room}</b><small className="num">{s.id} · {s.floor}</small></div><span className={'pill ' + tag(s.tag)}>{s.tag}</span></div>
              <div className="sv num">
                <div><span>温度</span><b>{s.online ? `${s.temp}°` : '—'}</b></div>
                <div><span>湿度</span><b>{s.online ? `${s.hum}%` : '—'}</b></div>
                <div><span>露点</span><b>{s.online ? `${s.dew}°` : '—'}</b></div>
                {has(s, 'pm25') && <div><span>PM2.5</span><b className={s.online && s.pm25! > 20 ? 'orange' : ''}>{s.online ? s.pm25 : '—'}</b></div>}
                {s.online ? (has(s, 'co2') && <div style={{ gridColumn: 'span 2' }}><span>CO₂</span><b className={s.co2! > 1000 ? 'orange' : ''}>{s.co2!.toLocaleString()}<small>ppm</small></b></div>)
                  : <div style={{ gridColumn: 'span 2' }}><span>最后在线</span><b>{s.last}</b></div>}
                {s.online && !has(s, 'pm25') && !has(s, 'co2') && <div className="nocap" style={{ gridColumn: 'span 3' }}>该型号无 PM2.5 / CO₂ 探头</div>}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card style={{ marginBottom: 20 }}>
        <div className="card-head"><div><h3 className="card-title">数据统计 · {cur?.room ?? '—'}</h3><div className="card-sub">{range === '24小时' ? '24 小时趋势（逐时）' : `近${range === '7日' ? ' 7 ' : ' 30 '}日趋势（日均 / 日最高 / 日最低）`}，虚线为舒适区阈值</div></div>
          {metric && <Seg value={metric.tab} options={curMetrics.map((m) => m.tab)} onChange={(t) => setMetric(METRICS.find((m) => m.tab === t)!.key)} />}</div>
        {opt ? <Chart option={opt} height={300} /> : <div style={{ height: 300 }} className="chart-loading">{cur ? '加载中…' : '暂无在线传感器'}</div>}
      </Card>
      <Card pad={false}>
        <div className="card-head card-pad" style={{ marginBottom: 0, paddingBottom: 14 }}><div><h3 className="card-title">指标统计汇总</h3><div className="card-sub">{cur?.room ?? '—'} · {range}</div></div><button className="btn" onClick={() => toast(`已导出：空气质量统计_${cur?.room ?? ''}_${range}.csv`)}><Icon icon={faDownload} />导出</button></div>
        <table className="table">
          <thead><tr><th>指标</th><th className="r">平均值</th><th className="r">最大值</th><th className="r">最小值</th><th className="r">标准范围</th><th className="r">{range === '24小时' ? '超标时长' : '超标天数'}</th><th style={{ paddingLeft: 40 }}>达标率</th></tr></thead>
          <tbody>
            {rows.map(({ m, avg: a, max, min, over, overN, pct }) => (
              <tr key={m.key}>
                <td>{m.label}</td><td className="r num">{fmtN(a, m.digits)}</td><td className={'r num ' + (out(m, max) ? 'red' : '')}>{fmtN(max, m.digits)}</td><td className="r num">{fmtN(min, m.digits)}</td><td className="r num muted">{m.rangeText}</td>
                <td className={'r num ' + (overN ? 'amber' : '')} style={{ fontWeight: overN ? 600 : 400 }}>{over}</td>
                <td style={{ paddingLeft: 40, width: 240 }}><div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: pct + '%', background: pct < 95 ? '#f59e0b' : undefined }} /></div><span className="num" style={{ width: 36, textAlign: 'right' }}>{pct}%</span></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
