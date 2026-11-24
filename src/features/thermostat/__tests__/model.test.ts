// ctrl 200 读取映射：end_modes（is_selected 蓝/灰、switch 开/关）、65536 隐藏、风速 1–99 档 / 100 自动、开关与连接。
// 用生成的 proto 真正编码一遍再解码，字段号与 proto 一致（不是手写对象直接喂映射）。
import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage, type CtrlReply } from '@/api/ctrl'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { summarize, toRoomViews, windLabel, windOf } from '../model'

const room = (o: Record<string, unknown> = {}) => ({
  id: 406658286, name: '房间11', temperature: 22, humidity: 60, dewPoint: 13.9, setTemp: 25.5, setHumi: 50, windSpeed: 3, eco: 0,
  switch: 1, mode: 0, isConnected: true,
  endModes: [
    { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
    { optionName: '顶辐射', type: 1, isSelected: true, isChange: true, switch: 0 },
    { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 },
  ],
  ...o,
})
/** 编码成控制屏的 base64 再解码（与真实链路相同） */
const roundTrip = (rooms: Record<string, unknown>[]) =>
  decodeReply(pb.RoomTemperatureDataGetReplySchema, encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: rooms })) as CtrlReply<200>

describe('ctrl 200 → RoomView', () => {
  it('基本字段：设备 ID、名称、读数、设定温度、模式、开关、连接', () => {
    const [r] = toRoomViews(roundTrip([room()]))
    expect(r).toMatchObject({ key: '406658286', equipmentId: 406658286, name: '房间11', temp: 22, humidity: 60, setTemp: 25.5, windSpeed: 3, eco: 0, on: true, mode: '制冷', connected: true })
    expect(r.dew).toBeCloseTo(13.9, 4)
    // 设定湿度按改动文档去除，视图里没有这个字段
    expect(r).not.toHaveProperty('setHumidity')
    expect(r).not.toHaveProperty('setHumi')
  })

  it('end_modes 按数量动态映射：is_selected → selected（蓝/灰），开/关取末端自己的 switch', () => {
    const [r] = toRoomViews(roundTrip([room()]))
    expect(r.endModes).toEqual([
      { name: '风盘', type: 0, selected: true, on: true },
      { name: '顶辐射', type: 1, selected: true, on: false },
      { name: '地冷', type: 3, selected: false, on: false },
    ])
    const [one] = toRoomViews(roundTrip([room({ endModes: [{ optionName: '全空气', type: 4, isSelected: true, isChange: false, switch: 1 }] })]))
    expect(one.endModes).toHaveLength(1)
    const [none] = toRoomViews(roundTrip([room({ endModes: [] })]))
    expect(none.endModes).toEqual([])
    // 没有名称时按类型兜底
    const [noName] = toRoomViews(roundTrip([room({ endModes: [{ optionName: '', type: 2, isSelected: false, isChange: true, switch: 1 }] })]))
    expect(noName.endModes[0]).toEqual({ name: '地暖', type: 2, selected: false, on: true })
  })

  it('65536（未初始化）→ null：温度、湿度、露点、设定温度、节能都隐藏 / 不可调', () => {
    const [r] = toRoomViews(roundTrip([room({ temperature: 65536, humidity: 65536, dewPoint: 65536, setTemp: 65536, eco: 65536 })]))
    expect(r).toMatchObject({ temp: null, humidity: null, dew: null, setTemp: null, eco: null })
  })

  it('设定温度 -1、0（proto3 缺省）也按没有设定值处理', () => {
    expect(toRoomViews(roundTrip([room({ setTemp: -1 })]))[0].setTemp).toBeNull()
    expect(toRoomViews(roundTrip([room({ setTemp: 0 })]))[0].setTemp).toBeNull()
  })

  it('风速：1–99 档位，100 自动，其他（0 缺省、101、65536、小数）为 --', () => {
    expect(windOf(1)).toBe(1)
    expect(windOf(99)).toBe(99)
    expect(windOf(100)).toBe(100)
    for (const v of [0, -1, 101, 65536, 2.5, NaN]) expect(windOf(v)).toBeNull()
    expect(windLabel(3)).toBe('3 档')
    expect(windLabel(100)).toBe('自动')
    expect(windLabel(null)).toBe('--')
    expect(toRoomViews(roundTrip([room({ windSpeed: 100 })]))[0].windSpeed).toBe(100)
  })

  it('开关：只有 1 是开（0 缺省、-1、65536 都按关）；is_connected 缺省为未连接', () => {
    for (const sw of [0, -1, 65536]) expect(toRoomViews(roundTrip([room({ switch: sw })]))[0].on).toBe(false)
    expect(toRoomViews(roundTrip([room({ isConnected: false })]))[0].connected).toBe(false)
  })

  it('节能：1 节能、0 标准（0 是 proto3 缺省也按标准）', () => {
    expect(toRoomViews(roundTrip([room({ eco: 1 })]))[0].eco).toBe(1)
    expect(toRoomViews(roundTrip([room({ eco: 0 })]))[0].eco).toBe(0)
  })

  it('设备 ID 无效（0 / 缺省）的房间丢弃，不会拿 0 去下发', () => {
    expect(toRoomViews(roundTrip([room({ id: 0 }), room({ id: 7 })])).map((r) => r.equipmentId)).toEqual([7])
  })

  it('KPI：在线数、开启数、节能数（只算开着的）、平均值跳过 null', () => {
    const rooms = toRoomViews(roundTrip([
      room({ id: 1, eco: 1, temperature: 20 }),
      room({ id: 2, eco: 1, switch: 0, temperature: 30, isConnected: false }),
      room({ id: 3, temperature: 65536, humidity: 65536 }),
    ]))
    expect(summarize(rooms)).toMatchObject({ total: 3, connected: 2, on: 2, eco: 1, avgTemp: 20, avgHumidity: 60 })
    expect(summarize([])).toMatchObject({ total: 0, avgTemp: null, avgHumidity: null, avgDew: null })
  })
})
