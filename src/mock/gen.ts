// Per-project mock data. PRJ-10241 uses the base arrays verbatim (so it matches the design PDF);
// other projects get deterministic variations, plus hand-made variants that exercise every UI branch:
//   PRJ-10242  sensors with mixed probes (some lack PM2.5, some lack CO₂, one lacks both)
//   PRJ-10243  sensors with neither PM2.5 nor CO₂
//   PRJ-10252 / PRJ-30057 / PRJ-50102 / PRJ-60014  新风单机版 (程序编码 12): no room panels, fresh-air 运行设置,
//              units in modes 2 / 13 / 23 / 33 (露点 or 湿度) and other modes (湿度 only)
import { connections, freshAirUnits, rooms, sensors, type Conn, type FreshAir, type Room, type Sensor } from './data'
import { hasRooms, isStandalone, projects, type Project } from './org'

import { DEW_MODES } from '../data/constants'
export { DEW_MODES }

function rng(key: string) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const r1 = (v: number) => +v.toFixed(1)
const proj = (id: string): Project => projects.find((p) => p.id === id) ?? projects[0]

function sensorTag(s: Sensor): Sensor['tag'] {
  if (!s.online) return '离线'
  if (s.co2 !== undefined && s.co2 > 1000) return 'CO₂ 超标'
  if (s.pm25 !== undefined && s.pm25 > 20) return 'PM2.5 偏高'
  return '良好'
}
const strip = (s: Sensor, pm: boolean, co2: boolean): Sensor => {
  const x: Sensor = { ...s }
  if (!pm) delete x.pm25
  if (!co2) delete x.co2
  return { ...x, tag: sensorTag(x) }
}

// ------------------------------------------------------------------ sensors
export function sensorsFor(projectId: string): Sensor[] {
  const p = proj(projectId)
  if (projectId === 'PRJ-10241') return sensors
  if (projectId === 'PRJ-10242') {
    // [pm25, co2] capability per sensor
    const caps: [boolean, boolean][] = [[true, true], [false, true], [true, false], [false, false], [false, true], [true, true], [true, false], [false, true]]
    return sensors.map((s, i) => strip(s, caps[i][0], caps[i][1]))
  }
  if (projectId === 'PRJ-10243') return sensors.slice(0, 6).map((s) => strip(s, false, false))
  const rnd = rng(projectId + ':aq')
  if (isStandalone(p)) {
    const names: [string, string][] = projectId === 'PRJ-10252' ? [['车库东区', 'B1'], ['车库西区', 'B1']] : [['客厅', '1F'], ['主卧', '2F']]
    return names.map(([room, floor], i) => {
      const s: Sensor = { id: `AQ-0${i + 1}`, room, floor, online: true, temp: r1(25.4 + rnd() * 1.6), hum: Math.round(52 + rnd() * 8), dew: r1(15 + rnd() * 2), pm25: Math.round(8 + rnd() * 10), co2: Math.round(560 + rnd() * 300), tag: '良好' }
      // first sensor of a standalone project has no PM2.5 probe
      return strip(s, i !== 0, true)
    })
  }
  const n = 6 + Math.floor(rnd() * 3)
  return sensors.slice(0, n).map((s) => {
    if (!s.online) return s
    const x: Sensor = { ...s, temp: r1(s.temp + (rnd() - 0.5) * 1.2), hum: Math.round(s.hum + (rnd() - 0.5) * 6), dew: r1(s.dew + (rnd() - 0.5) * 1.4), pm25: Math.round((s.pm25 ?? 10) * (0.6 + rnd() * 0.7)), co2: Math.round((s.co2 ?? 600) * (0.75 + rnd() * 0.35)) }
    return { ...x, tag: sensorTag(x) }
  })
}

// ------------------------------------------------------------------ rooms (温控面板)
export function roomsFor(projectId: string): Room[] {
  const p = proj(projectId)
  if (!hasRooms(p)) return []
  if (projectId === 'PRJ-10241') return rooms
  const rnd = rng(projectId + ':rooms')
  return rooms.map((r) => ({ ...r, temp: r1(r.temp + (rnd() - 0.5) * 1.2), humidity: Math.round(r.humidity + (rnd() - 0.5) * 6), dew: r1(r.dew + (rnd() - 0.5) * 1.2), mode: rnd() > 0.7 ? '节能' : '标准', on: r.id === 'TP-06' ? rnd() > 0.5 : true }))
}

// ------------------------------------------------------------------ fresh air
const unit = (base: FreshAir, id: string, mode: number, patch: Partial<FreshAir> = {}): FreshAir => {
  const u: FreshAir = { ...base, id, name: `新风机 ${id}`, mode, ...patch }
  return u
}
export function freshAirFor(projectId: string): FreshAir[] {
  const p = proj(projectId)
  if (projectId === 'PRJ-10241') return freshAirUnits
  const [fa1, fa2, fa3] = freshAirUnits
  let list: FreshAir[]
  if (projectId === 'PRJ-10252') {
    list = [
      unit(fa1, 'FA-01', 2, { floor: 'B1' }),
      unit(fa2, 'FA-02', 13, { floor: 'B1', control: 'dew', dewSet: 12.5 }),
      unit(fa1, 'FA-03', 23, { floor: 'B1', control: 'hum', humSet: 55, filter: 61, filterDays: 49 }),
      unit(fa3, 'FA-04', 33, { floor: 'B2', status: 'run', filter: 38, filterDays: 30 }),
      unit(fa2, 'FA-05', 5, { floor: 'B2', control: 'hum', humSet: 50 }),
    ]
  } else if (projectId === 'PRJ-30057') {
    list = [unit(fa1, 'FA-01', 6, { floor: '1F', control: 'hum', humSet: 52 })]
  } else if (projectId === 'PRJ-50102') {
    list = [unit(fa1, 'FA-01', 33, { floor: '1F' }), unit(fa2, 'FA-02', 4, { floor: '2F', control: 'hum' })]
  } else if (projectId === 'PRJ-60014') {
    list = [unit(fa1, 'FA-01', 13, { floor: '1F' })]
  } else {
    const rnd = rng(projectId + ':fa')
    const modes = [2, 23, 6, 1]
    list = freshAirUnits.slice(0, 2 + Math.floor(rnd() * 3)).map((f, i) => ({ ...f, mode: modes[(i + Math.floor(rnd() * 4)) % 4], supplyTemp: r1(f.supplyTemp + (rnd() - 0.5)), supplyHum: Math.round(f.supplyHum + (rnd() - 0.5) * 4), filter: Math.max(5, Math.min(95, Math.round(f.filter + (rnd() - 0.5) * 30))) }))
  }
  // a 新风单机版 unit outside the dew-capable modes is always in 湿度控制
  if (isStandalone(p)) list = list.map((f) => (DEW_MODES.includes(f.mode) ? f : { ...f, control: 'hum' as const }))
  return list
}

// ------------------------------------------------------------------ connections
export function connectionsFor(projectId: string): Conn[] {
  const p = proj(projectId)
  let list: Conn[]
  if (projectId === 'PRJ-10241') list = connections
  else {
    const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0')
    const on = (name: string, type: string, bus: string): Conn => ({ name, type, bus, proto: 'Modbus-RTU', state: '在线', loss: 0, last: '15:42:06' })
    list = [
      ...(hasRooms(p) ? [on('热泵主机 HP-01', '空调主机', 'RS485-2 / 0x01')] : []),
      ...freshAirFor(projectId).map((f, i) => on(f.name, '新风除湿', `RS485-2 / ${hex(0x31 + i)}`)),
      ...roomsFor(projectId).map((r, i) => on(`${r.name}温控面板 ${r.id}`, '温控面板', `RS485-1 / ${hex(0x11 + i)}`)),
      ...sensorsFor(projectId).map((s, i) => ({ ...on(`${s.room}空气传感器 ${s.id}`, '空气传感器', `RS485-1 / ${hex(0x21 + i)}`), ...(s.online ? {} : { state: '离线' as const, loss: 100, last: s.last ?? '—' }) })),
    ]
  }
  // gateway offline → nothing is reachable; keep the last-known list but mark every device offline
  if (!p.online) list = list.map((c) => ({ ...c, state: '离线' as const }))
  return list
}

// ------------------------------------------------------------------ statistics series
export type MetricKey = 'temp' | 'hum' | 'dew' | 'pm25' | 'co2'
export interface HourPoint { t: string; temp: number; hum: number; dew: number; pm25?: number; co2?: number }
export interface Agg { avg: number; max: number; min: number }
export interface DayPoint { date: string; temp: Agg; hum: Agg; dew: Agg; pm25?: Agg; co2?: Agg }

const AMP: Record<MetricKey, number> = { temp: 0.8, hum: 4, dew: 1.1, pm25: 5, co2: 170 }
const DIGITS: Record<MetricKey, number> = { temp: 1, hum: 0, dew: 1, pm25: 0, co2: 0 }
const round = (k: MetricKey, v: number) => +Math.max(0, v).toFixed(DIGITS[k])

type Base = { temp: number; hum: number; dew: number; pm25?: number; co2?: number }
const keysOf = (b: Base): MetricKey[] => (['temp', 'hum', 'dew', 'pm25', 'co2'] as MetricKey[]).filter((k) => b[k] !== undefined)

/** 24 hourly points (00:00–23:00) for the demo day */
export function series24h(seed: string, base: Base): HourPoint[] {
  const rnd = rng(seed + ':24h')
  const ks = keysOf(base)
  return Array.from({ length: 24 }, (_, h) => {
    const pt: Record<string, number | string> = { t: `${String(h).padStart(2, '0')}:00` }
    for (const k of ks) {
      const shape = 0.55 * Math.sin((h - 8) / 3.6) + 0.25 * Math.sin(h * 1.3) + 0.15 * Math.cos(h * 2.1)
      pt[k] = round(k, (base[k] as number) + AMP[k] * shape + (rnd() - 0.5) * AMP[k] * 0.3)
    }
    return pt as unknown as HourPoint
  })
}

/** per-day aggregates for the last `days` days ending on the demo day (06-18) */
export function seriesDaily(seed: string, base: Base, days: number): DayPoint[] {
  const rnd = rng(seed + ':daily')
  const ks = keysOf(base)
  const end = new Date(2025, 5, 18)
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(end)
    d.setDate(end.getDate() - (days - 1 - i))
    const pt: Record<string, unknown> = { date: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    for (const k of ks) {
      const avg = (base[k] as number) + AMP[k] * 0.6 * Math.sin(i / 2.7) + (rnd() - 0.5) * AMP[k] * 0.5
      pt[k] = { avg: round(k, avg), max: round(k, avg + AMP[k] * (0.7 + rnd() * 0.5)), min: round(k, avg - AMP[k] * (0.7 + rnd() * 0.5)) }
    }
    return pt as unknown as DayPoint
  })
}

// ------------------------------------------------------------------ air sensor (ctrl 207 / 208 shapes)
/** 设备读数「无数据」：无探头 / 未初始化（与真实设备一致） */
const NO_DATA = 65536
const MOCK_SENSOR_ID0 = 1001

/** 传感器列表，按 ctrl 207 的 Reply 形状：无探头的字段为 65536，离线的 is_connected=false */
export function airSensorsFor(projectId: string) {
  return sensorsFor(projectId).map((s, i) => ({
    id: MOCK_SENSOR_ID0 + i,
    name: s.room,
    temperature: s.online ? s.temp : 0,
    humidity: s.online ? s.hum : 0,
    dewPoint: s.online ? s.dew : 0,
    pm25: s.pm25 === undefined ? NO_DATA : s.online ? s.pm25 : 0,
    co2: s.co2 === undefined ? NO_DATA : s.online ? s.co2 : 0,
    isConnected: s.online,
  }))
}

const HOUR = 3_600_000
const CST = 8 * HOUR
/** 按时间戳确定的噪声（同一小时在 24 小时 / 7 日 / 30 日里取到同一个值） */
const noise = (seed: string, ts: number) => rng(`${seed}:${ts}`)() - 0.5

/** 小时数据，按 ctrl 208 的 Reply 形状：[start, end] 内每个整点一条；离线传感器没有数据 */
export function airSensorHoursFor(projectId: string, deviceId: number, start: number, end: number) {
  const s = sensorsFor(projectId)[deviceId - MOCK_SENSOR_ID0]
  if (!s || !s.online) return []
  const seed = `${projectId}/${s.id}`
  const out = []
  for (let ts = Math.ceil(start / HOUR) * HOUR; ts <= end; ts += HOUR) {
    const h = new Date(ts + CST).getUTCHours()
    const day = Math.floor((ts + CST) / (24 * HOUR))
    const shape = 0.55 * Math.sin((h - 8) / 3.6) + 0.25 * Math.sin(h * 1.3) + 0.15 * Math.cos(h * 2.1) + 0.35 * Math.sin(day / 2.7)
    const v = (k: MetricKey, base: number | undefined) => (base === undefined ? NO_DATA : round(k, base + AMP[k] * shape + noise(seed + k, ts) * AMP[k] * 0.4))
    out.push({
      id: deviceId, date: ts, hour: h,
      temperature: v('temp', s.temp), floorTemperature: 0, humidity: v('hum', s.hum), dewPoint: v('dew', s.dew),
      co2: v('co2', s.co2), pm25: v('pm25', s.pm25),
    })
  }
  return out
}
