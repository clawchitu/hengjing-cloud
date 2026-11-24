// 房间温控统计图：ctrl 209（RoomTemperatureDataHourGet）的小时数据 → 图表数据。
// - start_time / end_time 用毫秒（实测记录 Q7①）；date 是该小时起点的毫秒时间戳，hour 是北京时间小时；
// - -100 与 65536 为无效值（文档 4.9、后端答复⑪），画成断点、不参与日均；
// - 24 小时：最近 24 个整点逐时；7 日 / 30 日：按北京时间自然日取日均值。
import type { CtrlReply } from '@/api/ctrl'
import { hourlyReading } from '@/api/values'

export type StatsRange = '24小时' | '7日' | '30日'

/** 图表数据：xs 横轴，rows 每个点 [温度, 露点, 湿度]，null 为断点 */
export interface ChartData { xs: string[]; rows: (number | null)[][]; hourly: boolean }

const HOUR = 3600_000
const DAY = 24 * HOUR
const CST = 8 * HOUR
const pad = (n: number) => String(n).padStart(2, '0')

/** 统计查询的时间窗（毫秒）。24 小时：从 23 小时前的整点到现在；N 日：从 N−1 天前的北京时间零点到现在 */
export function statsWindow(range: StatsRange, now: number): { startTime: number; endTime: number } {
  if (range === '24小时') {
    const hourStart = Math.floor(now / HOUR) * HOUR
    return { startTime: hourStart - 23 * HOUR, endTime: now }
  }
  const days = range === '7日' ? 7 : 30
  const dayStart = Math.floor((now + CST) / DAY) * DAY - CST
  return { startTime: dayStart - (days - 1) * DAY, endTime: now }
}

type Point = CtrlReply<209>['data'][number]
const triple = (p: Point) => [hourlyReading(p.temperature), hourlyReading(p.dewPoint), hourlyReading(p.humidity)]

function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null)
  return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : null
}

/** 209 回复 → 图表数据（横轴按时间窗补齐，缺的点为 null） */
export function toChartData(reply: CtrlReply<209>, range: StatsRange, now: number): ChartData {
  const { startTime } = statsWindow(range, now)
  const points = (reply.data ?? []).filter((p) => Number.isFinite(p.date))
  if (range === '24小时') {
    const byHour = new Map(points.map((p) => [Math.floor(p.date / HOUR) * HOUR, p]))
    const xs: string[] = []
    const rows: (number | null)[][] = []
    for (let i = 0; i < 24; i++) {
      const t = startTime + i * HOUR
      xs.push(`${pad(new Date(t + CST).getUTCHours())}:00`)
      const p = byHour.get(t)
      rows.push(p ? triple(p) : [null, null, null])
    }
    return { xs, rows, hourly: true }
  }
  const days = range === '7日' ? 7 : 30
  const buckets: (number | null)[][][] = Array.from({ length: days }, () => [])
  for (const p of points) {
    const i = Math.floor((p.date - startTime) / DAY)
    if (i >= 0 && i < days) buckets[i].push(triple(p))
  }
  const xs = buckets.map((_, i) => {
    const d = new Date(startTime + i * DAY + CST)
    return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  })
  const rows = buckets.map((b) => [0, 1, 2].map((k) => mean(b.map((r) => r[k]))))
  return { xs, rows, hourly: false }
}
