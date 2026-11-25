// 写锁核对的比对函数：201 / 206 对照 200 的读数；逐字段四态；混合字段按 结果未知 > 未变化 > 无法核对 > 已生效（Fable B）；
// 缺省 = 0 直接比对；无法核对的三种情况；无效读数；面板离线。
import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage, type CtrlReply } from '../ctrl'
import * as pb from '../gen/ctrl200_pb.js'
import { describeFields, isNoChange, isVerifiableField, matchAllRoomsSwitch, matchRoomSet, verdictOf, VERIFIABLE_FIELDS } from '../writeLockVerify'

const room = (o: Partial<CtrlReply<200>['data'][number]> = {}) => ({
  id: 406658286, name: '房间11', temperature: 22, humidity: 60, dewPoint: 13.9, setTemp: 24.5, setHumi: 0, windSpeed: 3, eco: 0, switch: 1, mode: 0, endModes: [], isConnected: true, ...o,
})
const reply = (...rooms: ReturnType<typeof room>[]) => ({ data: rooms }) as CtrlReply<200>
/** 走一遍真实的 proto3 编解码（值为 0 的字段在线上省略） */
const wire = (...rooms: object[]) => decodeReply(pb.RoomTemperatureDataGetReplySchema, encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: rooms })) as CtrlReply<200>
const D = 406658286
const set = (target: Record<string, number>, r: CtrlReply<200> | Pick<CtrlReply<200>, 'data'>) => matchRoomSet({ msg: 201, deviceId: D, target }, r as CtrlReply<200>)

describe('整体优先级（verdictOf，唯一一处）', () => {
  it('结果未知 > 未变化 > 无法核对 > 已生效；没有字段不算一致', () => {
    expect(verdictOf(['applied', 'applied'])).toBe('applied')
    expect(verdictOf(['applied', 'unverifiable'])).toBe('unverifiable')
    expect(verdictOf(['unverifiable', 'unchanged'])).toBe('unchanged') // B：未变化优先于无法核对
    expect(verdictOf(['unchanged', 'unknown', 'unverifiable'])).toBe('unknown')
    expect(verdictOf([])).toBe('unverifiable')
  })
  it('混合摘要：「1 项未生效，1 项无法核对」', () => {
    expect(describeFields({ temperature: 'unchanged', windSpeed: 'unverifiable', eco: 'applied' })).toBe('1 项未生效，1 项无法核对')
    expect(describeFields({ switch: 'applied' })).toBe('')
    expect(describeFields({ a: 'unknown', b: 'unknown' })).toBe('2 项结果未知')
  })
})

describe('201 → 200（逐字段）', () => {
  it('一致 / 不一致；-1 不比；float 设定温度按 0.05 比较', () => {
    expect(set({ temperature: 24.5, eco: -1, switch: -1 }, reply(room({ setTemp: 24.500001 })))).toEqual({ verdict: 'applied', fields: { temperature: 'applied' } })
    expect(set({ temperature: 24.5 }, reply(room({ setTemp: 25 })))).toEqual({ verdict: 'unchanged', fields: { temperature: 'unchanged' } })
    expect(set({ temperature: 24.5, switch: 0 }, reply(room()))).toEqual({ verdict: 'unchanged', fields: { temperature: 'applied', switch: 'unchanged' } })
  })
  it('缺省 = 0 是真实读数：开关 / 节能为 0 时线上省略，解码为 0，直接比对', () => {
    const r = wire({ id: D, name: '房间11', setTemp: 21.5, switch: 0, eco: 0, isConnected: true })
    expect(r.data[0]).toMatchObject({ switch: 0, eco: 0 })
    expect(set({ switch: 0 }, r)).toMatchObject({ verdict: 'applied' })
    expect(set({ switch: 1 }, r)).toMatchObject({ verdict: 'unchanged' })
    expect(set({ eco: 0 }, r)).toMatchObject({ verdict: 'applied' })
    expect(set({ eco: 1 }, r)).toMatchObject({ verdict: 'unchanged' })
  })
  it('无法核对：目标房间条目缺失、回包为空（如 {}）、改了不在清单里的字段', () => {
    expect(matchRoomSet({ msg: 201, deviceId: 1, target: { temperature: 24.5 } }, reply(room()))).toMatchObject({ verdict: 'unverifiable' })
    expect(set({ temperature: 24.5 }, wire())).toMatchObject({ verdict: 'unverifiable' })
    expect(set({ temperature: 24.5 }, {} as CtrlReply<200>)).toMatchObject({ verdict: 'unverifiable' })
    expect(set({ windSpeed: 3 }, reply(room()))).toEqual({ verdict: 'unverifiable', fields: { windSpeed: 'unverifiable' } })
  })
  it('混合：一项未变化、一项无法核对 → 整体未变化（B），逐字段照列', () => {
    expect(set({ temperature: 26, humidity: 50 }, reply(room()))).toEqual({ verdict: 'unchanged', fields: { temperature: 'unchanged', humidity: 'unverifiable' } })
    expect(set({ temperature: 24.5, humidity: 50 }, reply(room()))).toEqual({ verdict: 'unverifiable', fields: { temperature: 'applied', humidity: 'unverifiable' } })
  })
  it('读数无效（-1、65536）：该字段按设备没回报，无法核对', () => {
    expect(set({ switch: 1 }, reply(room({ switch: -1 })))).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
    expect(set({ eco: 1 }, reply(room({ eco: 65536 })))).toMatchObject({ verdict: 'unverifiable' })
  })
  it('目标房间面板离线：读数不可信，能核对的字段结果未知（整体结果未知）', () => {
    expect(set({ temperature: 24.5, windSpeed: 3 }, reply(room({ isConnected: false })))).toEqual({ verdict: 'unknown', fields: { temperature: 'unknown', windSpeed: 'unverifiable' } })
  })
  it('没有改动的字段、消息号不对、设备 id 为空 → false（核对数据本身不对）', () => {
    expect(set({ temperature: -1, eco: -1 }, reply(room()))).toBe(false)
    expect(matchRoomSet({ msg: 206, deviceId: D, target: { temperature: 24.5 } }, reply(room()))).toBe(false)
    expect(matchRoomSet({ msg: 201, deviceId: null, target: { temperature: 24.5 } }, reply(room()))).toBe(false)
  })
})

describe('206 → 200', () => {
  // 目标集合取回包里的全部房间（确认时读到的就是这些）
  const all = (want: number, r: CtrlReply<200>) => matchAllRoomsSwitch({ msg: 206, target: { switch: want }, roomIds: (r.data ?? []).map((x) => x.id) }, r)
  it('所有房间开关都等于目标值 → 已生效；有不等的 → 未变化；缺省 = 0 直接比对', () => {
    const off = wire({ id: 1, switch: 0, isConnected: true }, { id: 2, switch: 0, isConnected: true })
    expect(all(0, off)).toEqual({ verdict: 'applied', fields: { switch: 'applied' } })
    expect(all(1, off)).toMatchObject({ verdict: 'unchanged' })
    expect(all(0, reply(room({ switch: 0 }), room({ id: 2, switch: 1 })))).toMatchObject({ verdict: 'unchanged' })
  })
  it('有房间离线 → 结果未知；回包为空 → 无法核对；有读数无效且其余一致 → 无法核对，其余不一致 → 未变化', () => {
    expect(all(0, reply(room({ switch: 0 }), room({ id: 2, isConnected: false })))).toMatchObject({ verdict: 'unknown' })
    expect(all(1, wire())).toMatchObject({ verdict: 'unverifiable' })
    expect(all(1, reply(room(), room({ id: 2, switch: 65536 })))).toMatchObject({ verdict: 'unverifiable' })
    expect(all(0, reply(room(), room({ id: 2, switch: 65536 })))).toMatchObject({ verdict: 'unchanged' })
    expect(matchAllRoomsSwitch({ msg: 206, target: { switch: -1 } }, reply(room()))).toBe(false)
  })
})

describe('206 目标房间集合（roomIds）', () => {
  const all = (want: number, r: CtrlReply<200>, roomIds?: number[]) => matchAllRoomsSwitch({ msg: 206, target: { switch: want }, roomIds }, r)
  it('逐个检查确认时的目标房间：部分房间缺失 → 无法核对；全部在且一致 → 已生效；多出来的房间不看', () => {
    const r = reply(room({ id: 1, switch: 1 }), room({ id: 3, switch: 0 }))
    expect(all(1, r, [1, 2])).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
    expect(all(1, r, [1])).toMatchObject({ verdict: 'applied' })
    expect(all(1, r, [1, 3])).toMatchObject({ verdict: 'unchanged' })
    expect(all(1, r, [1, 2, 3])).toMatchObject({ verdict: 'unchanged' }) // 未变化优先于无法核对（B）
  })
  it('没有可信目标集合（缺失或为空）→ 无法核对：即使回包里剩下的房间全部一致也不判已生效', () => {
    const r = reply(room({ id: 1, switch: 1 }))
    expect(all(1, r)).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
    expect(all(1, r, [])).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
  })
})

describe('「不改」判定（isNoChange）', () => {
  it('标量 -1 = 不改；203 的 systemMode 0（OPERATION_MODE_NONE）= 不改，其余消息 / 字段的 0 是真实目标值', () => {
    expect(isNoChange(201, 'temperature', -1)).toBe(true)
    expect(isNoChange(203, 'systemMode', 0)).toBe(true)
    expect(isNoChange(203, 'systemMode', -1)).toBe(true)
    expect(isNoChange(203, 'systemMode', 1)).toBe(false)
    expect(isNoChange(203, 'roomSwitch', 0)).toBe(false)
    expect(isNoChange(201, 'systemMode', 0)).toBe(false)
    expect(isNoChange(201, 'switch', 0)).toBe(false)
  })
})

describe('字段可核对清单', () => {
  it('201 / 206 的 switch、set_temp、eco 可核对；203 只有房间开关、房间温度可核对，系统开关、运行模式没有回读', () => {
    expect(VERIFIABLE_FIELDS[201]).toEqual(['temperature', 'eco', 'switch'])
    expect(VERIFIABLE_FIELDS[206]).toEqual(['switch'])
    expect(isVerifiableField(203, 'roomSwitch')).toBe(true)
    expect(isVerifiableField(203, 'roomTemp')).toBe(true)
    expect(isVerifiableField(203, 'systemSwitch')).toBe(false)
    expect(isVerifiableField(203, 'systemMode')).toBe(false)
    expect(isVerifiableField(201, 'windSpeed')).toBe(false)
    expect(isVerifiableField(999, 'switch')).toBe(false)
  })
})

describe('房间开关未上报（features.roomSwitchReported = false，后端 11/25 答复第 1 条）', () => {
  it('201：开关一律无法核对（读到 0 不算未变化，读到 1 也不算已生效）；温度、节能照常比对', () => {
    for (const sw of [0, 1]) {
      expect(matchRoomSet({ msg: 201, deviceId: D, target: { switch: 1 } }, reply(room({ switch: sw })), { switchReported: false })).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
    }
    expect(matchRoomSet({ msg: 201, deviceId: D, target: { temperature: 24.5, switch: 1 } }, reply(room({ switch: 0 })), { switchReported: false }))
      .toEqual({ verdict: 'unverifiable', fields: { temperature: 'applied', switch: 'unverifiable' } })
    // 面板离线也是无法核对（开关本来就没有可信读数）；同一次改的温度照旧按离线算结果未知
    expect(matchRoomSet({ msg: 201, deviceId: D, target: { temperature: 24.5, switch: 1 } }, reply(room({ isConnected: false })), { switchReported: false }))
      .toEqual({ verdict: 'unknown', fields: { temperature: 'unknown', switch: 'unverifiable' } })
    expect((matchRoomSet({ msg: 201, deviceId: D, target: { switch: 1 } }, reply(room({ isConnected: false })), { switchReported: false }) as { verdict: string }).verdict).toBe('unverifiable')
    // 开关可信时恢复原逻辑
    expect((matchRoomSet({ msg: 201, deviceId: D, target: { switch: 1 } }, reply(room({ switch: 0 })), { switchReported: true }) as { verdict: string }).verdict).toBe('unchanged')
  })
  it('206：一律无法核对（离线房间也是）；开关可信时离线照旧结果未知', () => {
    const rec = { msg: 206, target: { switch: 1 }, roomIds: [D] }
    expect(matchAllRoomsSwitch(rec, reply(room({ switch: 1 })), { switchReported: false })).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
    expect((matchAllRoomsSwitch(rec, reply(room({ isConnected: false })), { switchReported: false }) as { verdict: string }).verdict).toBe('unverifiable')
    expect((matchAllRoomsSwitch(rec, reply(room({ isConnected: false })), { switchReported: true }) as { verdict: string }).verdict).toBe('unknown')
    expect((matchAllRoomsSwitch(rec, reply(room({ switch: 1 })), { switchReported: true }) as { verdict: string }).verdict).toBe('applied')
  })
  it('读数 -100（无效数据）无法核对；0 是有效读数，照常比对', () => {
    expect(set({ temperature: 24.5 }, reply(room({ setTemp: -100 })))).toEqual({ verdict: 'unverifiable', fields: { temperature: 'unverifiable' } })
    expect((set({ eco: 0 }, wire(room({ eco: 0 }))) as { verdict: string }).verdict).toBe('applied')
  })
  it('开关可信时，开关读数不是 0 / 1（如 2、-100、65536）：201、206 一律无法核对，不判未变化', () => {
    for (const sw of [2, 3, -100, 65536]) {
      expect(matchRoomSet({ msg: 201, deviceId: D, target: { switch: 1 } }, reply(room({ switch: sw })), { switchReported: true })).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
      expect(matchAllRoomsSwitch({ msg: 206, target: { switch: 0 }, roomIds: [D] }, reply(room({ switch: sw })), { switchReported: true })).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
    }
  })
})
