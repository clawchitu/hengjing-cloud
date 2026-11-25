// 写消息线上字节核对（后端 11/25 答复第 4 条：不变的字段一律传 -1，0 是真实值；203 的 system_mode 枚举也一样）。
// proto3 里没赋值的 int 字段线上省略、解码为 0——如果组装时漏了某个字段或用 0 兜底，控制屏会把 0 当真实指令。
// 这里按 ctrl.ts 实际下发的编码（encodeMessage）编成线上字节，再用 proto schema 原样解码，逐字段核对。
import { fromBinary, type DescMessage } from '@bufbuild/protobuf'
import { base64Decode, BinaryReader, WireType } from '@bufbuild/protobuf/wire'
import { describe, expect, it } from 'vitest'
import { CTRL, MODE_UNCHANGED, buildProjectRoomSwitchSet, buildRoomTemperatureSet, buildRunningCtrlSet, buildUnifiedCtrlSet, decodeReply, encodeMessage } from '../ctrl'
import * as pb from '../gen/ctrl200_pb.js'
import { buildRoomSet, buildRoomSwitch, newDraft, editDraft, resolveTempRange } from '@/features/thermostat/edit'
import { toRoomView } from '@/features/thermostat/model'
import { validateUnified, type UnifiedContext, type UnifiedDraft } from '@/features/unified/rules'

const Q201 = CTRL[201].query
const Q206 = CTRL[206].query
const Q203 = CTRL[203].query
const Q204 = CTRL[204].query

/** 按 ctrl.ts 的编码编成线上字节，再用 schema 解码（字段缺省时就是 proto3 默认值 0） */
function onWire(schema: DescMessage, q: object) {
  const b64 = encodeMessage(schema, q)
  return fromBinary(schema, b64 ? base64Decode(b64) : new Uint8Array()) as unknown as Record<string, unknown>
}

/** 线上实际带了哪些字段号、各是什么值（varint 按 int32 读，32 位按 float 读）；不经 schema，直接看字节 */
function rawFields(schema: DescMessage, q: object): Map<number, number> {
  const b64 = encodeMessage(schema, q)
  const r = new BinaryReader(b64 ? base64Decode(b64) : new Uint8Array())
  const out = new Map<number, number>()
  while (r.pos < r.len) {
    const [no, wt] = r.tag()
    if (wt === WireType.Varint) out.set(no, r.int32())
    else if (wt === WireType.Bit32) out.set(no, r.float())
    else r.skip(wt, no)
  }
  return out
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

// ---------------------------------------------------------------------------
// 203 统一控制。11/25 00:20 一条 203「全部开启」的请求体里 system_mode 缺失（当时不变传 0 = OPERATION_MODE_NONE，proto3 线上省略），
// 设备收到的就是 0。现在运行模式不变也传 -1：system_mode 是开放枚举，protobuf-es 按 int32 编码，-1 是 10 字节 varint，确实上线。

const FIELDS_203 = ['systemSwitch', 'systemMode', 'roomSwitch', 'roomTemp'] as const
type T203 = Partial<Record<(typeof FIELDS_203)[number], number>>
const NO_203: Record<(typeof FIELDS_203)[number], number> = { systemSwitch: 1, systemMode: 2, roomSwitch: 3, roomTemp: 4 }

/** 断言：解码后 target 里的字段等于给定值，其余（含 systemMode）全为 -1；并且线上 4 个字段号都在（-1 不会被省略） */
function expect203(q: object, target: T203) {
  const m = onWire(Q203, q)
  for (const k of FIELDS_203) expect(m[k], k).toBe(k in target ? target[k] : -1)
  const raw = rawFields(Q203, q)
  for (const k of FIELDS_203) {
    const want = k in target ? target[k]! : -1
    // proto3：值为 0 的字段线上省略（解码为 0）；其余必须在线上，-1 也不例外
    if (want === 0) expect(raw.has(NO_203[k]), `${k} = 0 线上省略`).toBe(false)
    else expect(raw.get(NO_203[k]), `${k} 线上值`).toBe(want)
  }
}

describe('203 UnifiedCtrlSetQuery 线上字节：不改的字段（含运行模式）为 -1', () => {
  const AUTO = pb.UnifiedCtrlSetQuery_OperatingMode.OPERATION_MODE_AUTO
  const SUMMER = pb.UnifiedCtrlSetQuery_OperatingMode.OPERATION_MODE_SUMMER
  const cases: Array<[string, Parameters<typeof buildUnifiedCtrlSet>[0], T203]> = [
    ['什么都不改', {}, {}],
    ['全部开启（只开房间，11/25 00:20 那一条）', { roomSwitch: 1 }, { roomSwitch: 1 }],
    ['全部关闭（0 是真实值）', { roomSwitch: 0 }, { roomSwitch: 0 }],
    ['只开系统', { systemSwitch: 1 }, { systemSwitch: 1 }],
    ['只关系统（0 是真实值）', { systemSwitch: 0 }, { systemSwitch: 0 }],
    ['只改运行模式（自动 100）', { systemMode: AUTO }, { systemMode: AUTO }],
    ['只改运行模式（夏季 2）', { systemMode: SUMMER }, { systemMode: SUMMER }],
    ['只改温度', { roomTemp: 24.5 }, { roomTemp: 24.5 }],
    ['开系统 + 夏季 + 开房间 + 26 ℃', { systemSwitch: 1, systemMode: SUMMER, roomSwitch: 1, roomTemp: 26 }, { systemSwitch: 1, systemMode: SUMMER, roomSwitch: 1, roomTemp: 26 }],
  ]
  for (const [name, changes, target] of cases) it(name, () => expect203(buildUnifiedCtrlSet(changes), target))

  it('不改运行模式时 system_mode 线上是 -1 的 10 字节 varint（字段 2：0x10 ff ff ff ff ff ff ff ff ff 01）', () => {
    const b64 = encodeMessage(Q203, buildUnifiedCtrlSet({ roomSwitch: 1 }))
    const hex = Array.from(base64Decode(b64), (b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex).toContain('10ffffffffffffffffff01')
    expect(MODE_UNCHANGED).toBe(-1)
  })

  it('反证：运行模式传 0（OPERATION_MODE_NONE）时线上没有字段 2，设备收到的是 0——所以「不变」不能用 0', () => {
    const q = { ...buildUnifiedCtrlSet({ roomSwitch: 1 }), systemMode: pb.UnifiedCtrlSetQuery_OperatingMode.OPERATION_MODE_NONE }
    expect(rawFields(Q203, q).has(2)).toBe(false)
    expect(onWire(Q203, q).systemMode).toBe(0)
  })

  it('页面层（统一控制草稿 → validateUnified）组装后的线上字节：没选的项全是 -1', () => {
    const ctx: UnifiedContext = { projectId: 'p1', projectCode: '260911001', appCode: 1, online: true }
    const drafts: Array<[UnifiedDraft, T203]> = [
      [{ roomSwitch: 1 }, { roomSwitch: 1 }],
      [{ roomSwitch: 0 }, { roomSwitch: 0 }],
      [{ systemSwitch: 0 }, { systemSwitch: 0 }],
      [{ systemMode: AUTO }, { systemMode: AUTO }],
      [{ roomTemp: 25.5 }, { roomTemp: 25.5 }],
      [{ systemSwitch: 1, systemMode: SUMMER, roomSwitch: 1, roomTemp: 26 }, { systemSwitch: 1, systemMode: SUMMER, roomSwitch: 1, roomTemp: 26 }],
    ]
    for (const [d, target] of drafts) {
      const v = validateUnified(d, ctx)
      if (!v.ok) throw new Error(v.errors.join('；'))
      expect203(v.query, target)
    }
  })

  it('proto 字段集合与本测试覆盖的一致（proto 加字段时失败：请在 buildUnifiedCtrlSet 补 -1 默认并在此覆盖）', () => {
    expect(Q203).toBe(pb.UnifiedCtrlSetQuerySchema)
    expect(Q203.fields.map((f) => f.localName).sort()).toEqual([...FIELDS_203].sort())
    expect(Object.fromEntries(Q203.fields.map((f) => [f.localName, f.number]))).toEqual(NO_203)
    expect(Object.keys(buildUnifiedCtrlSet()).sort()).toEqual([...FIELDS_203].sort())
  })
})

// ---------------------------------------------------------------------------
// 204 运行控制设置（新风）：id、name 必给，其余不改为 -1

const EQ204 = 406658301
const SCALARS_204 = ['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch'] as const
const COVERED_204 = ['id', 'name', ...SCALARS_204]
type T204 = Partial<Record<(typeof SCALARS_204)[number], number>>

function expect204(m: Record<string, unknown>, target: T204) {
  expect(m.id).toBe(BigInt(EQ204))
  expect(m.name).toBe('新风机')
  for (const k of SCALARS_204) expect(m[k], k).toBe(k in target ? target[k] : -1)
}

describe('204 RunningCtrlSetQuery 线上字节：不改的标量为 -1', () => {
  const cases: Array<[string, Parameters<typeof buildRunningCtrlSet>[2], T204]> = [
    ['什么都不改', {}, {}],
    ['只改控制类型（湿度控制 0 是真实值）', { controlType: 0 }, { controlType: 0 }],
    ['只改控制类型（露点控制 1）', { controlType: 1 }, { controlType: 1 }],
    ['只改露点', { dewPoint: 14.5 }, { dewPoint: 14.5 }],
    ['只改设定湿度', { humiditySet: 55 }, { humiditySet: 55 }],
    ['只改风速', { windSpeed: 2 }, { windSpeed: 2 }],
    ['只改风速（0 是真实值）', { windSpeed: 0 }, { windSpeed: 0 }],
    ['只开', { switch: 1 }, { switch: 1 }],
    ['只关（0 是真实值）', { switch: 0 }, { switch: 0 }],
    ['湿度控制 + 设定湿度', { controlType: 0, humiditySet: 50 }, { controlType: 0, humiditySet: 50 }],
  ]
  for (const [name, changes, target] of cases) {
    it(name, () => {
      const q = buildRunningCtrlSet(EQ204, '新风机', changes)
      expect204(onWire(Q204, q), target)
      // 不改的字段线上必须在（-1），不会因省略落成 0
      const raw = rawFields(Q204, q)
      SCALARS_204.forEach((k, i) => { if (!(k in target)) expect(raw.get(i + 3), k).toBe(-1) })
    })
  }

  it('proto 字段集合与本测试覆盖的一致（proto 加字段时失败：请在 buildRunningCtrlSet 补 -1 默认并在此覆盖）', () => {
    expect(Q204).toBe(pb.RunningCtrlSetQuerySchema)
    expect(Q204.fields.map((f) => f.localName).sort()).toEqual([...COVERED_204].sort())
    expect(Q204.fields.filter((f) => SCALARS_204.includes(f.localName as never)).map((f) => [f.localName, f.number])).toEqual(SCALARS_204.map((k, i) => [k, i + 3]))
    expect(Object.keys(buildRunningCtrlSet(EQ204, '新风机')).sort()).toEqual([...COVERED_204].sort())
  })
})
