// ctrl 207 AirSensorGet → 页面用的传感器视图模型（纯函数）。
// 65536 = 设备没有该数据（无探头 / 未初始化，后端 11/24 答复）→ 该项为 null，页面隐藏；
// 离线传感器（is_connected 不为 true）的读数不可信，一律为 null，卡片显示「—」。
import { reading } from '../../api/values'
import type { Readings } from './stats'

export interface AirSensor extends Readings {
  /** 设备 ID（int64 已转 number），用于 208 的 device_id */
  id: number
  /** 列表里唯一的键（设备 ID 理论上唯一，重复时带上序号） */
  key: string
  name: string
  online: boolean
}

export interface AirSensorData {
  id?: number
  name?: string
  temperature?: number
  humidity?: number
  pm25?: number
  co2?: number
  dewPoint?: number
  isConnected?: boolean
}

export function toAirSensors(data: readonly AirSensorData[]): AirSensor[] {
  const seen = new Set<string>()
  return data.map((d, i) => {
    const id = typeof d.id === 'number' && Number.isFinite(d.id) ? d.id : 0
    let key = String(id)
    if (seen.has(key)) key = `${id}#${i}`
    seen.add(key)
    const online = d.isConnected === true
    const v = (x: number | undefined) => (online ? reading(x) : null)
    return {
      id, key, online,
      name: d.name?.trim() || `传感器 ${id || i + 1}`,
      temp: v(d.temperature), hum: v(d.humidity), dew: v(d.dewPoint), pm25: v(d.pm25), co2: v(d.co2),
    }
  })
}

export type SensorTag = '良好' | 'CO₂ 超标' | 'PM2.5 偏高' | '离线'
/** 卡片标签（前端阈值，沿用演示版：CO₂ > 1000 超标，PM2.5 > 20 偏高） */
export function sensorTag(s: Pick<AirSensor, 'online' | 'co2' | 'pm25'>): SensorTag {
  if (!s.online) return '离线'
  if (s.co2 !== null && s.co2 > 1000) return 'CO₂ 超标'
  if (s.pm25 !== null && s.pm25 > 20) return 'PM2.5 偏高'
  return '良好'
}

/** 当前选中的传感器：选过且仍在线就用它，否则第一个在线的；没有在线的为 undefined */
export function pickSensor(list: readonly AirSensor[], selected: string): AirSensor | undefined {
  return list.find((s) => s.key === selected && s.online) ?? list.find((s) => s.online)
}

/** 顶部 KPI：在线且有该数据的传感器的平均 / 最高 / 最低；没有为 null */
export function kpiOf(list: readonly AirSensor[], key: keyof Readings): { avg: number; max: number; min: number; n: number } | null {
  const vs = list.filter((s) => s.online).map((s) => s[key]).filter((v): v is number => v !== null)
  if (!vs.length) return null
  return { avg: vs.reduce((a, b) => a + b, 0) / vs.length, max: Math.max(...vs), min: Math.min(...vs), n: vs.length }
}
