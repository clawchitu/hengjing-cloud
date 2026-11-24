import { describe, expect, it } from 'vitest'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'
import { DEFAULT_TEMP_RANGE, MODE_OPTIONS, TEMP_MAX, TEMP_MIN, TEMP_STEP, TEXT } from '../constants'
import { checkTemp, clampTemp, describeQuery, echoMismatches, resolveTempRange, tempAvailability, validateUnified, type UnifiedContext } from '../rules'

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
    expect(validateUnified({ roomTemp: 24 }, ctx({ appCode }))).toEqual({ ok: false, errors: [TEXT.tempDisabledByApp] })
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
    expect(v).toEqual({ ok: false, errors: [TEXT.offline] })
  })
  it('没有项目', () => {
    expect(validateUnified({ roomSwitch: 1 }, null)).toEqual({ ok: false, errors: [TEXT.noProject] })
    expect(validateUnified({ roomSwitch: 1 }, ctx({ projectId: '' }))).toEqual({ ok: false, errors: [TEXT.noProject] })
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
    expect(validateUnified({}, ctx())).toEqual({ ok: false, errors: [TEXT.noChanges] })
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
    expect(validateUnified({ systemMode: 0 as Mode }, ctx())).toEqual({ ok: false, errors: [TEXT.noChanges] })
    expect(validateUnified({ systemMode: 0 as Mode, roomSwitch: 1 }, ctx())).toMatchObject({ ok: true, query: { systemMode: 0, roomSwitch: 1 } })
  })
  it('关闭房间同时设温度被拒', () => {
    expect(validateUnified({ roomSwitch: 0, roomTemp: 24 }, ctx())).toEqual({ ok: false, errors: [TEXT.tempWhileRoomOff] })
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

describe('echoMismatches（默认核对）', () => {
  const q = { systemSwitch: 1, systemMode: 100, roomSwitch: -1, roomTemp: 24.5 }
  it('只核对下发了的字段，一致时为空', () => {
    expect(echoMismatches(q, { systemSwitch: 1, systemMode: 100, roomSwitch: 0, roomTemp: 24.500001 })).toEqual([])
  })
  it('不一致、没读到分别给出说明', () => {
    expect(echoMismatches(q, { systemSwitch: 0, systemMode: null, roomTemp: 22 })).toEqual([
      TEXT.echoDiffer(TEXT.systemSwitch, TEXT.on, TEXT.off),
      TEXT.echoMissing(TEXT.systemMode),
      TEXT.echoDiffer(TEXT.roomTemp, '24.5°C', '22°C'),
    ])
  })
  it('全是不变时不核对任何字段', () => {
    expect(echoMismatches({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: -1 }, {})).toEqual([])
  })
})
