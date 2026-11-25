// 写消息线上字节核对（后端 11/25 答复：不变的字段一律传 -1，0 是真实值）。
// proto3 里没赋值的 int 字段线上省略、解码为 0——如果组装时漏了某个字段或用 0 兜底，控制屏会把 0 当真实指令。
// 这里按 ctrl.ts 实际下发的编码（encodeMessage）编成线上字节，再用 proto schema 原样解码，逐字段核对。
import { fromBinary, type DescMessage } from '@bufbuild/protobuf'
import { base64Decode } from '@bufbuild/protobuf/wire'
import { describe, expect, it } from 'vitest'
import { CTRL, buildProjectRoomSwitchSet, buildRoomTemperatureSet, decodeReply, encodeMessage } from '../ctrl'
import * as pb from '../gen/ctrl200_pb.js'
import { buildRoomSet, buildRoomSwitch, newDraft, editDraft, resolveTempRange } from '@/features/thermostat/edit'
import { toRoomView } from '@/features/thermostat/model'

const Q201 = CTRL[201].query
const Q206 = CTRL[206].query

/** 按 ctrl.ts 的编码编成线上字节，再用 schema 解码（字段缺省时就是 proto3 默认值 0） */
function onWire(schema: DescMessage, q: object) {
  const b64 = encodeMessage(schema, q)
  return fromBinary(schema, b64 ? base64Decode(b64) : new Uint8Array()) as unknown as Record<string, unknown>
}

const EQ = 406658286
/** 201 的标量字段（除 equipmentId） */
const SCALARS_201 = ['temperature', 'humidity', 'windSpeed', 'eco', 'switch'] as const
/** 本文件覆盖到的 201 字段；proto 加了新字段时下面的「字段集合」用例会失败，提醒在 buildRoomTemperatureSet 补 -1 默认 */
const COVERED_201 = ['equipmentId', ...SCALARS_201, 'endModes']
const END_FIELDS = ['optionName', 'type', 'isSelected', 'isChange', 'switch']

const ENDS = [
  { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
  { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 },
  { optionName: '全空气', type: 2, isSelected: true, isChange: false, switch: 1 },
]

/** 断言：equipmentId 正确；target 里的字段等于给定值，其余标量全为 -1 */
function expect201(m: Record<string, unknown>, target: Partial<Record<(typeof SCALARS_201)[number], number>>) {
  expect(m.equipmentId).toBe(BigInt(EQ))
  for (const k of SCALARS_201) expect(m[k], k).toBe(k in target ? target[k] : -1)
}
const plainEnds = (m: Record<string, unknown>) => (m.endModes as Array<Record<string, unknown>>).map((e) => Object.fromEntries(END_FIELDS.map((k) => [k, e[k]])))

describe('201 RoomTemperatureSetQuery 线上字节：不改的标量为 -1', () => {
  const cases: Array<[string, Parameters<typeof buildRoomTemperatureSet>[1], Partial<Record<(typeof SCALARS_201)[number], number>>]> = [
    ['什么都不改', {}, {}],
    ['只改温度', { temperature: 24.5 }, { temperature: 24.5 }],
    ['只改节能（开）', { eco: 1 }, { eco: 1 }],
    ['只改节能（关，0 是真实值）', { eco: 0 }, { eco: 0 }],
    ['只开房间', { switch: 1 }, { switch: 1 }],
    ['只关房间（0 是真实值）', { switch: 0 }, { switch: 0 }],
    ['改温度 + 节能', { temperature: 26, eco: 0 }, { temperature: 26, eco: 0 }],
  ]
  for (const [name, changes, target] of cases) {
    it(name, () => {
      const m = onWire(Q201, buildRoomTemperatureSet(EQ, changes))
      expect201(m, target)
      expect(m.endModes).toEqual([])
    })
  }

  it('带完整末端：标量仍为 -1，末端逐项原样上线（含 is_selected = false、switch = 0）', () => {
    const m = onWire(Q201, buildRoomTemperatureSet(EQ, { temperature: 25, endModes: ENDS }))
    expect201(m, { temperature: 25 })
    expect(plainEnds(m)).toEqual(ENDS)
  })

  it('proto 字段集合与本测试覆盖的一致（proto 加字段时失败：请在 buildRoomTemperatureSet 补 -1 默认并在此覆盖）', () => {
    expect(Q201).toBe(pb.RoomTemperatureSetQuerySchema)
    expect(Q201.fields.map((f) => f.localName).sort()).toEqual([...COVERED_201].sort())
    const ends = Q201.fields.find((f) => f.localName === 'endModes')!
    expect(ends.fieldKind === 'list' && ends.listKind === 'message' ? ends.message.fields.map((f) => f.localName).sort() : null).toEqual([...END_FIELDS].sort())
  })
})

describe('206 ProjectRoomSwitchSetQuery 线上字节', () => {
  it('true → switch = 1，false → switch = 0', () => {
    expect(onWire(Q206, buildProjectRoomSwitchSet(true)).switch).toBe(1)
    expect(onWire(Q206, buildProjectRoomSwitchSet(false)).switch).toBe(0)
  })
  it('非布尔一律抛错（不会落成 0 = 全部关闭）', () => {
    for (const v of [undefined, null, 0, 1, -1, 'true', 'false', {}]) expect(() => buildProjectRoomSwitchSet(v as never), String(v)).toThrow()
  })
  it('proto 字段集合只有 switch（加字段时失败，提醒补 -1 默认）', () => {
    expect(Q206).toBe(pb.ProjectRoomSwitchSetQuerySchema)
    expect(Q206.fields.map((f) => f.localName)).toEqual(['switch'])
  })
})

describe('页面层（S9 房间卡片）组装后的 201 线上字节', () => {
  // 一份 200 读数经同样编解码，再转成页面用的 RoomView
  const reply = decodeReply(pb.RoomTemperatureDataGetReplySchema, encodeMessage(pb.RoomTemperatureDataGetReplySchema, {
    data: [{ id: EQ, name: '客厅', temperature: 25.8, humidity: 51, dewPoint: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0, switch: 1, mode: 1, isConnected: true, endModes: ENDS }],
  })) as { data: Parameters<typeof toRoomView>[0][] }
  const room = toRoomView(reply.data[0], { switchReported: true })
  const ctx = { online: true, fresh: true }
  const R = resolveTempRange(null)
  const built = (b: ReturnType<typeof buildRoomSet>) => { if (!b.ok) throw new Error(b.reason); return b.query }

  it('buildRoomSet 只改温度：temperature 为新值，其余 -1，末端空', () => {
    const m = onWire(Q201, built(buildRoomSet(room, editDraft(room, newDraft(room), { temp: 24 }), ctx, R)))
    expect201(m, { temperature: 24 })
    expect(m.endModes).toEqual([])
  })
  it('buildRoomSet 只开节能：eco = 1，其余 -1，末端空', () => {
    const m = onWire(Q201, built(buildRoomSet(room, editDraft(room, newDraft(room), { eco: 1 }), ctx, R)))
    expect201(m, { eco: 1 })
    expect(m.endModes).toEqual([])
  })
  it('buildRoomSet 改温度 + 末端：末端按读数完整回传，只换 is_selected', () => {
    const d = editDraft(room, newDraft(room), { temp: 26, ends: [true, true, true] })
    const m = onWire(Q201, built(buildRoomSet(room, d, ctx, R)))
    expect201(m, { temperature: 26 })
    expect(plainEnds(m)).toEqual(ENDS.map((e) => ({ ...e, isSelected: true })))
  })
  it('buildRoomSwitch 开 / 关：switch = 1 / 0，其余 -1，末端空', () => {
    for (const on of [true, false]) {
      const m = onWire(Q201, built(buildRoomSwitch(room, on, ctx)))
      expect201(m, { switch: on ? 1 : 0 })
      expect(m.endModes).toEqual([])
    }
  })
})
