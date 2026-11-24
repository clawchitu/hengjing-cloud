// 208 小时数据的统计计算：取数窗口（毫秒、北京时间分时分天）、无效值（65536 / -100 / 缺失）、平均 / 最值 / 达标率、按天聚合。
import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage } from '../../../api/ctrl'
import * as pb from '../../../api/gen/ctrl200_pb.js'
import {
  aggregate, chartSeries, cstDayStart, dayLabel, DAY_MS, expectedHours, hourLabel, HOUR_MS, limitsOf, limitsText, readingsOf, seasonOf, summarize, timeLabel, toHourPoints, windowOf,
  type HourRecord,
} from '../stats'

/** 北京时间 → 毫秒 */
const cst = (s: string) => Date.parse(s + '+08:00')
// 实测记录：date 1795474800000 = 11/24 07:00 CST，hour = 7
const NOW = cst('2026-11-24T07:42:10')
const M = { temp: { lo: 24, hi: 27 }, co2: { hi: 1000 }, pm25: { hi: 35 } }
const rec = (date: number, v: Partial<HourRecord> = {}): Partial<HourRecord> => ({
  id: 9, date, hour: new Date(date + 8 * HOUR_MS).getUTCHours(), temperature: 25, humidity: 50, dewPoint: 14, co2: 600, pm25: 10, ...v,
})

describe('时间：毫秒、北京时间', () => {
  it('实测样本：1795474800000 是北京时间 11/24 07:00', () => {
    expect(cst('2026-11-24T07:00:00')).toBe(1795474800000)
    expect(hourLabel(1795474800000)).toBe('07:00')
    expect(dayLabel(1795474800000)).toBe('11-24')
    expect(timeLabel(NOW)).toBe('07:42:10')
  })

  it('北京时间 0 点切天：UTC 前一天 16:00 起算今天', () => {
    expect(cstDayStart(cst('2026-11-24T00:00:00'))).toBe(cst('2026-11-24T00:00:00'))
    expect(cstDayStart(cst('2026-11-24T23:59:59'))).toBe(cst('2026-11-24T00:00:00'))
    expect(cstDayStart(cst('2026-11-23T23:59:59'))).toBe(cst('2026-11-23T00:00:00'))
  })

  it('24 小时窗口：含当前小时共 24 个整点，start 是 23 小时前的整点，end 是当前时刻（都是毫秒）', () => {
    const w = windowOf('24小时', NOW)
    expect(w.slots).toHaveLength(24)
    expect(w.slots[23]).toBe(cst('2026-11-24T07:00:00'))
    expect(w.slots[0]).toBe(cst('2026-11-23T08:00:00'))
    expect(w.start).toBe(w.slots[0])
    expect(w.end).toBe(NOW)
    // 毫秒量级（秒的话只有 10 位数，实测传秒返回空）
    expect(String(w.start)).toHaveLength(13)
    expect(w.slots.map(hourLabel).slice(0, 3)).toEqual(['08:00', '09:00', '10:00'])
  })

  it('7 日 / 30 日窗口：从最早那天的北京时间 0 点到当前时刻', () => {
    const w7 = windowOf('7日', NOW)
    expect(w7.slots).toHaveLength(7)
    expect(w7.start).toBe(cst('2026-11-18T00:00:00'))
    expect(w7.slots[6]).toBe(cst('2026-11-24T00:00:00'))
    expect(w7.end).toBe(NOW)
    expect(w7.slotMs).toBe(DAY_MS)
    const w30 = windowOf('30日', NOW)
    expect(w30.slots).toHaveLength(30)
    expect(w30.start).toBe(cst('2026-10-26T00:00:00'))
    expect(w30.slots.map(dayLabel).at(-1)).toBe('11-24')
  })
})

describe('无效值', () => {
  it('65536（无数据）、-100（无效）、NaN、缺失都是 null；温度 / 露点的负数是有效读数', () => {
    expect(readingsOf({ temperature: 65536, humidity: -100, dewPoint: NaN, co2: undefined, pm25: 65536 })).toEqual({ temp: null, hum: null, dew: null, co2: null, pm25: null })
    expect(readingsOf({ temperature: -5.5, dewPoint: -2, humidity: 65535 })).toMatchObject({ temp: -5.5, dew: -2, hum: 65535 })
  })

  it('缺字段解码出的 0 一律无效（所有指标，含温度）；湿度、CO₂ 的负数也无效', () => {
    expect(readingsOf({ temperature: 0, humidity: 0, dewPoint: 0, co2: 0, pm25: 0 })).toEqual({ temp: null, hum: null, dew: null, co2: null, pm25: null })
    expect(readingsOf({ humidity: -3, co2: -1 })).toMatchObject({ hum: null, co2: null })
    expect(readingsOf({ humidity: 1, co2: 1, pm25: 1, temperature: 0.1 })).toMatchObject({ hum: 1, co2: 1, pm25: 1, temp: 0.1 })
  })

  it('真实 protobuf：缺省的 co2 / humidity 解码成 0，按无效处理，不拉低均值', () => {
    const date = cst('2026-11-24T05:00:00')
    const body = encodeMessage(pb.TPAirSensorDataHourGetReplySchema, { data: [{ id: 9, date, hour: 5, temperature: 25, dewPoint: 14, pm25: 10 }, { id: 9, date: date + HOUR_MS, hour: 6, temperature: 25, humidity: 50, co2: 600, dewPoint: 14, pm25: 10 }] })
    const r = decodeReply(pb.TPAirSensorDataHourGetReplySchema, body) as { data: Partial<HourRecord>[] }
    expect(r.data[0].co2).toBe(0)
    const pts = toHourPoints(r.data, 9, windowOf('24小时', NOW))
    expect(summarize(pts, 'co2', M.co2)).toMatchObject({ avg: 600, min: 600, n: 1 })
    expect(summarize(pts, 'hum', { lo: 40, hi: 60 })).toMatchObject({ avg: 50, n: 1 })
  })

  it('无效值不参与平均 / 最值', () => {
    expect(aggregate([20, null, 30, null])).toEqual({ avg: 25, max: 30, min: 20, n: 2 })
    expect(aggregate([null, null])).toBeNull()
    expect(aggregate([])).toBeNull()
  })
})

describe('toHourPoints：208 记录 → 窗口内的小时点', () => {
  const w = windowOf('24小时', NOW)

  it('按时间排序；窗口外、date 非数字、别的设备的记录丢掉；id 缺省（0）不过滤', () => {
    const t = (h: string) => cst(`2026-11-24T${h}:00`)
    const pts = toHourPoints([
      rec(t('05:00')), rec(t('03:00')),
      rec(cst('2026-11-23T07:00:00')), // 窗口前
      rec(t('08:00')), // 窗口后（未来）
      rec(t('04:00'), { id: 77 }), // 别的设备
      { ...rec(t('06:00')), id: 0 },
      { ...rec(t('02:00')), date: undefined },
    ], 9, w)
    expect(pts.map((p) => hourLabel(p.ts))).toEqual(['03:00', '05:00', '06:00'])
  })

  it('把秒当成毫秒的记录不会混进来（落在 1970 年，窗口外）', () => {
    expect(toHourPoints([rec(1795474800)], 9, w)).toEqual([])
  })

  it('同一小时多条：只计一次；date 不在整点的取整到整点；同字段多个有效值取平均', () => {
    const t = cst('2026-11-24T05:00:00')
    const pts = toHourPoints([rec(t, { temperature: 20 }), rec(t + 60_000, { temperature: 26 })], 9, w)
    expect(pts).toHaveLength(1)
    expect(pts[0]).toMatchObject({ ts: t, temp: 23 })
  })

  it('同一小时多条：无效值（65536 / -100 / 缺省 0）不覆盖有效值，按字段合并；与记录顺序无关', () => {
    const t = cst('2026-11-24T05:00:00')
    const a = rec(t, { temperature: 25, humidity: 65536, co2: 600, pm25: 65536 })
    const b = rec(t, { temperature: -100, humidity: 55, co2: 0, pm25: 12 })
    const ab = toHourPoints([a, b], 9, w)
    const ba = toHourPoints([b, a], 9, w)
    expect(ab).toEqual([{ ts: t, temp: 25, hum: 55, dew: 14, co2: 600, pm25: 12 }])
    expect(ba).toEqual(ab)
    // 有效值冲突也与顺序无关（取平均）
    const c = rec(t, { temperature: 21 })
    expect(toHourPoints([a, c], 9, w)).toEqual(toHourPoints([c, a], 9, w))
    expect(toHourPoints([a, c], 9, w)[0].temp).toBe(23)
  })
})


describe('summarize：指标统计汇总（平均 / 最大 / 最小 / 达标率）', () => {
  const w = windowOf('24小时', NOW)
  const at = (h: number) => cst('2026-11-24T00:00:00') + h * HOUR_MS

  it('只算有效小时；达标率 = 有效小时里在标准范围内的比例', () => {
    const pts = toHourPoints([
      rec(at(1), { temperature: 23 }), // 低于下限
      rec(at(2), { temperature: 25 }),
      rec(at(3), { temperature: 65536 }), // 无数据
      rec(at(4), { temperature: 26 }),
      rec(at(5), { temperature: 28 }), // 高于上限
      rec(at(6), { temperature: -100 }), // 无效
    ], 9, w)
    const r = summarize(pts, 'temp', M.temp)!
    expect(r.n).toBe(4)
    expect(r.avg).toBeCloseTo(25.5)
    expect(r.max).toBe(28)
    expect(r.min).toBe(23)
    expect(r.pct).toBe(50)
  })

  it('边界值算达标（≤ 上限、≥ 下限）；没有下限的只看上限', () => {
    const pts = toHourPoints([rec(at(1), { temperature: 24, co2: 1000 }), rec(at(2), { temperature: 27, co2: 1001 })], 9, w)
    expect(summarize(pts, 'temp', M.temp)!.pct).toBe(100)
    expect(summarize(pts, 'co2', M.co2)!.pct).toBe(50)
  })

  it('达标率：只有全部达标才是 100%，否则向下取整（199/200 → 99%）', () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ ts: i, temp: i === 0 ? 30 : 25, hum: null, dew: null, pm25: null, co2: null }))
    expect(summarize(pts, 'temp', M.temp)!.pct).toBe(99)
    expect(summarize(pts.slice(1), 'temp', M.temp)!.pct).toBe(100)
    const third = [25, 25, 30].map((v, i) => ({ ts: i, temp: v, hum: null, dew: null, pm25: null, co2: null }))
    expect(summarize(third, 'temp', M.temp)!.pct).toBe(66)
  })

  it('全是 65536（无探头）→ 该指标没有汇总行', () => {
    const pts = toHourPoints([rec(at(1), { pm25: 65536 }), rec(at(2), { pm25: 65536 })], 9, w)
    expect(summarize(pts, 'pm25', M.pm25)).toBeNull()
    expect(summarize([], 'temp', M.temp)).toBeNull()
  })

  it('7 / 30 日按全部小时值算，不是日均值再平均', () => {
    const w7 = windowOf('7日', NOW)
    const d = (day: number, h: number) => cst('2026-11-18T00:00:00') + day * DAY_MS + h * HOUR_MS
    // 第一天 3 个小时都是 20，第二天 1 个小时 30：按小时平均 22.5，按日均再平均会是 25
    const pts = toHourPoints([rec(d(0, 1), { temperature: 20 }), rec(d(0, 2), { temperature: 20 }), rec(d(0, 3), { temperature: 20 }), rec(d(1, 1), { temperature: 30 })], 9, w7)
    expect(summarize(pts, 'temp', M.temp)!.avg).toBeCloseTo(22.5)
  })
})

describe('chartSeries：24 小时逐时 / 7、30 日按天聚合', () => {
  it('24 小时：24 个槽位对齐整点，没有数据的小时为 null（画成断点）', () => {
    const w = windowOf('24小时', NOW)
    const pts = toHourPoints([rec(cst('2026-11-24T06:00:00'), { humidity: 55 }), rec(cst('2026-11-24T07:00:00'), { humidity: 65536 })], 9, w)
    const s = chartSeries(pts, 'hum', w)
    expect(s.labels).toHaveLength(24)
    expect(s.labels.at(-1)).toBe('07:00')
    expect(s.hourly!.at(-2)).toBe(55)
    expect(s.hourly!.at(-1)).toBeNull()
    expect(s.hourly!.filter((v) => v !== null)).toEqual([55])
    expect(s.hasData).toBe(true)
  })

  it('7 日：按北京时间分天求日均 / 日最高 / 日最低，跨 UTC 日界的小时归到正确的天', () => {
    const w = windowOf('7日', NOW)
    const pts = toHourPoints([
      rec(cst('2026-11-23T00:00:00'), { temperature: 22 }), // 北京时间 23 日 0 点（UTC 22 日 16:00）
      rec(cst('2026-11-23T12:00:00'), { temperature: 26 }),
      rec(cst('2026-11-23T23:00:00'), { temperature: 65536 }),
      rec(cst('2026-11-24T01:00:00'), { temperature: 30 }),
    ], 9, w)
    const s = chartSeries(pts, 'temp', w)
    expect(s.labels).toEqual(['11-18', '11-19', '11-20', '11-21', '11-22', '11-23', '11-24'])
    expect(s.daily!.avg).toEqual([null, null, null, null, null, 24, 30])
    expect(s.daily!.max.slice(5)).toEqual([26, 30])
    expect(s.daily!.min.slice(5)).toEqual([22, 30])
  })

  it('全是无效值 → hasData=false（页面显示「该时段暂无数据」）', () => {
    const w = windowOf('30日', NOW)
    const s = chartSeries(toHourPoints([rec(cst('2026-11-20T10:00:00'), { co2: 65536 })], 9, w), 'co2', w)
    expect(s.labels).toHaveLength(30)
    expect(s.hasData).toBe(false)
    expect(chartSeries([], 'co2', windowOf('24小时', NOW)).hasData).toBe(false)
  })
})

describe('标准范围（五恒指南）与应有小时数', () => {
  it('温度按北京时间月份切换：5–10 月夏季 24–26，其余冬季 18–22；月界按北京时间', () => {
    expect(seasonOf(cst('2026-05-01T00:00:00'))).toBe('summer')
    expect(seasonOf(cst('2026-10-31T23:59:59'))).toBe('summer')
    expect(seasonOf(cst('2026-11-01T00:00:00'))).toBe('winter')
    expect(seasonOf(cst('2026-04-30T23:59:59'))).toBe('winter')
    // UTC 还在 4 月 30 日 16:00，北京时间已是 5 月 1 日 0 点
    expect(seasonOf(Date.parse('2026-04-30T16:00:00Z'))).toBe('summer')
    expect(limitsOf('temp', cst('2026-07-01T12:00:00'))).toEqual({ lo: 24, hi: 26 })
    expect(limitsOf('temp', cst('2026-01-15T10:00:00'))).toEqual({ lo: 18, hi: 22 })
  })

  it('湿度 40–60、CO₂ ≤ 800、PM2.5 ≤ 35、露点 ≤ 17.0；「标准范围」列文字同源', () => {
    expect(limitsOf('hum', NOW)).toEqual({ lo: 40, hi: 60 })
    expect(limitsOf('co2', NOW)).toEqual({ hi: 800 })
    expect(limitsOf('pm25', NOW)).toEqual({ hi: 35 })
    expect(limitsText(limitsOf('temp', NOW), 1)).toBe('18 – 22')
    expect(limitsText(limitsOf('co2', NOW), 0)).toBe('≤ 800')
    expect(limitsText(limitsOf('dew', NOW), 1)).toBe('≤ 17.0')
  })

  it('应有小时数按实际窗口：24 小时档 24；7 / 30 日到当前小时为止', () => {
    expect(expectedHours(windowOf('24小时', NOW))).toBe(24)
    expect(expectedHours(windowOf('7日', NOW))).toBe(6 * 24 + 8) // 今天 00:00–07:00 共 8 个整点
    expect(expectedHours(windowOf('30日', NOW))).toBe(29 * 24 + 8)
    expect(expectedHours(windowOf('7日', cst('2026-11-24T23:59:59')))).toBe(168)
    expect(expectedHours(windowOf('30日', cst('2026-11-24T23:00:00')))).toBe(720)
  })
})
