// 温度边界与步长、房间关闭禁止设置、201 Query 组装（只发改了的字段、不改的标量 -1、end_modes 空列表）。
import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage } from '@/api/ctrl'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { buildRoomSet, buildRoomSwitch, canStep, describeChanges, describeResult, draftChanges, editBlock, resolveTempRange, stepTemp, switchBlock } from '../edit'
import type { RoomView } from '../model'

const R = resolveTempRange(null)
const room = (o: Partial<RoomView> = {}): RoomView => ({
  key: '406658286', equipmentId: 406658286, name: '客厅', temp: 25.8, humidity: 51, dew: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0,
  on: true, mode: '制冷', endModes: [], connected: true, ...o,
})
/** 201 Query 编码后再按 proto 解码（下发到线上的就是这些值） */
const wire = (q: object) => decodeReply(pb.RoomTemperatureSetQuerySchema, encodeMessage(pb.RoomTemperatureSetQuerySchema, q))

describe('设定温度范围与步长', () => {
  it('默认 16–30℃、步长 0.5；后端给了范围以后按后端的', () => {
    expect(R).toEqual({ min: 16, max: 30, step: 0.5 })
    expect(resolveTempRange({ min: 18, max: 28, step: 1 })).toEqual({ min: 18, max: 28, step: 1 })
  })

  it('每次 ±0.5；到 30 不能再加，到 16 不能再减', () => {
    expect(stepTemp(25.5, 1, R)).toBe(26)
    expect(stepTemp(25.5, -1, R)).toBe(25)
    expect(stepTemp(29.5, 1, R)).toBe(30)
    expect(stepTemp(30, 1, R)).toBe(30)
    expect(stepTemp(16.5, -1, R)).toBe(16)
    expect(stepTemp(16, -1, R)).toBe(16)
    expect(canStep(30, 1, R)).toBe(false)
    expect(canStep(29.5, 1, R)).toBe(true)
    expect(canStep(16, -1, R)).toBe(false)
    expect(canStep(16.5, -1, R)).toBe(true)
  })

  it('面板值不在格点上：先对齐到相邻格点（25.3 → + 25.5 / − 25.0）', () => {
    expect(stepTemp(25.3, 1, R)).toBe(25.5)
    expect(stepTemp(25.3, -1, R)).toBe(25)
  })

  it('面板值超出范围：一步收回边界（32 → − 30；10 → + 16），超出方向的按钮禁用', () => {
    expect(stepTemp(32, -1, R)).toBe(30)
    expect(stepTemp(10, 1, R)).toBe(16)
    expect(canStep(32, 1, R)).toBe(false)
    expect(canStep(10, -1, R)).toBe(false)
  })

  it('连点 +：一路到 30 为止，全是 0.5 的格点', () => {
    let v = 16
    const seen: number[] = []
    for (let i = 0; i < 40; i++) { v = stepTemp(v, 1, R); seen.push(v) }
    expect(seen.at(-1)).toBe(30)
    expect(seen.every((x) => Number.isInteger(x * 2) && x >= 16 && x <= 30)).toBe(true)
  })
})

describe('不能设置的情况', () => {
  it('房间关闭：温度和节能不能设置（后端答复⑦）；开关仍可下发', () => {
    expect(editBlock(room({ on: false }), true)).toMatch(/房间已关闭/)
    expect(switchBlock(room({ on: false }), true)).toBeNull()
    expect(buildRoomSet(room({ on: false }), { key: '406658286', temp: 24 }, true, R)).toMatchObject({ ok: false, reason: expect.stringMatching(/房间已关闭/) })
  })
  it('面板未连接、项目离线：都不能设置，开关也不行', () => {
    expect(editBlock(room({ connected: false }), true)).toMatch(/面板离线/)
    expect(editBlock(room(), false)).toMatch(/项目离线/)
    expect(switchBlock(room({ connected: false }), true)).toMatch(/面板离线/)
    expect(switchBlock(room(), false)).toMatch(/项目离线/)
    expect(buildRoomSet(room(), { key: '406658286', temp: 24 }, false, R).ok).toBe(false)
  })
  it('没有改动（草稿与面板当前值相同、草稿是别的房间的）不给 Query', () => {
    expect(buildRoomSet(room(), { key: '406658286', temp: 25.5, eco: 0 }, true, R)).toMatchObject({ ok: false, reason: '没有需要下发的修改' })
    expect(buildRoomSet(room(), { key: 'other', temp: 24 }, true, R).ok).toBe(false)
    expect(buildRoomSet(room(), null, true, R).ok).toBe(false)
  })
  it('温度不合法（越界、不在步长上）不给 Query', () => {
    expect(buildRoomSet(room(), { key: '406658286', temp: 30.5 }, true, R).ok).toBe(false)
    expect(buildRoomSet(room(), { key: '406658286', temp: 15.5 }, true, R).ok).toBe(false)
    expect(buildRoomSet(room(), { key: '406658286', temp: 24.3 }, true, R).ok).toBe(false)
  })
})

describe('201 Query：只发改了的字段，其余 -1，end_modes 空列表', () => {
  it('只改温度', () => {
    const b = buildRoomSet(room(), { key: '406658286', temp: 24.5 }, true, R)
    expect(b.ok).toBe(true)
    const q = (b as { query: object }).query
    expect(q).toEqual({ equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: [] })
    expect(wire(q)).toEqual({ equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: [] })
  })
  it('只改节能（标准 → 节能、节能 → 标准；0 要真的发成 0，不是 -1）', () => {
    const on = buildRoomSet(room({ eco: 0 }), { key: '406658286', eco: 1 }, true, R) as { query: object }
    expect(on.query).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: 1, switch: -1, endModes: [] })
    const off = buildRoomSet(room({ eco: 1 }), { key: '406658286', eco: 0 }, true, R) as { query: object }
    expect(off.query).toMatchObject({ temperature: -1, eco: 0, switch: -1 })
    expect(wire(off.query)).toMatchObject({ temperature: -1, eco: 0, switch: -1, windSpeed: -1, humidity: -1 })
  })
  it('温度和节能一起改：合并成一条', () => {
    const b = buildRoomSet(room(), { key: '406658286', temp: 24.5, eco: 1 }, true, R) as { query: object }
    expect(b.query).toEqual({ equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: 1, switch: -1, endModes: [] })
  })
  it('草稿里改回原值的项不发（温度改回 25.5，只发节能）', () => {
    const b = buildRoomSet(room(), { key: '406658286', temp: 25.5, eco: 1 }, true, R) as { query: object }
    expect(b.query).toMatchObject({ temperature: -1, eco: 1 })
  })
  it('风速、湿度、末端永远不改：-1 / 空列表', () => {
    const b = buildRoomSet(room({ windSpeed: 100 }), { key: '406658286', temp: 20 }, true, R) as { query: Record<string, unknown> }
    expect(b.query.windSpeed).toBe(-1)
    expect(b.query.humidity).toBe(-1)
    expect(b.query.endModes).toEqual([])
  })
  it('房间开关：只有 switch 是真实值（关 = 0，不是缺省）', () => {
    expect(buildRoomSwitch(room(), false)).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: 0, endModes: [] })
    expect(wire(buildRoomSwitch(room(), true))).toMatchObject({ switch: 1, temperature: -1, eco: -1 })
  })
})

describe('文案', () => {
  it('待下发与成功提示', () => {
    const c = draftChanges(room(), { key: '406658286', temp: 24.5, eco: 1 })
    expect(describeChanges(c)).toBe('设定温度 25.5 → 24.5°C，节能模式 标准 → 节能')
    expect(describeResult(c)).toBe('设定温度 24.5°C，节能模式 开')
  })
})
