// 写消息线上字节核对（后端 11/25 答复：数值字段不变传 -1，0 是真实值；枚举字段用该枚举里的「不变」值，203 system_mode = 0 = OPERATION_MODE_NONE）。
// proto3 里没赋值的 int 字段线上省略、解码为 0——如果组装时漏了某个字段或用 0 兜底，控制屏会把 0 当真实指令。
// 这里按 ctrl.ts 实际下发的编码（encodeMessage）编成线上字节，再用 proto schema 原样解码，逐字段核对。
import { fromBinary, ScalarType, type DescMessage } from '@bufbuild/protobuf'
import { base64Decode } from '@bufbuild/protobuf/wire'
import { describe, expect, it } from 'vitest'
import { CTRL, ENUM_UNCHANGED, MODE_UNCHANGED, WRITE_CTRL, assertEnumsDefined, buildProjectRoomSwitchSet, buildRoomTemperatureSet, buildRunningCtrlSet, buildUnifiedCtrlSet, decodeReply, encodeMessage, encodeWrite, unchangedOf, validateWriteQuery } from '../ctrl'
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

/** 203 的字段：system_mode 是枚举 OperatingMode，不变是 0（OPERATION_MODE_NONE，枚举里没有 -1）；其余数值字段不变是 -1 */
const SCALARS_203 = ['systemSwitch', 'systemMode', 'roomSwitch', 'roomTemp'] as const
const UNCHANGED_203: Record<(typeof SCALARS_203)[number], number> = { systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: -1 }
function expect203(m: Record<string, unknown>, target: Partial<Record<(typeof SCALARS_203)[number], number>>) {
  for (const k of SCALARS_203) expect(m[k], k).toBe(k in target ? target[k] : UNCHANGED_203[k])
}

describe('203 UnifiedCtrlSetQuery 线上字节：不改的运行模式为 0（枚举 NONE），其余不改的字段为 -1', () => {
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

  it('「全部开启」的实际 base64：system_mode = 0 不上线（#2 省略），后端解出 NONE；不再出现 #60 那条 10 字节的 -1', () => {
    const b64 = encodeMessage(Q203, buildUnifiedCtrlSet({ roomSwitch: 1 }))
    // 08 <-1> 18 01 25 <-1.0f>：与 11/25 00:20 那条请求（后端 success）字节相同
    expect(b64).toBe('CP///////////wEYASUAAIC/')
    expect(onWire(Q203, buildUnifiedCtrlSet({ roomSwitch: 1 })).systemMode).toBe(0)
    expect(MODE_UNCHANGED).toBe(pb.UnifiedCtrlSetQuery_OperatingMode.OPERATION_MODE_NONE)
    expect(MODE_UNCHANGED).toBe(0)
    // #60 的写法（system_mode = -1，10 字节 varint）：后端报 unknown enum、网关 504。现在编码前就拒发
    expect(() => encodeWrite('ctrl-203', Q203, { ...buildUnifiedCtrlSet({ roomSwitch: 1 }), systemMode: -1 })).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
  })

  it('11/25 15:35 真机试发的形状（system_mode = 0、其余 -1、只改温度）：编码通过，线上运行模式为 0', () => {
    const q = buildUnifiedCtrlSet({ roomTemp: 25 })
    expect(() => encodeWrite('ctrl-203', Q203, q)).not.toThrow()
    expect203(onWire(Q203, q), { roomTemp: 25 })
  })

  it('S12 页面层：validateUnified 只开房间，组装出的 203 运行模式线上为 0、其余没改的为 -1', () => {
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

describe('encodeWrite：编码异常统一为 bad_request，不发', () => {
  it('非整数、NaN、无穷、超出 int32 → ApiError(bad_request)，消息里带字段名', () => {
    for (const v of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 40]) {
      expect(() => encodeWrite('ctrl-206', CTRL[206].query, { switch: v }), String(v))
        .toThrow(expect.objectContaining({ kind: 'bad_request', message: expect.stringMatching(/写消息编码失败，未下发.*switch/) }))
    }
    expect(() => encodeWrite('ctrl-203', CTRL[203].query, { ...buildUnifiedCtrlSet({ roomTemp: 26 }), roomSwitch: 0.5 }))
      .toThrow(expect.objectContaining({ kind: 'bad_request' }))
  })
  it('最后防线的拒发仍是 write_blocked（不被包成 bad_request）', () => {
    expect(() => encodeWrite('ctrl-206', CTRL[206].query, { switch: 0 })).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
  })
})

describe('防回归：遍历 proto 字段描述，所有写消息的数值标量在「全部不变」时都是 -1，枚举是该枚举登记的「不变」值', () => {
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
  /** 数值标量字段（不含枚举） */
  function numericFields(schema: DescMessage, path = ''): string[] {
    const out: string[] = []
    for (const f of schema.fields) {
      if (f.fieldKind === 'message') out.push(...numericFields(f.message, path + f.localName + '.'))
      else if (f.fieldKind === 'scalar' && !NON_NUMERIC.has(f.scalar)) out.push(path + f.localName)
    }
    return out
  }
  /** 顶层枚举字段 → 该枚举登记的「不变」值 */
  const enumFields = (schema: DescMessage) => schema.fields.flatMap((f) => (f.fieldKind === 'enum' ? [[f.localName, ENUM_UNCHANGED[f.enum.typeName]] as const] : []))

  for (const t of WRITE_CTRL) {
    it(`${t}：每个数值字段（含以后新增的）线上都是 -1，列表为空`, () => {
      const schema = CTRL[t].query
      const q = NOTHING[t]()
      if (!q) return
      const m = onWire(schema, q)
      const fields = numericFields(schema).filter((k) => !IDS.has(k))
      expect(fields.length).toBeGreaterThan(0)
      for (const k of fields) expect(m[k], `${t}.${k}`).toBe(-1)
      for (const [k, u] of enumFields(schema)) expect(m[k], `${t}.${k}（枚举）`).toBe(u)
      for (const f of schema.fields) if (f.fieldKind === 'list') expect(m[f.localName], `${t}.${f.localName}`).toEqual([])
    })
    it(`${t}：unchangedOf 底板覆盖 proto 里每个数值字段与列表`, () => {
      const schema = CTRL[t].query
      const base = unchangedOf(schema)
      for (const k of numericFields(schema)) expect(base[k], `${t}.${k}`).toBe(-1)
      for (const [k, u] of enumFields(schema)) expect(base[k], `${t}.${k}（枚举）`).toBe(u)
      for (const f of schema.fields) if (f.fieldKind === 'list') expect(base[f.localName]).toEqual([])
    })
  }
  it('203 的 system_mode 是唯一的枚举字段，底板里是 0（OPERATION_MODE_NONE），不是 -1', () => {
    expect(enumFields(Q203)).toEqual([['systemMode', 0]])
    expect(unchangedOf(Q203).systemMode).toBe(0)
    for (const t of [201, 204, 206] as const) expect(enumFields(CTRL[t].query), String(t)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 通用：每条写消息里所有枚举字段（含嵌套消息、列表）的线上值都必须是该枚举里定义过的值，防止以后再有人填 -1

type EnumField = { path: string; typeName: string; values: number[]; unchanged: number | undefined }
/** 遍历 schema（含嵌套消息、列表里的消息），列出所有枚举字段 */
function allEnumFields(schema: DescMessage, path = '', seen = new Set<string>()): EnumField[] {
  if (seen.has(schema.typeName)) return []
  const next = new Set(seen).add(schema.typeName)
  const out: EnumField[] = []
  for (const f of schema.fields) {
    const at = path + f.localName
    const e = f.fieldKind === 'enum' ? f.enum : f.fieldKind === 'list' && f.listKind === 'enum' ? f.enum : null
    if (e) out.push({ path: at, typeName: e.typeName, values: e.values.map((v) => v.number), unchanged: ENUM_UNCHANGED[e.typeName] })
    const m = f.fieldKind === 'message' ? f.message : f.fieldKind === 'list' && f.listKind === 'message' ? f.message : null
    if (m) out.push(...allEnumFields(m, at + '.', next))
  }
  return out
}
/** 按路径取线上解码值（列表取每一项） */
function valuesAt(m: unknown, path: string): unknown[] {
  let cur: unknown[] = [m]
  for (const k of path.split('.')) cur = cur.flatMap((x) => { const v = (x as Record<string, unknown> | null)?.[k]; return Array.isArray(v) ? v : [v] })
  return cur
}

describe('通用：所有写消息的枚举字段，线上编码值都必须是该枚举里定义过的值', () => {
  const SAMPLES: Record<(typeof WRITE_CTRL)[number], Array<[string, object]>> = {
    201: [['什么都不改', buildRoomTemperatureSet(EQ)], ['改温度 + 末端', buildRoomTemperatureSet(EQ, { temperature: 25, endModes: ENDS })]],
    203: [
      ['什么都不改', buildUnifiedCtrlSet()], ['只开房间', buildUnifiedCtrlSet({ roomSwitch: 1 })], ['只改温度', buildUnifiedCtrlSet({ roomTemp: 24 })],
      ['只关系统', buildUnifiedCtrlSet({ systemSwitch: 0 })],
      ...Object.values(pb.UnifiedCtrlSetQuery_OperatingMode).filter((v): v is number => typeof v === 'number')
        .map((v) => [`运行模式 ${v}`, buildUnifiedCtrlSet({ systemMode: v })] as [string, object]),
    ],
    204: [['什么都不改', buildRunningCtrlSet(DEV, '新风1')], ['改风速', buildRunningCtrlSet(DEV, '新风1', { windSpeed: 2 })]],
    206: [['开', buildProjectRoomSwitchSet(true)], ['关', buildProjectRoomSwitchSet(false)]],
  }
  for (const t of WRITE_CTRL) {
    const schema = CTRL[t].query
    const fields = allEnumFields(schema)
    it(`${t}：每个枚举字段都登记了 proto 定义的「不变」值，且该值在枚举里（没登记的枚举必须由调用方给值，否则缺字段拒发）`, () => {
      for (const f of fields) {
        expect(f.unchanged, `${t}.${f.path} 没有登记「不变」值（proto 没定义就不要猜，写进 PR 待后端确认）`).toBeDefined()
        expect(f.values, `${t}.${f.path}`).toContain(f.unchanged)
        expect(f.values, `${t}.${f.path} 枚举里不该有 -1`).not.toContain(-1)
      }
    })
    for (const [name, q] of SAMPLES[t]) {
      it(`${t} ${name}：线上所有枚举字段的值都在枚举里`, () => {
        const m = onWire(schema, q)
        for (const f of fields) for (const v of valuesAt(m, f.path)) expect(f.values, `${t}.${f.path} = ${String(v)}`).toContain(v)
        expect(() => assertEnumsDefined(schema, m)).not.toThrow()
        expect(() => encodeWrite(CTRL[t].write, schema, q)).not.toThrow()
      })
    }
  }
  it('枚举外的值（-1、1、7、101）在编码前拒发 write_blocked，即使明确给出', () => {
    for (const v of [-1, 1, 7, 101]) {
      expect(() => encodeWrite('ctrl-203', Q203, buildUnifiedCtrlSet({ systemMode: v as never })), String(v)).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
      expect(() => encodeWrite('unified-ctrls-send', Q203, buildUnifiedCtrlSet({ systemMode: v as never, roomSwitch: 1 })), String(v)).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
      expect(() => assertEnumsDefined(Q203, { systemSwitch: -1, systemMode: v, roomSwitch: -1, roomTemp: -1 }), String(v)).toThrow(/不在枚举/)
    }
  })
  it('没登记「不变」值的枚举不进底板（不猜），缺字段由 validateWriteQuery 拒发', () => {
    expect(Object.isFrozen(ENUM_UNCHANGED)).toBe(true)
    expect(Object.keys(ENUM_UNCHANGED)).toEqual([pb.UnifiedCtrlSetQuery_OperatingModeSchema.typeName])
    // 模拟一条以后新增的写消息：带一个 proto 没定义「不变」的枚举字段
    const fake = { name: 'FakeSetQuery', typeName: 'ctrlcb.v1.FakeSetQuery', fields: [{ localName: 'mode', fieldKind: 'enum', enum: { typeName: 'ctrlcb.v1.FakeMode', values: [{ number: 0 }, { number: 1 }] } }] } as unknown as DescMessage
    expect(unchangedOf(fake)).toEqual({})
    expect(() => validateWriteQuery(fake, unchangedOf(fake))).toThrow(expect.objectContaining({ kind: 'bad_request', message: expect.stringContaining('mode') }))
  })
})
