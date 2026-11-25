// ctrl 207 → 传感器视图模型：65536 隐藏、离线读数不可信、KPI 只算在线且有数据的。
import { describe, expect, it } from 'vitest'
import { kpiOf, pickSensor, sensorTag, toAirSensors } from '../map'

// 实测样本（实测记录-1124：KC2）
const NOW = Date.parse('2026-01-15T10:00:00+08:00')
const KC2 = { id: 2042830592, name: 'KC2', temperature: 25.5, humidity: 55, pm25: 5, co2: 580, dewPoint: 15.8, isConnected: true }

describe('toAirSensors', () => {
  it('实测样本原样映射', () => {
    expect(toAirSensors([KC2])).toEqual([{ id: 2042830592, key: '2042830592', name: 'KC2', online: true, temp: 25.5, hum: 55, dew: 15.8, pm25: 5, co2: 580 }])
  })

  it('65536（无探头 / 未初始化）→ null（页面隐藏该项），其余照常', () => {
    const [s] = toAirSensors([{ ...KC2, pm25: 65536, co2: 65536 }])
    expect(s).toMatchObject({ pm25: null, co2: null, temp: 25.5, hum: 55 })
    const [t] = toAirSensors([{ ...KC2, temperature: 65536 }])
    expect(t.temp).toBeNull()
  })

  it('0 是有效读数（后端 11/25 答复第 9 条，含温度）；湿度、CO₂ 负数无效；温度、露点负数有效', () => {
    const [s] = toAirSensors([{ ...KC2, humidity: 0, co2: 0, temperature: 0, pm25: 0, dewPoint: 0 }])
    expect(s).toMatchObject({ hum: 0, co2: 0, temp: 0, pm25: 0, dew: 0 })
    const [t] = toAirSensors([{ ...KC2, humidity: -1, co2: -5, temperature: -3, dewPoint: -8 }])
    expect(t).toMatchObject({ hum: null, co2: null, temp: -3, dew: -8 })
  })

  it('-100（无效数据）过滤，与 208 同一口径；合法负温度 / 负露点保留', () => {
    const [s] = toAirSensors([{ ...KC2, temperature: -100, dewPoint: -100, pm25: -100 }])
    expect(s).toMatchObject({ temp: null, dew: null, pm25: null, hum: 55, co2: 580 })
    const [t] = toAirSensors([{ ...KC2, temperature: -2.5, dewPoint: -15 }])
    expect(t).toMatchObject({ temp: -2.5, dew: -15 })
  })

  it('离线（is_connected 缺省 / false）：读数一律 null', () => {
    const [a, b] = toAirSensors([{ ...KC2, isConnected: false }, { id: 3, name: 'x', temperature: 20 }])
    expect(a).toMatchObject({ online: false, temp: null, hum: null, dew: null, pm25: null, co2: null })
    expect(b.online).toBe(false)
  })

  it('设备 ID 重复时 key 仍唯一；名称为空时给出可读的占位', () => {
    const list = toAirSensors([{ ...KC2 }, { ...KC2 }, { ...KC2, name: '  ', id: undefined }])
    expect(new Set(list.map((s) => s.key)).size).toBe(3)
    expect(list[2].name).toBe('传感器 3')
    expect(list[2].id).toBe(0)
  })
})

describe('sensorTag / pickSensor / kpiOf', () => {
  const list = toAirSensors([
    { ...KC2, id: 1, name: 'A', co2: 801 },
    { ...KC2, id: 2, name: 'B', pm25: 65536, co2: 65536, temperature: 27 },
    { ...KC2, id: 3, name: 'C', isConnected: false },
    { ...KC2, id: 4, name: 'D', pm25: 36, co2: 800 },
  ])

  it('标签：离线 > CO₂ 超标 > PM2.5 偏高 > 良好；没有探头不算超标', () => {
    // 阈值与「标准范围」同源：CO₂ > 800 超标（800 不算），PM2.5 > 35 偏高
    expect(list.map((s) => sensorTag(s, NOW))).toEqual(['CO₂ 超标', '良好', '离线', 'PM2.5 偏高'])
  })

  it('选中：选过且在线就用它；离线或不存在回到第一个在线的', () => {
    expect(pickSensor(list, '4')?.name).toBe('D')
    expect(pickSensor(list, '3')?.name).toBe('A')
    expect(pickSensor(list, 'nope')?.name).toBe('A')
    expect(pickSensor(toAirSensors([{ ...KC2, isConnected: false }]), '')).toBeUndefined()
  })

  it('KPI：只算在线且有数据的传感器（65536、离线不计入）', () => {
    expect(kpiOf(list, 'temp')).toEqual({ avg: (25.5 + 27 + 25.5) / 3, max: 27, min: 25.5, n: 3 })
    expect(kpiOf(list, 'pm25')).toEqual({ avg: 20.5, max: 36, min: 5, n: 2 })
    expect(kpiOf(toAirSensors([{ ...KC2, co2: 65536 }]), 'co2')).toBeNull()
  })
})
