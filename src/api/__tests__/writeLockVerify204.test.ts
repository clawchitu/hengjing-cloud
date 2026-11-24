import { describe, expect, it } from 'vitest'
import { BLOCK_204_CONTROL_TYPE, BLOCK_204_INVALID, BLOCK_204_UNINITIALIZED, blocked204, matchRunningCtrl, VERIFIABLE_FIELDS } from '../writeLockVerify'
import { checkSentRecord } from '../writeLock'

const ID = 1514027092
const NONE = { controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: -1, switch: -1 }
const rec = (t: Partial<typeof NONE>) => ({ msg: 204, deviceId: ID, target: { ...NONE, ...t } })
// 11/25 实测 260911001 的 210：control_type、switch、can_change 缺省（= 0），humidity_set = -1
const live = { id: ID, name: 'TXFS500', controlType: 0, dewPoint: 13, humiditySet: -1, windSpeed: 2, switch: 0, canChange: false }

describe('matchRunningCtrl（204 → 210）', () => {
  it('可核对字段清单', () => {
    expect(VERIFIABLE_FIELDS[204]).toEqual(['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch'])
  })
  it('四态各一例', () => {
    expect(matchRunningCtrl(rec({ windSpeed: 2 }), live)).toEqual({ verdict: 'applied', fields: { windSpeed: 'applied' } })
    expect(matchRunningCtrl(rec({ windSpeed: 1 }), live)).toEqual({ verdict: 'unchanged', fields: { windSpeed: 'unchanged' } })
    expect(matchRunningCtrl(rec({ humiditySet: 50 }), live)).toEqual({ verdict: 'unverifiable', fields: { humiditySet: 'unverifiable' } })
    expect(matchRunningCtrl(rec({ windSpeed: 2 }), live, { connected: false })).toEqual({ verdict: 'unknown', fields: { windSpeed: 'unknown' } })
  })
  it('control_type / switch / wind_speed 缺省 0 是真实读数：判一致和不一致', () => {
    const omitted = { id: ID, dewPoint: 13 } // 三个字段都没出现在线上
    expect(matchRunningCtrl(rec({ controlType: 0 }), omitted)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ controlType: 1 }), omitted)).toMatchObject({ verdict: 'unchanged' })
    expect(matchRunningCtrl(rec({ switch: 0 }), omitted)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ switch: 1 }), omitted)).toMatchObject({ verdict: 'unchanged' })
    expect(matchRunningCtrl(rec({ windSpeed: 0 }), omitted)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ windSpeed: 2 }), omitted)).toMatchObject({ verdict: 'unchanged' })
  })
  it('设定值：浮点按 0.05；读数 -1、65536 无法核对；control_type = -1 时设定值无法核对', () => {
    expect(matchRunningCtrl(rec({ dewPoint: 13.02 }), live)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ dewPoint: 13.5 }), live)).toMatchObject({ verdict: 'unchanged' })
    expect(matchRunningCtrl(rec({ dewPoint: 13 }), { ...live, dewPoint: 65536 })).toMatchObject({ verdict: 'unverifiable' })
    expect(matchRunningCtrl(rec({ dewPoint: 13 }), { ...live, controlType: -1 })).toMatchObject({ verdict: 'unverifiable' })
  })
  it('id 不符、空回包、只有错误文案的回包 → 全部无法核对', () => {
    for (const reply of [{ ...live, id: 9326461980 }, {}, null, { name: '该软件类型不支持此控制' }]) {
      expect(matchRunningCtrl(rec({ windSpeed: 2, switch: 0 }), reply as never)).toEqual({ verdict: 'unverifiable', fields: { windSpeed: 'unverifiable', switch: 'unverifiable' } })
    }
  })
  it('混合字段按 verdictOf 汇总（未变化 > 无法核对 > 已生效）', () => {
    expect(matchRunningCtrl(rec({ windSpeed: 2, humiditySet: 50, switch: 1 }), live))
      .toEqual({ verdict: 'unchanged', fields: { windSpeed: 'applied', humiditySet: 'unverifiable', switch: 'unchanged' } })
  })
  it('核对数据不对 → false', () => {
    expect(matchRunningCtrl(rec({}), live)).toBe(false)
    expect(matchRunningCtrl({ ...rec({ windSpeed: 2 }), msg: 201 }, live)).toBe(false)
    expect(matchRunningCtrl({ ...rec({ windSpeed: 2 }), deviceId: null }, live)).toBe(false)
  })
})

describe('blocked204（Fable 11/25 裁定）', () => {
  it('读数 control_type = -1：写入口整体禁用', () => {
    expect(blocked204({ ...live, controlType: -1, humiditySet: 50 }, ['windSpeed'])).toBe(BLOCK_204_CONTROL_TYPE)
    expect(blocked204({ ...live, controlType: -1 }, ['controlType'], 'minus1')).toBe(BLOCK_204_CONTROL_TYPE)
  })
  it('echo：没改的设定项读到 -1 / 65536 → 整条不发；改了它就不拦', () => {
    expect(blocked204(live, ['windSpeed'])).toBe(BLOCK_204_UNINITIALIZED) // 实测 humidity_set = -1
    expect(blocked204(live, ['windSpeed', 'humiditySet'])).toBeNull()
    expect(blocked204({ ...live, humiditySet: 50, dewPoint: 65536 }, ['windSpeed'])).toBe(BLOCK_204_UNINITIALIZED)
    expect(blocked204({ ...live, humiditySet: 50, windSpeed: -1 }, ['switch'])).toBe(BLOCK_204_UNINITIALIZED)
  })
  it('echo：缺省 0 是真实读数，不算未初始化；switch 不参与', () => {
    expect(blocked204({ id: ID, dewPoint: 13, humiditySet: 50 }, ['switch'])).toBeNull()
    expect(blocked204({ ...live, humiditySet: 50, switch: -1 }, ['windSpeed'])).toBeNull()
  })
  it('echo：没改的枚举读数越界、设定值非有限数 → 整条不发', () => {
    const ok = { ...live, humiditySet: 50 }
    expect(blocked204(ok, ['switch'])).toBeNull()
    expect(blocked204({ ...ok, windSpeed: 3 }, ['switch'])).toBe(BLOCK_204_INVALID)
    expect(blocked204({ ...ok, controlType: 2 }, ['switch'])).toBe(BLOCK_204_INVALID)
    expect(blocked204({ ...ok, windSpeed: 3 }, ['windSpeed'])).toBeNull() // 改了的字段由 checkSentRecord 管
    for (const bad of [NaN, Infinity]) expect(blocked204({ ...ok, dewPoint: bad }, ['switch'])).toBe(BLOCK_204_UNINITIALIZED)
  })
  it('minus1：没改的字段本来就传 -1，不拦', () => {
    expect(blocked204(live, ['windSpeed'], 'minus1')).toBeNull()
  })
})

describe('checkSentRecord(204)', () => {
  it('deviceId 为 null、0、负数、小数 → 拒绝', () => {
    for (const deviceId of [null, 0, -5, 1.5]) expect(checkSentRecord({ ...rec({ windSpeed: 1 }), deviceId })).toMatch(/没有读到新风设备 id.*未下发/)
  })
  it('正常记录通过；没有改动、枚举越界、设定值非有限数 → 拒绝', () => {
    expect(checkSentRecord(rec({ windSpeed: 1 }))).toBeNull()
    expect(checkSentRecord(rec({ dewPoint: 12.5, controlType: 1 }))).toBeNull()
    expect(checkSentRecord(rec({}))).toMatch(/没有要下发的改动/)
    expect(checkSentRecord(rec({ windSpeed: 3 }))).toMatch(/不合规/)
    expect(checkSentRecord(rec({ controlType: 2 }))).toMatch(/不合规/)
    expect(checkSentRecord(rec({ switch: 2 }))).toMatch(/不合规/)
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(checkSentRecord(rec({ dewPoint: bad }))).toMatch(/不合规/)
      expect(checkSentRecord(rec({ humiditySet: bad }))).toMatch(/不合规/)
    }
  })
  it('只认 204 的五个字段：未知 / 拼错的键 → 拒绝', () => {
    expect(checkSentRecord({ msg: 204, deviceId: ID, target: { windSpead: 1 } })).toMatch(/不合规/)
    expect(checkSentRecord({ msg: 204, deviceId: ID, target: { ...NONE, windSpeed: 1, extra: -1 } })).toMatch(/不合规/)
  })
})
