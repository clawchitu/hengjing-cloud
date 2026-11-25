// 写消息线上字节核对（后端 11/25 答复：不变的字段一律传 -1，0 是真实值）。
// proto3 里没赋值的 int 字段线上省略、解码为 0——如果组装时漏了某个字段或用 0 兜底，控制屏会把 0 当真实指令。
// 这里按 ctrl.ts 实际下发的编码（encodeMessage）编成线上字节，再用 proto schema 原样解码，逐字段核对。
import { fromBinary, ScalarType, type DescMessage } from '@bufbuild/protobuf'
import { base64Decode } from '@bufbuild/protobuf/wire'
import { describe, expect, it } from 'vitest'
import { CTRL, MODE_UNCHANGED, WRITE_CTRL, buildProjectRoomSwitchSet, buildRoomTemperatureSet, buildRunningCtrlSet, buildUnifiedCtrlSet, decodeReply, encodeMessage, unchangedOf } from '../ctrl'
import * as pb from '../gen/ctrl200_pb.js'
import { buildRoomSet, buildRoomSwitch, newDraft, editDraft, resolveTempRange } from '@/features/thermostat/edit'
import { toRoomView } from '@/features/thermostat/model'
import { validateUnified } from '@/features/unified/rules'

const Q201 = CTRL[201].query
const Q206 = CTRL[206].query
const Q203 = CTRL[203].query
const Q204 = CTRL[204].query

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

/** 203 的标量字段（system_mode 是枚举，同样按 -1 表示不变） */
const SCALARS_203 = ['systemSwitch', 'systemMode', 'roomSwitch', 'roomTemp'] as const
function expect203(m: Record<string, unknown>, target: Partial<Record<(typeof SCALARS_203)[number], number>>) {
  for (const k of SCALARS_203) expect(m[k], k).toBe(k in target ? target[k] : -1)
}

describe('203 UnifiedCtrlSetQuery 线上字节：不改的字段（含运行模式）为 -1', () => {
  const cases: Array<[string, Parameters<typeof buildUnifiedCtrlSet>[0], Partial<Record<(typeof SCALARS_203)[number], number>>]> = [
    ['什么都不改', {}, {}],
    ['只开全部房间', { roomSwitch: 1 }, { roomSwitch: 1 }],
    ['只关全部房间（0 是真实值）', { roomSwitch: 0 }, { roomSwitch: 0 }],
    ['只关系统（0 是真实值）', { systemSwitch: 0 }, { systemSwitch: 0 }],
    ['只改温度', { roomTemp: 24.5 }, { roomTemp: 24.5 }],
    ['只改运行模式', { systemMode: pb.UnifiedCtrlSetQuery_OperatingMode.OPERATION_MODE_AUTO }, { systemMode: 100 }],
  ]
  for (const [name, changes, target] of cases) {
    it(name, () => expect203(onWire(Q203, buildUnifiedCtrlSet(changes)), target))
  }

  it('「全部开启」的实际 base64：system_mode 按 int32 编成 10 字节的 -1（不再是 11/25 00:20 那条省略 = 0 的请求）', () => {
    const b64 = encodeMessage(Q203, buildUnifiedCtrlSet({ roomSwitch: 1 }))
    // 08 <-1> 10 <-1> 18 01 25 <-1.0f>
    expect(b64).toBe('CP///////////wEQ////////////ARgBJQAAgL8=')
    expect(onWire(Q203, buildUnifiedCtrlSet({ roomSwitch: 1 })).systemMode).toBe(-1)
    // 11/25 00:20 实际发出的请求体：没有 #2，后端解出 system_mode = 0
    expect(fromBinary(Q203, base64Decode('CP///////////wEYASUAAIC/')).systemMode).toBe(0)
    expect(MODE_UNCHANGED).toBe(-1)
  })

  it('S12 页面层：validateUnified 只开房间，组装出的 203 运行模式线上为 -1', () => {
    const v = validateUnified({ roomSwitch: 1 }, { projectId: 'p1', projectCode: '240829001', appCode: 1, online: true })
    if (!v.ok) throw new Error(v.errors.join())
    expect203(onWire(Q203, v.query), { roomSwitch: 1 })
  })

  it('proto 字段集合与本测试覆盖的一致（加字段时失败）', () => {
    expect(Q203).toBe(pb.UnifiedCtrlSetQuerySchema)
    expect(Q203.fields.map((f) => f.localName).sort()).toEqual([...SCALARS_203].sort())
  })
})

const DEV = 1514027092
const SCALARS_204 = ['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch'] as const
function expect204(m: Record<string, unknown>, target: Partial<Record<(typeof SCALARS_204)[number], number>>) {
  expect(m.id).toBe(BigInt(DEV))
  expect(m.name).toBe('新风1')
  for (const k of SCALARS_204) expect(m[k], k).toBe(k in target ? target[k] : -1)
}

describe('204 RunningCtrlSetQuery 线上字节：不改的标量为 -1', () => {
  const cases: Array<[string, Parameters<typeof buildRunningCtrlSet>[2], Partial<Record<(typeof SCALARS_204)[number], number>>]> = [
    ['什么都不改', {}, {}],
    ['只改露点', { dewPoint: 14 }, { dewPoint: 14 }],
    ['只改湿度', { humiditySet: 55 }, { humiditySet: 55 }],
    ['只改为湿度控制（0 是真实值）', { controlType: 0 }, { controlType: 0 }],
    ['只改风速为低（0 是真实值）', { windSpeed: 0 }, { windSpeed: 0 }],
    ['只关新风（0 是真实值）', { switch: 0 }, { switch: 0 }],
  ]
  for (const [name, changes, target] of cases) {
    it(name, () => expect204(onWire(Q204, buildRunningCtrlSet(DEV, '新风1', changes)), target))
  }
  it('proto 字段集合与本测试覆盖的一致（加字段时失败）', () => {
    expect(Q204).toBe(pb.RunningCtrlSetQuerySchema)
    expect(Q204.fields.map((f) => f.localName).sort()).toEqual(['id', 'name', ...SCALARS_204].sort())
  })
})

describe('防回归：遍历 proto 字段描述，所有写消息的数值标量 / 枚举在「全部不变」时都是 -1', () => {
  /** 组装函数的「什么都不改」：只给目标 id 等必填项 */
  const NOTHING: Record<(typeof WRITE_CTRL)[number], () => object | null> = {
    201: () => buildRoomTemperatureSet(EQ),
    203: () => buildUnifiedCtrlSet(),
    204: () => buildRunningCtrlSet(DEV, '新风1'),
    206: () => null, // 只有 switch 一个字段，必须明确开 / 关（上面已测）
  }
  /** 目标 id：明确给出的，不按 -1 查 */
  const IDS = new Set(['equipmentId', 'id'])

  const NON_NUMERIC = new Set([ScalarType.STRING, ScalarType.BOOL, ScalarType.BYTES])
  function numericFields(schema: DescMessage, path = ''): string[] {
    const out: string[] = []
    for (const f of schema.fields) {
      if (f.fieldKind === 'message') out.push(...numericFields(f.message, path + f.localName + '.'))
      else if (f.fieldKind === 'enum' || (f.fieldKind === 'scalar' && !NON_NUMERIC.has(f.scalar))) out.push(path + f.localName)
    }
    return out
  }

  for (const t of WRITE_CTRL) {
    it(`${t}：每个数值字段（含以后新增的）线上都是 -1，列表为空`, () => {
      const schema = CTRL[t].query
      const q = NOTHING[t]()
      if (!q) return
      const m = onWire(schema, q)
      const fields = numericFields(schema).filter((k) => !IDS.has(k))
      expect(fields.length).toBeGreaterThan(0)
      for (const k of fields) expect(m[k], `${t}.${k}`).toBe(-1)
      for (const f of schema.fields) if (f.fieldKind === 'list') expect(m[f.localName], `${t}.${f.localName}`).toEqual([])
    })
    it(`${t}：unchangedOf 底板覆盖 proto 里每个数值字段与列表`, () => {
      const schema = CTRL[t].query
      const base = unchangedOf(schema)
      for (const k of numericFields(schema)) expect(base[k], `${t}.${k}`).toBe(-1)
      for (const f of schema.fields) if (f.fieldKind === 'list') expect(base[f.localName]).toEqual([])
    })
  }
})
