import { describe, expect, it } from 'vitest'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'
import { DEFAULT_TEMP_RANGE, MODE_OPTIONS, TEMP_MAX, TEMP_MIN, TEMP_STEP, TEXT } from '../constants'
import { changedFields, checkTemp, clampTemp, describeQuery, echoMismatches, echoVerdict, resolveTempRange, tempAvailability, validateUnified, type UnifiedContext } from '../rules'

const ctx = (p: Partial<UnifiedContext> = {}): UnifiedContext => ({ projectId: 'p-0000000000000001', projectCode: '240829001', projectName: '测试项目0829', appCode: 1, online: true, ...p })

describe('常量', () => {
  it('温度 16–30°C，步长 0.5', () => {
    expect([TEMP_MIN, TEMP_MAX, TEMP_STEP]).toEqual([16, 30, 0.5])
    expect(DEFAULT_TEMP_RANGE).toEqual({ min: 16, max: 30, step: 0.5 })
    expect(Object.isFrozen(DEFAULT_TEMP_RANGE)).toBe(true)
  })
  it('运行模式 14 个，不含 0（不变）', () => {
    expect(MODE_OPTIONS).toHaveLength(14)
    expect(MODE_OPTIONS.map((o) => o.value)).not.toContain(0)
  })
})

describe('app_code 规则', () => {
  it('1 可设温度', () => expect(tempAvailability(1)).toEqual({ enabled: true }))
  it.each([12, 8])('%s 禁用温度', (code) => expect(tempAvailability(code)).toEqual({ enabled: false, reason: TEXT.tempDisabledByApp }))
  it.each([4, 7, 9, 1000, 0, NaN, null, undefined])('其他或缺失（%s）按未知处理、禁用', (code) => {
    expect(tempAvailability(code as number)).toEqual({ enabled: false, reason: TEXT.tempDisabledUnknownApp })
  })
  it.each([12, 8])('app %s：带温度的下发被拒，开关和模式照常可下发', (appCode) => {
    expect(validateUnified({ roomTemp: 24 }, ctx({ appCode }))).toMatchObject({ ok: false, errors: [TEXT.tempDisabledByApp] })
    const v = validateUnified({ roomSwitch: 1, systemSwitch: 0, systemMode: Mode.OPERATION_MODE_AUTO }, ctx({ appCode }))
    expect(v).toEqual({ ok: true, query: { systemSwitch: 0, systemMode: 100, roomSwitch: 1, roomTemp: -1 } })
  })
  it('app 1：温度可下发', () => {
    expect(validateUnified({ roomTemp: 24.5 }, ctx())).toEqual({ ok: true, query: { systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: 24.5 } })
  })
})

describe('温度范围与步进', () => {
  it.each([16, 16.5, 25, 29.5, 30])('%s 合法', (t) => expect(checkTemp(t)).toBeNull())
  it.each([15.5, 30.5, -1, 100])('%s 超范围', (t) => expect(checkTemp(t)).toBe(TEXT.tempOutOfRange(DEFAULT_TEMP_RANGE)))
  it.each([16.2, 24.25, 29.9])('%s 不在步进上', (t) => expect(checkTemp(t)).toBe(TEXT.tempBadStep(DEFAULT_TEMP_RANGE)))
  it.each([NaN, Infinity, '24', null])('%s 无效', (t) => expect(checkTemp(t)).toBe(TEXT.tempNotNumber))
  it('后端给范围时按后端；缺项逐项回退；不合理整体回退', () => {
    expect(resolveTempRange({ min: 18, max: 28, step: 1 })).toEqual({ min: 18, max: 28, step: 1 })
    expect(resolveTempRange({ max: 26 })).toEqual({ min: 16, max: 26, step: 0.5 })
    expect(resolveTempRange({ min: 30, max: 16 })).toEqual(DEFAULT_TEMP_RANGE)
    expect(resolveTempRange({ step: 0 })).toEqual(DEFAULT_TEMP_RANGE)
    expect(resolveTempRange(null)).toEqual(DEFAULT_TEMP_RANGE)
    expect(validateUnified({ roomTemp: 29 }, ctx({ tempRange: { max: 28 } }))).toMatchObject({ ok: false })
  })
  it('clampTemp 收进范围并对齐步进', () => {
    expect(clampTemp(10)).toBe(16)
    expect(clampTemp(31)).toBe(30)
    expect(clampTemp(24.3)).toBe(24.5)
    expect(clampTemp(24.2)).toBe(24)
    expect(clampTemp(NaN)).toBe(16)
  })
})

describe('离线拦截', () => {
  it.each([false, undefined, null])('online=%s 不允许下发', (online) => {
    const v = validateUnified({ roomSwitch: 1 }, ctx({ online: online as boolean }))
    expect(v).toMatchObject({ ok: false, errors: [TEXT.offline] })
  })
  it('没有项目', () => {
    expect(validateUnified({ roomSwitch: 1 }, null)).toMatchObject({ ok: false, errors: [TEXT.noProject] })
    expect(validateUnified({ roomSwitch: 1 }, ctx({ projectId: '' }))).toMatchObject({ ok: false, errors: [TEXT.noProject] })
  })
})

describe('-1 填充', () => {
  it('不改的字段一律 -1，模式不改为 0', () => {
    expect(validateUnified({ systemSwitch: 1 }, ctx())).toEqual({ ok: true, query: { systemSwitch: 1, systemMode: 0, roomSwitch: -1, roomTemp: -1 } })
    expect(validateUnified({ roomSwitch: 0 }, ctx())).toEqual({ ok: true, query: { systemSwitch: -1, systemMode: 0, roomSwitch: 0, roomTemp: -1 } })
    expect(validateUnified({ systemMode: Mode.OPERATION_MODE_SUMMER }, ctx())).toEqual({ ok: true, query: { systemSwitch: -1, systemMode: 2, roomSwitch: -1, roomTemp: -1 } })
  })
  it('显式 undefined 也算不变', () => {
    expect(validateUnified({ systemSwitch: undefined, roomTemp: undefined, roomSwitch: 1 }, ctx())).toMatchObject({ ok: true, query: { systemSwitch: -1, roomTemp: -1 } })
  })
  it('0（关闭）不会被当成不变', () => {
    expect(validateUnified({ systemSwitch: 0, roomSwitch: 0 }, ctx())).toMatchObject({ ok: true, query: { systemSwitch: 0, roomSwitch: 0 } })
  })
  it('全部不变不允许下发', () => {
    expect(validateUnified({}, ctx())).toMatchObject({ ok: false, errors: [TEXT.noChanges] })
  })
})

describe('其他校验', () => {
  it('开关只认 0/1', () => {
    expect(validateUnified({ systemSwitch: 2 as never }, ctx())).toMatchObject({ ok: false, errors: [TEXT.badSwitch(TEXT.systemSwitch)] })
    expect(validateUnified({ roomSwitch: -1 as never }, ctx())).toMatchObject({ ok: false, errors: expect.arrayContaining([TEXT.badSwitch(TEXT.roomSwitch)]) })
    expect(validateUnified({ roomSwitch: true as never }, ctx())).toMatchObject({ ok: false })
  })
  it('模式必须是列出的值', () => {
    expect(validateUnified({ systemMode: 7 as Mode }, ctx())).toMatchObject({ ok: false, errors: [TEXT.badMode] })
    // 0 = 不变，等同于没选
    expect(validateUnified({ systemMode: 0 as Mode }, ctx())).toMatchObject({ ok: false, errors: [TEXT.noChanges] })
    expect(validateUnified({ systemMode: 0 as Mode, roomSwitch: 1 }, ctx())).toMatchObject({ ok: true, query: { systemMode: 0, roomSwitch: 1 } })
  })
  it('关闭房间同时设温度被拒', () => {
    expect(validateUnified({ roomSwitch: 0, roomTemp: 24 }, ctx())).toMatchObject({ ok: false, errors: [TEXT.tempWhileRoomOff] })
  })
  it('describeQuery 只列有改动的项', () => {
    expect(describeQuery({ systemSwitch: -1, systemMode: 100, roomSwitch: 0, roomTemp: -1 })).toEqual([
      { label: TEXT.systemMode, value: '自动模式' },
      { label: TEXT.roomSwitch, value: TEXT.off },
    ])
    expect(describeQuery({ systemSwitch: 1, systemMode: 0, roomSwitch: -1, roomTemp: 25.5 })).toEqual([
      { label: TEXT.systemSwitch, value: TEXT.on },
      { label: TEXT.roomTemp, value: '25.5°C' },
    ])
  })
})

describe('echoMismatches（逐字段核对）', () => {
  const q = { systemSwitch: 1, systemMode: 100, roomSwitch: -1, roomTemp: 24.5 }
  it('只核对下发了的字段，一致时为空', () => {
    expect(echoMismatches(q, { systemSwitch: 1, systemMode: 100, roomSwitch: 0, roomTemp: 24.500001 })).toEqual([])
  })
  it('不一致、没读到分别给出字段和说明', () => {
    expect(echoMismatches(q, { systemSwitch: 0, systemMode: null, roomTemp: 22 })).toEqual([
      { field: 'systemSwitch', kind: 'differ', message: TEXT.echoDiffer(TEXT.systemSwitch, TEXT.on, TEXT.off) },
      { field: 'systemMode', kind: 'missing', message: TEXT.echoMissing(TEXT.systemMode) },
      { field: 'roomTemp', kind: 'differ', message: TEXT.echoDiffer(TEXT.roomTemp, '24.5°C', '22°C') },
    ])
  })
  it('不给键 = 回读接口读不到（未核对 unreadable）；给 null = 设备没回报（missing）', () => {
    expect(echoMismatches({ systemSwitch: 1, systemMode: 0, roomSwitch: 1, roomTemp: -1 }, { roomSwitch: null })).toEqual([
      { field: 'systemSwitch', kind: 'unreadable', message: TEXT.echoUnreadable(TEXT.systemSwitch) },
      { field: 'roomSwitch', kind: 'missing', message: TEXT.echoMissing(TEXT.roomSwitch) },
    ])
  })
  it('逐房间核对：有读到不一致 → differ（标出几个房间）；读到的都一致但有房间没回报 → missing；全部一致 → 空', () => {
    const q2 = { systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 }
    expect(echoMismatches(q2, { roomSwitch: null, perRoom: { roomSwitch: [1, 0, null] } })).toEqual([
      { field: 'roomSwitch', kind: 'differ', message: TEXT.echoDiffer(TEXT.roomSwitch, TEXT.on, TEXT.off) + TEXT.echoPart(3, 1) },
    ])
    expect(echoMismatches(q2, { roomSwitch: null, perRoom: { roomSwitch: [1, null] } })).toEqual([{ field: 'roomSwitch', kind: 'missing', message: TEXT.echoMissing(TEXT.roomSwitch) }])
    expect(echoMismatches(q2, { roomSwitch: null, perRoom: { roomSwitch: [] } })).toEqual([{ field: 'roomSwitch', kind: 'missing', message: TEXT.echoMissing(TEXT.roomSwitch) }])
    expect(echoMismatches(q2, { roomSwitch: 1, perRoom: { roomSwitch: [1, 1] } })).toEqual([])
  })
  it('echoVerdict：只有 differ → unchanged；有 missing / unreadable → unverifiable；空 → applied', () => {
    expect(echoVerdict([])).toBe('applied')
    expect(echoVerdict([{ field: 'roomTemp', kind: 'differ', message: '' }])).toBe('unchanged')
    // 混合：整体按最不确定的算（Fable 11/24）
    expect(echoVerdict([{ field: 'roomSwitch', kind: 'missing', message: '' }, { field: 'roomTemp', kind: 'differ', message: '' }])).toBe('unverifiable')
    expect(echoVerdict([{ field: 'systemSwitch', kind: 'unreadable', message: '' }, { field: 'roomSwitch', kind: 'differ', message: '' }])).toBe('unverifiable')
    expect(echoVerdict([{ field: 'systemSwitch', kind: 'unreadable', message: '' }])).toBe('unverifiable')
    // 有离线房间、没有不一致 → 结果未知
    expect(echoVerdict([], { roomSwitch: 1, offline: 1 })).toBe('unknown')
    // 有离线房间又有不一致：结果未知比未变化更不确定
    expect(echoVerdict([{ field: 'roomSwitch', kind: 'differ', message: '' }], { offline: 1 })).toBe('unknown')
  })
  it('回读为空：所有下发字段都算没读到', () => {
    expect(echoMismatches(q, null).map((m) => [m.field, m.kind])).toEqual([['systemSwitch', 'missing'], ['systemMode', 'missing'], ['roomTemp', 'missing']])
  })
  it('开关回读到异常值时显示原始数字', () => {
    expect(echoMismatches({ systemSwitch: 0, systemMode: 0, roomSwitch: -1, roomTemp: -1 }, { systemSwitch: 2 })[0].message).toBe(TEXT.echoDiffer(TEXT.systemSwitch, TEXT.off, '2'))
  })
  it('全是不变时不核对任何字段；changedFields 只列改了的', () => {
    expect(echoMismatches({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: -1 }, {})).toEqual([])
    expect(changedFields(q)).toEqual(['systemSwitch', 'systemMode', 'roomTemp'])
  })
})

describe('校验问题带固定代码', () => {
  it('issues 与 errors 一一对应', () => {
    const v = validateUnified({ roomTemp: 24, roomSwitch: 0 }, ctx({ online: false, appCode: 12 }))
    expect(v).toMatchObject({ ok: false, issues: [{ code: 'OFFLINE' }, { code: 'TEMP_DISABLED' }, { code: 'TEMP_WHILE_ROOM_OFF' }] })
  })
})
