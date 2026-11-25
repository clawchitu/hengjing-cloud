import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage } from '@/api/ctrl'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { ApiError } from '@/api/errors'
import { BLOCK_204_CONTROL_TYPE, BLOCK_204_NOT_SETTABLE, FIELDS_204, settable204 } from '@/api/writeLockVerify'
import { fieldBlock, fieldOf, SettingsMismatch, toSettingsView, toUnitViews, type Raw202, type Raw210 } from '../model'
import { ID_240829001, ID_260911001, R202_240829001, R202_260911001, R210_240829001, R210_260911001 } from './fixtures'

const d202 = (b64: string) => decodeReply(pb.FreshDehumidifierGetReplySchema, b64) as Raw202
const d210 = (b64: string) => decodeReply(pb.RunningCtrlGetReplySchema, b64) as Raw210
const enc202 = (data: object[]) => d202(encodeMessage(pb.FreshDehumidifierGetReplySchema, { data }))

describe('202 真实回包解码 → UnitView', () => {
  it('260911001：设备 id 取自 202，缺省 0 是有效读数，滤网按天数和比例', () => {
    const [u, ...rest] = toUnitViews(d202(R202_260911001))
    expect(rest).toEqual([])
    expect(u).toMatchObject({
      key: String(ID_260911001), deviceId: ID_260911001, name: '',
      supplyTemp: 0, returnTemp: 0, windLevel: 0, fanSpeed: 0, compressorStatus: 0, compressorFreq: 20,
      filter: { days: 100, ratio: 1, percent: 100 }, filterRunning: 0, runningMode: '制热', runningTime: 0, on: false, connected: true,
    })
  })
  it('240829001：另一台设备 id，running_time 1', () => {
    expect(toUnitViews(d202(R202_240829001))).toMatchObject([{ deviceId: ID_240829001, runningMode: '除湿', runningTime: 1, connected: true }])
  })
  it('65536、-100 → null；running_mode 空串；is_connected 缺省为未连接', () => {
    const [u] = toUnitViews(enc202([{ id: 7, supplyTemp: 65536, returnTemp: -100, dehumidifierFreq: 65536, filterLife: -100, filterLifeP: 65536, switch: 1 }]))
    expect(u).toMatchObject({ supplyTemp: null, returnTemp: null, compressorFreq: null, filter: { days: null, ratio: null }, runningMode: '', on: true, connected: false })
  })
  it('设备 id 无效或重复：deviceId 为 null（不能拿去读 210），键不重复', () => {
    const list = toUnitViews(enc202([{ id: 5, name: 'a' }, { id: 5, name: 'b' }, { name: '缺省 0' }, { id: -3 }, { id: 9 }]))
    expect(list.map((u) => u.deviceId)).toEqual([null, null, null, null, 9])
    expect(new Set(list.map((u) => u.key)).size).toBe(5)
  })
  it('空回包 → 空列表', () => {
    expect(toUnitViews(d202(''))).toEqual([])
    expect(toUnitViews(null)).toEqual([])
  })
})

describe('210 真实回包解码 → SettingsView（三类标注）', () => {
  it('260911001：湿度设定 -1 不可设置，其余可设置；缺省 0 是真实读数', () => {
    const v = toSettingsView(d210(R210_260911001), ID_260911001)
    expect(v).toEqual({
      deviceId: ID_260911001, name: 'TXFS500', canChange: false, writeBlock: null,
      fields: {
        controlType: { state: 'settable', value: 0 },
        dewPoint: { state: 'settable', value: 13 },
        humiditySet: { state: 'unsettable', value: null },
        windSpeed: { state: 'settable', value: 2 },
        switch: { state: 'settable', value: 0 },
      },
    })
    expect(fieldBlock(v, 'humiditySet')).toBe(BLOCK_204_NOT_SETTABLE)
    expect(fieldBlock(v, 'windSpeed')).toBeNull()
  })
  it('-100 / 65536 / 枚举外 → 无效；-1 → 不可设置；0 → 可设置', () => {
    expect(fieldOf('dewPoint', -100)).toEqual({ state: 'invalid', value: null })
    expect(fieldOf('humiditySet', 65536)).toEqual({ state: 'invalid', value: null })
    expect(fieldOf('dewPoint', Number.NaN)).toEqual({ state: 'invalid', value: null })
    expect(fieldOf('windSpeed', 3)).toEqual({ state: 'invalid', value: null })
    expect(fieldOf('switch', 2)).toEqual({ state: 'invalid', value: null })
    expect(fieldOf('controlType', 5)).toEqual({ state: 'invalid', value: null })
    expect(fieldOf('windSpeed', -1)).toEqual({ state: 'unsettable', value: null })
    expect(fieldOf('dewPoint', 0)).toEqual({ state: 'settable', value: 0 })
    expect(fieldOf('switch', undefined)).toEqual({ state: 'settable', value: 0 })
  })
  it('control_type 1 露点控制、can_change 为真', () => {
    const v = toSettingsView({ id: 3, controlType: 1, dewPoint: 12.5, humiditySet: 50, windSpeed: 1, switch: 1, canChange: true }, 3)
    expect(v.fields.controlType).toEqual({ state: 'settable', value: 1 })
    expect(v.canChange).toBe(true)
    expect(v.writeBlock).toBeNull()
  })
  it('control_type = -1：控制类型、露点、湿度不可设置，整个写入口禁用', () => {
    const v = toSettingsView({ id: 3, controlType: -1, dewPoint: 12, humiditySet: 50, windSpeed: 1, switch: 1 }, 3)
    expect(v.fields).toMatchObject({ controlType: { state: 'unsettable' }, dewPoint: { state: 'unsettable' }, humiditySet: { state: 'unsettable' }, windSpeed: { state: 'settable', value: 1 } })
    expect(v.writeBlock).toBe(BLOCK_204_CONTROL_TYPE)
    for (const f of FIELDS_204) expect(fieldBlock(v, f)).toBe(BLOCK_204_CONTROL_TYPE)
  })
  it('control_type 无效（-100）：写入口也禁用', () => {
    const v = toSettingsView({ id: 3, controlType: -100 }, 3)
    expect(v.fields.controlType.state).toBe('invalid')
    expect(v.writeBlock).not.toBeNull()
    expect(fieldBlock(v, 'switch')).toBe(v.writeBlock)
  })
  it('标注与 settable204 一致：读数有效时，不可设置 ⇔ settable204 给出原因', () => {
    const cases: Raw210[] = [
      d210(R210_260911001),
      { id: 3, controlType: -1, dewPoint: 1, humiditySet: 2, windSpeed: -1, switch: 0 },
      { id: 3, controlType: 1, dewPoint: -1, humiditySet: 40, windSpeed: 0, switch: -1 },
    ]
    for (const raw of cases) {
      const v = toSettingsView(raw, 3 === raw.id ? 3 : ID_260911001)
      const s = settable204(raw)
      for (const f of FIELDS_204) expect(v.fields[f].state === 'unsettable').toBe(s[f] !== null)
    }
  })
  it('已知差异：-100 / 65536 这里记 invalid 并禁用（更严），settable204 不因此禁用（规则草稿 4.1 已写明）', () => {
    const raw = { id: 3, controlType: 1, dewPoint: 65536, humiditySet: -100 }
    const v = toSettingsView(raw, 3)
    expect([v.fields.dewPoint.state, v.fields.humiditySet.state]).toEqual(['invalid', 'invalid'])
    expect(fieldBlock(v, 'dewPoint')).not.toBeNull()
    expect(settable204(raw).dewPoint).toBeNull()
  })
  it('240829001 的「不支持」回包：decodeReply 抛 ctrl 错误，文案原样', () => {
    expect(() => d210(R210_240829001)).toThrow(ApiError)
    expect(() => d210(R210_240829001)).toThrow('该软件类型不支持此控制')
  })
  it('回包 id 与请求不符、空回包：抛 SettingsMismatch，不当成读数', () => {
    expect(() => toSettingsView(d210(R210_260911001), ID_240829001)).toThrow(SettingsMismatch)
    expect(() => toSettingsView(d210(''), ID_260911001)).toThrow(SettingsMismatch)
    expect(() => toSettingsView(null, ID_260911001)).toThrow(SettingsMismatch)
    expect(() => toSettingsView({ id: 0 }, 0)).toThrow(SettingsMismatch)
  })
})
