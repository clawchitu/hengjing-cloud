// 室内空气传感器（S8）：ctrl 207 实时数据 + ctrl 208 小时数据（统计由前端算，见 src/data/sensors）。
// 当前项目用 useCurrentProject()（docs/分工.md 第 3 节第 6 条）：没有项目、项目离线、没有权限时不发 ctrl 请求。
// 只读页面，不调用任何写接口。无接口支撑的元素已去掉：楼层、离线传感器的「最后在线」、项目的最后在线时间、
// 指标统计汇总的「超标时长 / 超标天数」（改动文档第 7 条）。
import { useEffect, useState, type ReactNode } from 'react'
import { faBuilding, faLocationDot, faRotate, faTemperatureHalf, faDroplet, faTemperatureLow, faSmog, faLeaf, faDownload, faPlugCircleXmark, faTriangleExclamation, faLock, faCircleInfo, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { Chart, Icon, Seg, axis, tooltip } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import { defaultText } from '../api/errors'
import { useCurrentProject, type Project } from '../data/org'
import {
  chartSeries, dateTimeLabel, expectedHours, kpiOf, limitsOf, limitsText, minuteLabel, pickSensor, safeFileName, sensorTag, summarize, timeLabel, toCsv, useAirSensors, useSensorHours,
  type AirSensor, type ChartSeries, type CsvCell, type HoursView, type Limits, type MetricKey, type SensorRange, type SummaryRow,
} from '../data/sensors'
import type { DayPoint, HourPoint } from '../api'

export type Range = '24小时' | '7日' | '30日'

interface MetricDef { key: MetricKey; tab: string; label: string; unit: string; kpiUnit: string; icon: IconDefinition; color: string; bg: string; digits: number }
/** 指标（标准范围见 data/sensors/stats.ts limitsOf，按季节切换温度） */
export const METRICS: MetricDef[] = [
  { key: 'temp', tab: '温度', label: '温度 (°C)', unit: '°C', kpiUnit: '°C', icon: faTemperatureHalf, color: '#f97316', bg: '#fff7ed', digits: 1 },
  { key: 'hum', tab: '湿度', label: '湿度 (%RH)', unit: '%', kpiUnit: '%RH', icon: faDroplet, color: '#0891b2', bg: '#ecfeff', digits: 0 },
  { key: 'dew', tab: '露点', label: '露点 (°C)', unit: '°C', kpiUnit: '°C', icon: faTemperatureLow, color: '#6366f1', bg: '#eef2ff', digits: 1 },
  { key: 'pm25', tab: 'PM2.5', label: 'PM2.5 (μg/m³)', unit: '', kpiUnit: 'μg/m³', icon: faSmog, color: '#10b981', bg: '#ecfdf5', digits: 0 },
  { key: 'co2', tab: 'CO₂', label: 'CO₂ (ppm)', unit: 'ppm', kpiUnit: 'ppm', icon: faLeaf, color: '#f59e0b', bg: '#fffbeb', digits: 0 },
]
const out = (l: Limits, v: number) => v > l.hi || (l.lo !== undefined && v < l.lo)
/** 达标率口径（经 Fable 复核，11/24）：落在标准范围内的有效小时数 ÷ 有效小时数，三档都按小时值算 */
const PCT_HINT = '统计时段内，小时读数落在标准范围内的时间占比；无数据的小时不计入。'
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

/**
 * 指标统计汇总导出为 CSV：前几行说明项目、传感器、时间窗口与数据时间（208 刷新失败时注明），空一行后是汇总表。
 */
/** 汇总表的一行：r 为 null 表示装了该探头但统计时段内没有有效小时（显示「—」） */
interface StatRow { m: MetricDef; lim: Limits; r: SummaryRow | null }

function summaryCsv(o: { project: Project | null; sensor: AirSensor | undefined; range: SensorRange; start: number; end: number; stale: boolean; rows: readonly StatRow[]; expected: number }): string {
  const lines: CsvCell[][] = [
    ['项目', o.project ? `${o.project.name}（${o.project.code}）` : ''],
    ['传感器', o.sensor ? `${o.sensor.name}（${o.sensor.id}）` : ''],
    ['时间窗口', `${o.range}：${dateTimeLabel(o.start)} 至 ${dateTimeLabel(o.end)}（北京时间）`],
    ['数据时间', `${dateTimeLabel(o.end)}${o.stale ? '（统计刷新失败，为该时刻的数据）' : ''}`],
    ['达标率口径', PCT_HINT],
    [],
    ['指标', '平均值', '最大值', '最小值', '标准范围', '达标率', '有效小时数', '应有小时数'],
  ]
  for (const { m, lim, r } of o.rows) {
    const f = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(m.digits))
    lines.push([m.label, f(r?.avg), f(r?.max), f(r?.min), limitsText(lim, m.digits), r ? `${r.pct}%` : '—', r?.n ?? 0, o.expected])
  }
  return toCsv(lines)
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 单点（前后都没有数据）在不显示拐点的折线上看不见，单独画一个点 */
const withIsolated = (vs: readonly (number | null)[]) =>
  vs.map((v, i) => (v !== null && (vs[i - 1] ?? null) === null && (vs[i + 1] ?? null) === null ? { value: v, symbol: 'circle', symbolSize: 6 } : v))

function chartOption(m: MetricDef, l: Limits, s: ChartSeries) {
  const isDaily = !!s.daily
  const xs = s.labels
  // comfort thresholds drawn as flat dashed series (markLine collapses on a category axis)
  const thresholdSeries = [l.lo, l.hi].filter((v): v is number => v !== undefined).map((y) => ({
    name: y === l.hi ? `上限 ${y}` : `下限 ${y}`, type: 'line' as const, silent: true, showSymbol: false, data: xs.map(() => y), tooltip: { show: false },
    lineStyle: { color: '#94a3b8', type: [6, 6] as unknown as 'dashed', width: 1.2 }, itemStyle: { color: '#94a3b8' },
    endLabel: { show: true, formatter: y === l.hi ? `上限 ${y}` : `下限 ${y}`, color: '#64748b', fontSize: 11 },
  }))
  const line = (name: string, data: (number | null)[], color: string, width: number, dashed = false) => ({
    name, type: 'line' as const, smooth: isDaily ? true : 0.5, showSymbol: true, symbol: 'none', data: withIsolated(data),
    lineStyle: { color, width, ...(dashed ? { type: 'dashed' as const } : {}) }, itemStyle: { color },
  })
  return {
    tooltip,
    legend: isDaily ? { data: ['日均值', '日最高', '日最低'], top: 0, right: 0, icon: 'rect', itemWidth: 16, itemHeight: 3, textStyle: { color: '#64748b', fontSize: 11 } } : undefined,
    grid: { left: 44, right: 64, top: 30, bottom: 30 },
    xAxis: { type: 'category' as const, boundaryGap: false, data: xs, axisLabel: { ...axis.label, interval: isDaily ? 'auto' as const : 2 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: 'value' as const, scale: true,
      // keep the comfort thresholds inside the plotted range so the dashed lines are always visible
      min: (v: { min: number; max: number }) => { const lo = Math.min(v.min, l.lo ?? v.min); const pad = (Math.max(v.max, l.hi) - lo) * 0.08; return +(lo - pad).toFixed(m.digits) },
      max: (v: { min: number; max: number }) => { const hi = Math.max(v.max, l.hi); const pad = (hi - Math.min(v.min, l.lo ?? v.min)) * 0.08; return +(hi + pad).toFixed(m.digits) },
      axisLabel: axis.label, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    series: s.daily ? [
      line('日均值', s.daily.avg, '#f28c38', 2.6),
      line('日最高', s.daily.max, '#f43f5e', 1.2, true),
      line('日最低', s.daily.min, '#06b6d4', 1.2, true),
      ...thresholdSeries,
    ] : [line(m.tab, s.hourly ?? [], '#f28c38', 2.6), ...thresholdSeries],
  }
}

function PageHead({ project, right }: { project: Project | null; right?: ReactNode }) {
  const where = project ? [project.city, project.district].filter(Boolean).join(' · ') : ''
  return (
    <div className="page-head">
      <div><h1>室内空气传感器</h1>
        {project && <div className="sub" style={{ gap: 14 }}><span><Icon icon={faBuilding} /> {project.name}</span>{project.code && <span className="num">{project.code}</span>}{where && <span><Icon icon={faLocationDot} /> {where}</span>}{project.online ? <span className="green"><span className="dot" /> 在线</span> : <span className="red"><span className="dot" /> 离线</span>}{project.version && <span className="num">{project.version}</span>}</div>}
      </div>
      {right}
    </div>
  )
}

function Placeholder({ icon, title, text, onRetry, alert }: { icon: IconDefinition; title: string; text: string; onRetry?: () => void; alert?: boolean }) {
  return (
    <Card className="placeholder" role={alert ? 'alert' : 'status'}>
      <div className="ph-ico"><Icon icon={icon} /></div>
      <h3>{title}</h3>
      <p>{text}</p>
      {onRetry && <Button style={{ marginTop: 16 }} onClick={onRetry}>重试</Button>}
    </Card>
  )
}

/** 208 统计区的非就绪状态文案；就绪返回 null */
function hoursMessage(h: HoursView, cur: AirSensor | undefined): string | null {
  switch (h.kind) {
    case 'idle': return cur ? '传感器离线，暂无统计数据' : '暂无在线传感器'
    case 'forbidden': return '当前账号未开通统计数据权限'
    case 'loading': return '加载中…'
    case 'unavailable': return defaultText('unavailable')
    case 'error': return `统计数据加载失败：${h.error.message || defaultText('server')}`
    default: return null
  }
}

export default function Sensors() {
  const { project } = useCurrentProject()
  const { toast } = useApp()
  const view = useAirSensors(project)
  const [range, setRange] = useState<SensorRange>('24小时')
  const [selRaw, setSel] = useState('')
  const [metricRaw, setMetric] = useState<MetricKey>('temp')
  const sensors = view.kind === 'ready' ? view.sensors : []
  const cur = pickSensor(sensors, selRaw)
  const hours = useSensorHours(project, cur, range)

  // 统计都是几百个点以内的纯计算，每次渲染直接算。
  // 统计区的指标：装了该探头（207 有读数）或 208 里有过有效数据的（207 的 65536 只决定实时卡片，历史数据照样能看）；
  // 两边都没有（没装该探头）的指标整行隐藏。装了但统计时段内没有有效小时的，汇总显示「—」。
  const ready = hours.kind === 'ready' ? hours : null
  // 标准范围（温度按季节）用取数时刻判定：统计区用窗口结束时刻，卡片和 KPI 用 207 取数时刻
  const at = ready?.window.end ?? (view.kind === 'ready' ? view.updatedAt : 0)
  const statMetrics = ready && cur ? METRICS.filter((m) => cur[m.key] !== null || ready.points.some((p) => p[m.key] !== null)) : []
  const metric = statMetrics.find((m) => m.key === metricRaw) ?? statMetrics[0]
  const series = ready && metric ? chartSeries(ready.points, metric.key, ready.window) : null
  const rows: StatRow[] = ready ? statMetrics.map((m) => { const lim = limitsOf(m.key, at); return { m, lim, r: summarize(ready.points, m.key, lim) } }) : []
  const expected = ready ? expectedHours(ready.window) : 0
  const liveAt = view.kind === 'ready' ? view.updatedAt : at

  const hasList = view.kind === 'ready'
  const updated = view.kind === 'ready' || view.kind === 'empty'
    ? <span className="faint num" style={{ fontSize: 12 }}><Icon icon={faRotate} /> {view.kind === 'ready' && view.staleError ? `刷新失败，显示 ${timeLabel(view.updatedAt)} 的数据` : `${timeLabel(view.updatedAt)} 更新`}</span>
    : null
  const head = <PageHead project={project} right={(hasList || updated) && <div className="actions">{hasList && <Seg className="primary" value={range} options={['24小时', '7日', '30日']} onChange={setRange} />}{updated}</div>} />

  const body = (() => {
    switch (view.kind) {
      // 没有项目、项目离线时 Layout 不挂载设备页（S11），空态在 Layout；数据层照样不发请求，这里只留页头兜底
      case 'no-project': case 'offline': return <></>
      case 'forbidden': return <Placeholder icon={faLock} title="未开通空气传感器数据" text="当前账号没有读取空气传感器数据的权限，请联系管理员开通。" />
      case 'loading': return <Placeholder icon={faSmog} title="正在读取" text="正在从控制屏读取空气传感器数据…" />
      case 'unavailable': return <Placeholder icon={faPlugCircleXmark} title="控制屏未连接" text="控制屏暂时无法连接，稍后会自动重试。" />
      case 'error': return <Placeholder alert icon={faTriangleExclamation} title="空气传感器数据加载失败" text={view.error.message || defaultText('server')} onRetry={view.retry} />
      case 'empty': return <Placeholder icon={faSmog} title="暂无空气传感器数据" text="该项目暂时没有可显示的空气传感器。" />
      default: return null
    }
  })()
  if (body) return <div className="page">{head}{body}</div>

  const on = sensors.filter((s) => s.online)
  // KPIs: metrics that at least one online sensor measures
  const kpis = METRICS.map((m) => ({ m, s: kpiOf(sensors, m.key) })).filter((k): k is { m: MetricDef; s: NonNullable<ReturnType<typeof kpiOf>> } => k.s !== null)
  const tag = (t: string) => t === '良好' ? 'green' as const : t === '离线' ? 'gray' as const : 'orange' as const
  const msg = hoursMessage(hours, cur)
  const chartMsg = msg ?? (!metric || (series && !series.hasData) ? '该时段暂无数据' : null)
  const tableMsg = msg ?? (rows.every((x) => x.r === null) ? '该时段暂无统计数据' : null)
  const onExport = () => {
    if (!ready) return
    const name = safeFileName(`空气质量统计_${cur?.name ?? ''}_${range}`, 'csv')
    download(name, summaryCsv({ project, sensor: cur, range, start: ready.window.start, end: ready.window.end, stale: !!ready.staleError, rows, expected }))
    toast(`已导出：${name}`)
  }

  return (
    <div className="page">
      {head}
      {kpis.length > 0 && <div className="hj-grid" style={{ gridTemplateColumns: `repeat(${Math.max(3, kpis.length)}, minmax(0, 1fr))`, marginBottom: 20 }}>
        {kpis.map(({ m, s }) => (
          <Card key={m.key} className="kpi">
            <div className="k-label">平均 {m.tab}<span className="k-ico" style={{ background: m.bg, color: m.color }}><Icon icon={m.icon} /></span></div>
            <div className="k-val num">{fmtN(s.avg, m.digits)}<small>{m.kpiUnit}</small></div>
            <div className="k-foot" style={{ color: 'var(--text-2)' }}>最高 <span className={s.max > limitsOf(m.key, liveAt).hi ? 'red' : ''}>{fmtN(s.max, m.digits)}</span> · 最低 {fmtN(s.min, m.digits)}{s.n < on.length && <span className="faint"> · {s.n}/{on.length} 台具备</span>}</div>
          </Card>
        ))}
      </div>}
      <Card style={{ marginBottom: 20 }}>
        <CardHeader><CardTitle>传感器列表 <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>{sensors.length} 台</span></CardTitle>
          <div className="legend-dots"><span><span className="dot green" style={{ width: 7, height: 7 }} />良好</span><span><span className="dot" style={{ color: '#f59e0b', width: 7, height: 7 }} />超标</span><span><span className="dot" style={{ color: '#cbd5e1', width: 7, height: 7 }} />离线</span></div></CardHeader>
        <div className="hj-grid g4">
          {sensors.map((s) => {
            const t = sensorTag(s, liveAt)
            const pick = () => (s.online ? setSel(s.key) : toast(`${s.name} 离线，暂无实时数据`, true))
            return (
              <div key={s.key} role="button" tabIndex={0} aria-pressed={s.key === cur?.key} className={'sensor' + (s.key === cur?.key ? ' on' : '') + (!s.online ? ' off' : '')}
                onClick={pick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick() } }}>
                <div className="sh"><div><b>{s.name}</b>{s.id > 0 && <small className="num">{s.id}</small>}</div><Badge variant={tag(t)}>{t}</Badge></div>
                <div className="sv num">
                  {s.online ? <>
                    {s.temp !== null && <div><span>温度</span><b>{s.temp.toFixed(1)}°</b></div>}
                    {s.hum !== null && <div><span>湿度</span><b>{Math.round(s.hum)}%</b></div>}
                    {s.dew !== null && <div><span>露点</span><b>{s.dew.toFixed(1)}°</b></div>}
                    {s.pm25 !== null && <div><span>PM2.5</span><b className={s.pm25 > limitsOf('pm25', liveAt).hi ? 'orange' : ''}>{Math.round(s.pm25)}</b></div>}
                    {s.co2 !== null && <div style={{ gridColumn: 'span 2' }}><span>CO₂</span><b className={s.co2 > limitsOf('co2', liveAt).hi ? 'orange' : ''}>{Math.round(s.co2).toLocaleString()}<small>ppm</small></b></div>}
                    {s.pm25 === null && s.co2 === null && <div className="nocap" style={{ gridColumn: 'span 3' }}>该型号无 PM2.5 / CO₂ 探头</div>}
                  </> : <>
                    <div><span>温度</span><b>—</b></div>
                    <div><span>湿度</span><b>—</b></div>
                    <div><span>露点</span><b>—</b></div>
                  </>}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
      <Card style={{ marginBottom: 20 }}>
        <CardHeader><div><CardTitle>数据统计 · {cur?.name ?? '—'}</CardTitle><CardDescription>{range === '24小时' ? '24 小时趋势（逐时）' : `近${range === '7日' ? ' 7 ' : ' 30 '}日趋势（日均 / 日最高 / 日最低）`}，虚线为舒适区阈值</CardDescription></div>
          {metric && <Seg value={metric.tab} options={statMetrics.map((m) => m.tab)} onChange={(t) => setMetric(METRICS.find((m) => m.tab === t)!.key)} />}</CardHeader>
        {ready?.staleError && <div role="alert" className="row" style={{ gap: 10, marginBottom: 10, fontSize: 12.5, color: 'var(--amber)' }}><Icon icon={faTriangleExclamation} />统计刷新失败，显示 {minuteLabel(ready.window.end)} 的数据<Button onClick={ready.retry}>重试</Button></div>}
        {!chartMsg && metric && series ? <Chart option={chartOption(metric, limitsOf(metric.key, at), series)} height={300} />
          : <div style={{ height: 300 }} className="chart-loading" role={hours.kind === 'error' ? 'alert' : 'status'}>
            <div style={{ textAlign: 'center' }}>{chartMsg}{hours.kind === 'error' && <div style={{ marginTop: 12 }}><Button onClick={hours.retry}>重试</Button></div>}</div>
          </div>}
      </Card>
      <Card pad={false}>
        <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14 }}><div><CardTitle>指标统计汇总</CardTitle><CardDescription>{cur?.name ?? '—'} · {range}</CardDescription></div><Button disabled={!!tableMsg} onClick={onExport}><Icon icon={faDownload} />导出</Button></CardHeader>
        <Table>
          <TableHeader><TableRow><TableHead>指标</TableHead><TableHead className="text-right">平均值</TableHead><TableHead className="text-right">最大值</TableHead><TableHead className="text-right">最小值</TableHead><TableHead className="text-right">标准范围</TableHead><TableHead style={{ paddingLeft: 40 }}>达标率<Tooltip><TooltipTrigger asChild><span role="img" tabIndex={0} aria-label={`达标率口径：${PCT_HINT}`} className="faint" style={{ marginLeft: 4, cursor: 'help' }}><Icon icon={faCircleInfo} /></span></TooltipTrigger><TooltipContent side="top">{PCT_HINT}</TooltipContent></Tooltip></TableHead></TableRow></TableHeader>
          <TableBody>
            {tableMsg ? <TableRow><TableCell colSpan={6} className="muted" style={{ textAlign: 'center' }}>{tableMsg}</TableCell></TableRow>
              : rows.map(({ m, lim, r }) => (
                <TableRow key={m.key}>
                  <TableCell>{m.label}</TableCell><TableCell className="num text-right">{r ? fmtN(r.avg, m.digits) : '—'}</TableCell><TableCell className={'num text-right ' + (r && out(lim, r.max) ? 'red' : '')}>{r ? fmtN(r.max, m.digits) : '—'}</TableCell><TableCell className="num text-right">{r ? fmtN(r.min, m.digits) : '—'}</TableCell><TableCell className="num text-right muted">{limitsText(lim, m.digits)}</TableCell>
                  <TableCell style={{ paddingLeft: 40, width: 240 }}>
                    {r ? <div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: r.pct + '%', background: r.pct < 95 ? '#f59e0b' : undefined }} /></div><span className="num" style={{ width: 36, textAlign: 'right' }}>{r.pct}%</span></div>
                      : <span className="num muted">—</span>}
                    {/* 有效小时不到应有小时数一半：照样显示达标率，提示数据不全 */}
                    {r && r.n * 2 < expected && <div className="faint num" style={{ fontSize: 11.5, marginTop: 4 }}>有效 {r.n}/{expected} 小时</div>}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
