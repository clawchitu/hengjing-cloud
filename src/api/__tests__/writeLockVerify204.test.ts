import { describe, expect, it } from 'vitest'
import { BLOCK_204_CONTROL_TYPE, BLOCK_204_INVALID, BLOCK_204_NO_READING, BLOCK_204_UNINITIALIZED, blocked204, matchRunningCtrl, VERIFIABLE_FIELDS } from '../writeLockVerify'
import { checkSentRecord } from '../writeLock'

const ID = 1514027092
const NONE = { controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: -1, switch: -1 }
const ON = { connected: true }
const rec = (t: Partial<typeof NONE>) => ({ msg: 204, deviceId: ID, target: { ...NONE, ...t } })
// 11/25 实测 260911001 的 210：control_type、switch、can_change 缺省（= 0），humidity_set = -1
const live = { id: ID, name: 'TXFS500', controlType: 0, dewPoint: 13, humiditySet: -1, windSpeed: 2, switch: 0, canChange: false }

describe('matchRunningCtrl（204 → 210）', () => {
  it('可核对字段清单', () => {
    expect(VERIFIABLE_FIELDS[204]).toEqual(['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch'])
  })
  it('四态各一例', () => {
    expect(matchRunningCtrl(rec({ windSpeed: 2 }), live, ON)).toEqual({ verdict: 'applied', fields: { windSpeed: 'applied' } })
    expect(matchRunningCtrl(rec({ windSpeed: 1 }), live, ON)).toEqual({ verdict: 'unchanged', fields: { windSpeed: 'unchanged' } })
    expect(matchRunningCtrl(rec({ humiditySet: 50 }), live, ON)).toEqual({ verdict: 'unverifiable', fields: { humiditySet: 'unverifiable' } })
    expect(matchRunningCtrl(rec({ windSpeed: 2 }), live, { connected: false })).toEqual({ verdict: 'unknown', fields: { windSpeed: 'unknown' } })
  })
  it('control_type / switch / wind_speed 缺省 0 是真实读数：判一致和不一致', () => {
    const omitted = { id: ID, dewPoint: 13 } // 三个字段都没出现在线上
    expect(matchRunningCtrl(rec({ controlType: 0 }), omitted, ON)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ controlType: 1 }), omitted, ON)).toMatchObject({ verdict: 'unchanged' })
    expect(matchRunningCtrl(rec({ switch: 0 }), omitted, ON)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ switch: 1 }), omitted, ON)).toMatchObject({ verdict: 'unchanged' })
    expect(matchRunningCtrl(rec({ windSpeed: 0 }), omitted, ON)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ windSpeed: 2 }), omitted, ON)).toMatchObject({ verdict: 'unchanged' })
  })
  it('设定值：浮点按 0.05；读数 -1、65536 无法核对；control_type = -1 时设定值无法核对', () => {
    expect(matchRunningCtrl(rec({ dewPoint: 13.02 }), live, ON)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ dewPoint: 13.5 }), live, ON)).toMatchObject({ verdict: 'unchanged' })
    expect(matchRunningCtrl(rec({ dewPoint: 13 }), { ...live, dewPoint: 65536 }, ON)).toMatchObject({ verdict: 'unverifiable' })
    expect(matchRunningCtrl(rec({ dewPoint: 13 }), { ...live, controlType: -1 }, ON)).toMatchObject({ verdict: 'unverifiable' })
  })
  it('浮点 0.05 边界：差 0.04 判一致，差 0.05 判未变化', () => {
    expect(matchRunningCtrl(rec({ dewPoint: 13.04 }), live, ON)).toMatchObject({ verdict: 'applied' })
    expect(matchRunningCtrl(rec({ dewPoint: 13.05 }), live, ON)).toMatchObject({ verdict: 'unchanged' })
    expect(matchRunningCtrl(rec({ dewPoint: 12.95 }), live, ON)).toMatchObject({ verdict: 'unchanged' })
  })
  it('浮点边界不受二进制误差影响：正好差 0.05 一律判未变化；经 32 位 float 编解码后的读数判一致', () => {
    for (const [got, want] of [[2, 2.05], [2.05, 2], [0.1, 0.15], [35, 35.05], [69.95, 70], [13.5, 13.55]]) {
      expect(matchRunningCtrl(rec({ humiditySet: want }), { ...live, controlType: 0, humiditySet: got }, ON)).toMatchObject({ verdict: 'unchanged' })
      expect(matchRunningCtrl(rec({ humiditySet: want }), { ...live, controlType: 0, humiditySet: Math.fround(got) }, ON)).toMatchObject({ verdict: 'unchanged' })
    }
    for (const v of [13.05, 12.5, 21.3, 8.1, 15.9, 0.1, 65.7]) {
      expect(matchRunningCtrl(rec({ dewPoint: v }), { ...live, dewPoint: Math.fround(v) }, ON)).toMatchObject({ verdict: 'applied' })
      expect(matchRunningCtrl(rec({ dewPoint: v }), { ...live, dewPoint: Math.fround(v + 0.04) }, ON)).toMatchObject({ verdict: 'applied' })
      expect(matchRunningCtrl(rec({ dewPoint: v }), { ...live, dewPoint: Math.fround(v + 0.06) }, ON)).toMatchObject({ verdict: 'unchanged' })
    }
  })
  it('枚举读数 -1 / 65536 → 无法核对（不判未变化）', () => {
    for (const bad of [-1, 65536]) {
      expect(matchRunningCtrl(rec({ windSpeed: 1 }), { ...live, windSpeed: bad }, ON)).toMatchObject({ verdict: 'unverifiable' })
      expect(matchRunningCtrl(rec({ switch: 1 }), { ...live, switch: bad }, ON)).toMatchObject({ verdict: 'unverifiable' })
      expect(matchRunningCtrl(rec({ controlType: 1 }), { ...live, controlType: bad }, ON)).toMatchObject({ verdict: 'unverifiable' })
    }
  })
  it('connected 必须明确为 true：漏传按结果未知', () => {
    expect(matchRunningCtrl(rec({ windSpeed: 2 }), live, {} as never)).toMatchObject({ verdict: 'unknown' })
  })
  it('id 不符、空回包、解码后 {id:0}、只有错误文案的回包 → 全部无法核对', () => {
    for (const reply of [{ ...live, id: 9326461980 }, {}, { id: 0, controlType: 0, windSpeed: 0, switch: 0 }, null, { name: '该软件类型不支持此控制' }]) {
      expect(matchRunningCtrl(rec({ windSpeed: 2, switch: 0 }), reply as never, ON)).toEqual({ verdict: 'unverifiable', fields: { windSpeed: 'unverifiable', switch: 'unverifiable' } })
    }
  })
  it('混合字段按 verdictOf 汇总（未变化 > 无法核对 > 已生效）', () => {
    expect(matchRunningCtrl(rec({ windSpeed: 2, humiditySet: 50, switch: 1 }), live, ON))
      .toEqual({ verdict: 'unchanged', fields: { windSpeed: 'applied', humiditySet: 'unverifiable', switch: 'unchanged' } })
  })
  it('核对数据不对 → false', () => {
    expect(matchRunningCtrl(rec({}), live, ON)).toBe(false)
    expect(matchRunningCtrl({ ...rec({ windSpeed: 2 }), msg: 201 }, live, ON)).toBe(false)
    expect(matchRunningCtrl({ ...rec({ windSpeed: 2 }), deviceId: null }, live, ON)).toBe(false)
    expect(matchRunningCtrl({ ...rec({ windSpeed: 2 }), deviceId: 0 }, { ...live, id: 0 }, ON)).toBe(false)
    expect(matchRunningCtrl({ ...rec({ windSpeed: 2 }), deviceId: -3 }, { ...live, id: -3 }, ON)).toBe(false)
  })
})

describe('blocked204（Fable 11/25 裁定）', () => {
  it('读数为空、id 不符、解码后 {id:0}、设备 id 不合法 → 一律拦下', () => {
    const ok = { ...live, humiditySet: 50 }
    expect(blocked204(null, ID, ['switch'])).toBe(BLOCK_204_NO_READING)
    expect(blocked204({}, ID, ['switch'])).toBe(BLOCK_204_NO_READING)
    expect(blocked204({ id: 0, controlType: 0, dewPoint: 0, humiditySet: 0, windSpeed: 0 }, ID, ['switch'])).toBe(BLOCK_204_NO_READING)
    expect(blocked204({ ...ok, id: 9326461980 }, ID, ['switch'])).toBe(BLOCK_204_NO_READING)
    expect(blocked204({ ...ok, id: 0 }, 0, ['switch'])).toBe(BLOCK_204_NO_READING)
    expect(blocked204(ok, null, ['switch'], 'minus1')).toBe(BLOCK_204_NO_READING)
  })
  it('读数 control_type = -1：写入口整体禁用', () => {
    expect(blocked204({ ...live, controlType: -1, humiditySet: 50 }, ID, ['windSpeed'])).toBe(BLOCK_204_CONTROL_TYPE)
    expect(blocked204({ ...live, controlType: -1 }, ID, ['controlType'], 'minus1')).toBe(BLOCK_204_CONTROL_TYPE)
  })
  it('echo：没改的设定项读到 -1 / 65536 → 整条不发；改了它就不拦', () => {
    expect(blocked204(live, ID, ['windSpeed'])).toBe(BLOCK_204_UNINITIALIZED) // 实测 humidity_set = -1
    expect(blocked204(live, ID, ['windSpeed', 'humiditySet'])).toBeNull()
    expect(blocked204({ ...live, humiditySet: 50, dewPoint: 65536 }, ID, ['windSpeed'])).toBe(BLOCK_204_UNINITIALIZED)
    expect(blocked204({ ...live, humiditySet: 50, windSpeed: -1 }, ID, ['switch'])).toBe(BLOCK_204_UNINITIALIZED)
  })
  it('echo：缺省 0 是真实读数，不算未初始化；switch 不参与', () => {
    expect(blocked204({ id: ID, dewPoint: 13, humiditySet: 50 }, ID, ['switch'])).toBeNull()
    expect(blocked204({ ...live, humiditySet: 50, switch: -1 }, ID, ['windSpeed'])).toBeNull()
  })
  it('echo：没改的枚举读数越界、设定值非有限数 → 整条不发', () => {
    const ok = { ...live, humiditySet: 50 }
    expect(blocked204(ok, ID, ['switch'])).toBeNull()
    expect(blocked204({ ...ok, windSpeed: 3 }, ID, ['switch'])).toBe(BLOCK_204_INVALID)
    expect(blocked204({ ...ok, controlType: 2 }, ID, ['switch'])).toBe(BLOCK_204_INVALID)
    expect(blocked204({ ...ok, windSpeed: 3 }, ID, ['windSpeed'])).toBeNull() // 改了的字段由 checkSentRecord 管
    for (const bad of [NaN, Infinity]) expect(blocked204({ ...ok, dewPoint: bad }, ID, ['switch'])).toBe(BLOCK_204_UNINITIALIZED)
  })
  it('minus1：没改的字段本来就传 -1，不拦', () => {
    expect(blocked204(live, ID, ['windSpeed'], 'minus1')).toBeNull()
  })
})

describe('checkSentRecord(204)', () => {
  it('露点、湿度设定值：65536、-100、超出合法范围一律拒绝；-1（不变）照常放行', () => {
    for (const bad of [65536, -100, 7.5, 16.5, 0]) expect(checkSentRecord(rec({ dewPoint: bad }))).toMatch(/不在合法范围内|不合规/)
    for (const bad of [65536, -100, 34, 71, 0]) expect(checkSentRecord(rec({ humiditySet: bad }))).toMatch(/不在合法范围内|不合规/)
    expect(checkSentRecord(rec({ dewPoint: 8, humiditySet: -1 }))).toBeNull()
    expect(checkSentRecord(rec({ dewPoint: 16 }))).toBeNull()
    expect(checkSentRecord(rec({ humiditySet: 35 }))).toBeNull()
    expect(checkSentRecord(rec({ humiditySet: 70, dewPoint: -1, windSpeed: 1 }))).toBeNull()
  })
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
    expect(checkSentRecord({ msg: 204, deviceId: ID, target: { ...NONE, name: 'x' } as never })).toMatch(/不合规/)
    expect(checkSentRecord({ msg: 204, deviceId: ID, target: { ...NONE, windSpeed: 1, switch: '1' } as never })).toMatch(/不合规/)
    expect(checkSentRecord({ msg: 204, deviceId: ID, target: { ...NONE, windSpeed: 1, dewPoint: true } as never })).toMatch(/不合规/)
  })
})
