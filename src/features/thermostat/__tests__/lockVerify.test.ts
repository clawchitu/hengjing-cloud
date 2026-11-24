// 温控接共用写锁的核对数据与比对：201 / 206 的持久化数据，页面读数 → 200 形状后比对。
import { describe, expect, it } from 'vitest'
import { buildRoomTemperatureSet } from '@/api/ctrl'
import { match201, match206, record201, record206, roomsAsReply } from '../lockVerify'
import type { RoomView } from '../model'

const room = (o: Partial<RoomView> = {}): RoomView => ({
  key: '7', equipmentId: 7, name: '客厅', temp: 25, humidity: 50, dew: 14, setTemp: 25.5, windSpeed: 3, eco: 0, on: true, mode: '制冷',
  endModes: [], wireEndModes: [], connected: true, ...o,
})

describe('核对数据', () => {
  it('201：设备 id 与温度、节能、开关（-1 = 不改）；206：开关', () => {
    expect(record201(buildRoomTemperatureSet(7, { temperature: 26 }))).toEqual({ msg: 201, deviceId: 7, target: { temperature: 26, eco: -1, switch: -1 } })
    expect(record206(false)).toEqual({ msg: 206, deviceId: null, target: { switch: 0 } })
  })
  it('读数转换：开 → 1、关 → 0；读不到的设定温度 / 节能不会与任何目标相等', () => {
    const r = roomsAsReply([room({ on: false, setTemp: null, eco: null })]).data[0]
    expect(r).toMatchObject({ id: 7, switch: 0, eco: -2, isConnected: true })
    expect(Number.isNaN(r.setTemp)).toBe(true)
    expect(roomsAsReply([room()]).data[0].switch).toBe(1)
  })
})

describe('比对', () => {
  it('201：温度 / 节能 / 开关与读数一致才算一致', () => {
    expect(match201(buildRoomTemperatureSet(7, { temperature: 26 }), [room({ setTemp: 26 })])).toBe(true)
    expect(match201(buildRoomTemperatureSet(7, { temperature: 26 }), [room()])).toBe(false)
    expect(match201(buildRoomTemperatureSet(7, { switch: 0 }), [room({ on: false })])).toBe(true)
    expect(match201(buildRoomTemperatureSet(7, { switch: 1 }), [room({ on: false })])).toBe(false)
    expect(match201(buildRoomTemperatureSet(7, { eco: 1 }), [room({ eco: 1 })])).toBe(true)
  })
  it('206：所有已连接房间都是目标开关', () => {
    expect(match206(false, [room({ on: false }), room({ key: '8', equipmentId: 8, on: true, connected: false })])).toBe(true)
    expect(match206(true, [room(), room({ key: '8', equipmentId: 8, on: false })])).toBe(false)
  })
})
