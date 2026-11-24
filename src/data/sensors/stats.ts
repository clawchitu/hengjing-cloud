// 室内空气传感器的统计计算（纯函数，不依赖 React，单测直接覆盖）。
//
// 数据来源：ctrl 208 AirSensorDataHourGet 的小时数据。约定（docs/api/实测记录-1124.md、后端 11/24 答复）：
// - start_time / end_time / date 都是毫秒；date 是该小时起点的毫秒时间戳，hour 是北京时间小时数；
// - 65536 = 设备没有该数据（未初始化 / 无探头），-100 = 无效数据，二者都不参与统计（values.ts hourlyReading）；
// - 统计值（平均 / 最大 / 最小 / 达标率）由前端从小时数据算（改动文档第 7 条，负责人 Q13 确认），不再有「超标时长」。
// 分时、分天一律按北京时间（UTC+8，无夏令时）切，与浏览器所在时区无关，保证 hour 字段与 date 对得上。
import { hourlyReading } from '../../api/values'

export type SensorRange = '24小时' | '7日' | '30日'
export type MetricKey = 'temp' | 'hum' | 'dew' | 'pm25' | 'co2'
export const METRIC_KEYS: readonly MetricKey[] = ['temp', 'hum', 'dew', 'pm25', 'co2']

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS
/** 北京时间相对 UTC 的偏移 */
export const CST_OFFSET_MS = 8 * HOUR_MS

/** 208 一条小时记录（Reply 解码后的普通对象，字段名同生成代码） */
export interface HourRecord {
  id: number
  date: number
  hour: number
  temperature: number
  humidity: number
  dewPoint: number
  co2: number
  pm25: number
}

/** 一个小时的有效读数：null = 无数据（65536 / -100 / 缺失） */
export type Readings = Record<MetricKey, number | null>

export interface HourPoint extends Readings { /** 该小时起点（毫秒） */ ts: number }

export interface StatWindow {
  range: SensorRange
  /** 请求的 start_time（毫秒，含） */
  start: number
  /** 请求的 end_time（毫秒，即取数时刻） */
  end: number
  /** 图表的横轴槽位起点（毫秒）：24 小时为 24 个整点，7 / 30 日为每天北京时间 0 点 */
  slots: number[]
  /** 每个槽位的长度 */
  slotMs: number
}

const hourStart = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS
/** 北京时间当天 0 点（毫秒） */
export const cstDayStart = (ms: number) => Math.floor((ms + CST_OFFSET_MS) / DAY_MS) * DAY_MS - CST_OFFSET_MS

/**
 * 取数窗口。now 为取数时刻（毫秒）。
 * - 24小时：当前整点往前共 24 个整点（含当前小时），start = 23 小时前的整点；
 * - 7日 / 30日：今天（北京时间）往前共 7 / 30 天，start = 最早那天的 0 点。
 * end 一律是 now：当前小时 / 今天还没走完，只统计已有的数据。
 */
export function windowOf(range: SensorRange, now: number): StatWindow {
  if (range === '24小时') {
    const cur = hourStart(now)
    const slots = Array.from({ length: 24 }, (_, i) => cur - (23 - i) * HOUR_MS)
    return { range, start: slots[0], end: now, slots, slotMs: HOUR_MS }
  }
  const days = range === '7日' ? 7 : 30
  const today = cstDayStart(now)
  const slots = Array.from({ length: days }, (_, i) => today - (days - 1 - i) * DAY_MS)
  return { range, start: slots[0], end: now, slots, slotMs: DAY_MS }
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 北京时间的 HH:00 */
export const hourLabel = (ms: number) => `${pad2(new Date(ms + CST_OFFSET_MS).getUTCHours())}:00`
/** 北京时间的 MM-DD */
export const dayLabel = (ms: number) => { const d = new Date(ms + CST_OFFSET_MS); return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` }
/** 北京时间的 YYYY-MM-DD HH:MM */
export const dateTimeLabel = (ms: number) => new Date(ms + CST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
/** 北京时间的 HH:MM */
export const minuteLabel = (ms: number) => timeLabel(ms).slice(0, 5)
/** 北京时间的 HH:MM:SS */
export const timeLabel = (ms: number) => new Date(ms + CST_OFFSET_MS).toISOString().slice(11, 19)

/**
 * 设备读数的有效性（达标率口径经 Fable 复核，11/24）：65536（无数据）、-100（无效）、缺字段解码出的 0 都算无效，
 * 不进统计的分子也不进分母。proto3 不输出值为 0 的字段，缺省字段解码出来就是 0（实测 floor_temperature 即如此），
 * 所以所有指标（含温度）的 0 都按无效处理；湿度、CO₂ 不可能为负，负数也无效。温度、露点的负数照常有效。
 */
export function validReading(key: MetricKey, v: number | null): number | null {
  if (v === null || v === 0) return null
  if ((key === 'hum' || key === 'co2') && v < 0) return null
  return v
}

/** 一条记录 → 有效读数 */
export function readingsOf(r: Partial<HourRecord>): Readings {
  return {
    temp: validReading('temp', hourlyReading(r.temperature)),
    hum: validReading('hum', hourlyReading(r.humidity)),
    dew: validReading('dew', hourlyReading(r.dewPoint)),
    pm25: validReading('pm25', hourlyReading(r.pm25)),
    co2: validReading('co2', hourlyReading(r.co2)),
  }
}

/**
 * 208 记录 → 窗口内按时间排序的小时点。
 * - 只要这台设备的（id 缺省为 0 时不按 id 过滤）；date 不是有限数、不在 [start, end] 里的丢掉；date 取整到整点；
 * - 同一小时出现多条（接口没有说明哪条为准，已列入待问后端）：按字段合并——无效值（65536 / -100 / 缺省）不覆盖
 *   有效值；同一字段有多个有效值时取平均。结果与记录顺序无关，同一小时只计一次。
 */
export function toHourPoints(records: readonly Partial<HourRecord>[], deviceId: number, w: Pick<StatWindow, 'start' | 'end'>): HourPoint[] {
  const byHour = new Map<number, Record<MetricKey, { sum: number; n: number }>>()
  for (const r of records) {
    if (r.id && r.id !== deviceId) continue
    const d = r.date
    if (typeof d !== 'number' || !Number.isFinite(d) || d < w.start || d > w.end) continue
    const ts = hourStart(d)
    let acc = byHour.get(ts)
    if (!acc) { acc = Object.fromEntries(METRIC_KEYS.map((k) => [k, { sum: 0, n: 0 }])) as Record<MetricKey, { sum: number; n: number }>; byHour.set(ts, acc) }
    const v = readingsOf(r)
    for (const k of METRIC_KEYS) { const x = v[k]; if (x !== null) { acc[k].sum += x; acc[k].n += 1 } }
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([ts, acc]) => {
    const p = { ts } as HourPoint
    for (const k of METRIC_KEYS) p[k] = acc[k].n ? acc[k].sum / acc[k].n : null
    return p
  })
}

export interface Agg { avg: number; max: number; min: number; /** 有效小时数 */ n: number }

/** 有效值的平均 / 最大 / 最小；没有有效值为 null */
export function aggregate(values: readonly (number | null)[]): Agg | null {
  let n = 0, sum = 0, max = -Infinity, min = Infinity
  for (const v of values) {
    if (v === null) continue
    n += 1; sum += v
    if (v > max) max = v
    if (v < min) min = v
  }
  return n ? { avg: sum / n, max, min, n } : null
}

/** 标准范围 */
export interface Limits { lo?: number; hi: number }

export type Season = 'summer' | 'winter'
/**
 * 季节（温度标准范围按季节切换）：按北京时间月份，5–10 月为夏季，其余为冬季。
 * 页面上的「标准范围」列、阈值虚线、达标率都用同一个时刻（统计窗口的结束时刻 = 取数时刻）判定。
 */
export const seasonOf = (ms: number): Season => { const m = new Date(ms + CST_OFFSET_MS).getUTCMonth() + 1; return m >= 5 && m <= 10 ? 'summer' : 'winter' }

/**
 * 标准范围（五恒指南，经 Fable 复核 11/24）：温度冬季 18–22℃、夏季 24–26℃；湿度 40–60%；CO₂ ≤ 800 ppm；PM2.5 ≤ 35 μg/m³。
 * 露点指南未给，沿用演示版 ≤ 17.0℃。
 */
export function limitsOf(key: MetricKey, at: number): Limits {
  switch (key) {
    case 'temp': return seasonOf(at) === 'summer' ? { lo: 24, hi: 26 } : { lo: 18, hi: 22 }
    case 'hum': return { lo: 40, hi: 60 }
    case 'dew': return { hi: 17 }
    case 'pm25': return { hi: 35 }
    case 'co2': return { hi: 800 }
  }
}

/** 「标准范围」列的文字，与 limitsOf 同源 */
export const limitsText = (l: Limits, digits: number) => (l.lo !== undefined ? `${l.lo} – ${l.hi}` : `≤ ${digits ? l.hi.toFixed(digits) : l.hi}`)

/** 统计窗口里应有的小时数（按实际窗口：从 start 起到 end 为止的整点个数；24 小时档恒为 24） */
export const expectedHours = (w: Pick<StatWindow, 'start' | 'end'>) => Math.max(0, Math.floor((w.end - w.start) / HOUR_MS) + 1)
export const inRange = (l: Limits, v: number) => v <= l.hi && (l.lo === undefined || v >= l.lo)

export interface SummaryRow extends Agg {
  key: MetricKey
  /** 达标率（%，整数）= 落在标准范围内的有效小时数 ÷ 有效小时数（口径经 Fable 复核，11/24） */
  pct: number
}

/** 指标统计汇总：对窗口内全部有效小时值计算（7 / 30 日也按小时值算，不是日均值再平均） */
export function summarize(points: readonly HourPoint[], key: MetricKey, limits: Limits): SummaryRow | null {
  const vs = points.map((p) => p[key])
  const a = aggregate(vs)
  if (!a) return null
  const ok = vs.filter((v): v is number => v !== null && inRange(limits, v)).length
  // 只有全部达标才显示 100%；否则向下取整（199/200 显示 99%，不会四舍五入成 100%）
  return { key, ...a, pct: ok === a.n ? 100 : Math.floor((ok / a.n) * 100) }
}

export interface ChartSeries {
  labels: string[]
  /** 24 小时：每个整点的值，没有数据为 null（图上画成断点） */
  hourly?: (number | null)[]
  /** 7 / 30 日：每天的日均 / 日最高 / 日最低，没有数据的天为 null */
  daily?: { avg: (number | null)[]; max: (number | null)[]; min: (number | null)[] }
  /** 有没有任何有效值 */
  hasData: boolean
}

/** 图表数据：按窗口槽位对齐，24 小时逐时、7 / 30 日按天聚合 */
export function chartSeries(points: readonly HourPoint[], key: MetricKey, w: StatWindow): ChartSeries {
  const slotOf = (ts: number) => (w.slotMs === HOUR_MS ? hourStart(ts) : cstDayStart(ts))
  const buckets = new Map<number, (number | null)[]>()
  for (const p of points) {
    const s = slotOf(p.ts)
    const b = buckets.get(s)
    if (b) b.push(p[key]); else buckets.set(s, [p[key]])
  }
  if (w.slotMs === HOUR_MS) {
    const hourly = w.slots.map((s) => buckets.get(s)?.[0] ?? null)
    return { labels: w.slots.map(hourLabel), hourly, hasData: hourly.some((v) => v !== null) }
  }
  const aggs = w.slots.map((s) => aggregate(buckets.get(s) ?? []))
  return {
    labels: w.slots.map(dayLabel),
    daily: { avg: aggs.map((a) => a?.avg ?? null), max: aggs.map((a) => a?.max ?? null), min: aggs.map((a) => a?.min ?? null) },
    hasData: aggs.some((a) => a !== null),
  }
}
