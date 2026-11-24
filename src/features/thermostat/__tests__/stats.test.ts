// ctrl 209 小时数据 → 图表：毫秒时间窗、北京时间小时与日期、-100 / 65536 断点、日均跳过无效值。
import { describe, expect, it } from 'vitest'
import type { CtrlReply } from '@/api/ctrl'
import { statsWindow, toChartData } from '../stats'

const HOUR = 3600_000
// 2026-11-24 10:30 北京时间
const NOW = Date.UTC(2026, 10, 24, 2, 30)
const pt = (date: number, o: Record<string, number> = {}) => ({ id: 1, date, hour: 0, temperature: 22, floorTemperature: 0, humidity: 60, dewPoint: 13.9, co2: 580, pm25: 5, ...o })
const reply = (data: ReturnType<typeof pt>[]) => ({ data }) as CtrlReply<209>

describe('统计时间窗（毫秒）', () => {
  it('24 小时：23 小时前的整点到现在', () => {
    expect(statsWindow('24小时', NOW)).toEqual({ startTime: Date.UTC(2026, 10, 23, 3), endTime: NOW })
  })
  it('7 日 / 30 日：从 N−1 天前的北京时间零点开始', () => {
    expect(statsWindow('7日', NOW).startTime).toBe(Date.UTC(2026, 10, 17, 16)) // 11/18 00:00 CST
    expect(statsWindow('30日', NOW).startTime).toBe(Date.UTC(2026, 9, 25, 16)) // 10/26 00:00 CST
  })
})

describe('209 → 图表', () => {
  it('24 小时：24 个点，横轴是北京时间整点，缺的小时和无效值是断点', () => {
    const start = statsWindow('24小时', NOW).startTime
    const d = toChartData(reply([pt(start), pt(start + 5 * HOUR, { temperature: -100, humidity: 65536 }), pt(start + 23 * HOUR, { temperature: 23.5 })]), '24小时', NOW)
    expect(d.hourly).toBe(true)
    expect(d.xs).toHaveLength(24)
    expect(d.xs[0]).toBe('11:00')
    expect(d.xs[23]).toBe('10:00')
    expect(d.rows[0][0]).toBe(22)
    expect(d.rows[1]).toEqual([null, null, null])
    expect(d.rows[5][0]).toBeNull()
    expect(d.rows[5][2]).toBeNull()
    expect(d.rows[23][0]).toBe(23.5)
  })
  it('7 日：按北京时间自然日取均值，无效值不参与', () => {
    const { startTime } = statsWindow('7日', NOW)
    const d = toChartData(reply([pt(startTime + HOUR, { temperature: 20 }), pt(startTime + 2 * HOUR, { temperature: 24 }), pt(startTime + 3 * HOUR, { temperature: -100 }), pt(startTime + 6 * 24 * HOUR, { temperature: 21 })]), '7日', NOW)
    expect(d.hourly).toBe(false)
    expect(d.xs).toEqual(['11-18', '11-19', '11-20', '11-21', '11-22', '11-23', '11-24'])
    expect(d.rows[0][0]).toBe(22)
    expect(d.rows[1]).toEqual([null, null, null])
    expect(d.rows[6][0]).toBe(21)
  })
  it('窗口外的点丢弃', () => {
    const { startTime } = statsWindow('7日', NOW)
    const d = toChartData(reply([pt(startTime - HOUR, { temperature: 99 })]), '7日', NOW)
    expect(d.rows.every((r) => r[0] === null)).toBe(true)
  })
})
