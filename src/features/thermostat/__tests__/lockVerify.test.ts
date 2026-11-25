// 温控接共用写锁的核对数据与比对：201 / 206 的持久化数据，页面读数 → 200 形状（演示数据核对用），逐字段四态。
import { describe, expect, it } from 'vitest'
import { buildRoomTemperatureSet } from '@/api/ctrl'
import { parseStored } from '@/api/writeLock'
import { matchRoomSet } from '@/api/writeLockVerify'
import { match201, match206, record201, record206, roomsAsReply } from '../lockVerify'
import type { RoomView } from '../model'

const room = (o: Partial<RoomView> = {}): RoomView => ({
  key: '7', equipmentId: 7, name: '客厅', temp: 25, humidity: 50, dew: 14, setTemp: 25.5, windSpeed: 3, eco: 0, on: true, switchKnown: true, mode: '制冷',
  endModes: [], wireEndModes: [], connected: true, ...o,
})
const raw = (...rs: RoomView[]) => roomsAsReply(rs)

describe('核对数据', () => {
  it('201：设备 id 与温度、节能、开关（-1 = 不改）；206：开关', () => {
    expect(record201(buildRoomTemperatureSet(7, { temperature: 26 }))).toEqual({ msg: 201, deviceId: 7, target: { temperature: 26, eco: -1, switch: -1 } })
    expect(record206({ on: false, roomIds: [7, 8] })).toEqual({ msg: 206, deviceId: null, target: { switch: 0 }, roomIds: [7, 8] })
  })
  it('读数转换：开 → 1、关 → 0；读不到的设定温度 / 节能填 NaN（比对时算无效读数）', () => {
    const r = raw(room({ on: false, setTemp: null, eco: null })).data[0]
    expect(r).toMatchObject({ id: 7, switch: 0, isConnected: true })
    expect(Number.isNaN(r.setTemp)).toBe(true)
    expect(Number.isNaN(r.eco)).toBe(true)
    expect(raw(room()).data[0].switch).toBe(1)
  })
})

describe('比对（四态）', () => {
  it('201：一致 → 已生效；不一致 → 未变化；读不到 → 无法核对；面板离线 → 结果未知', () => {
    expect(match201(buildRoomTemperatureSet(7, { temperature: 26 }), raw(room({ setTemp: 26 })))).toMatchObject({ verdict: 'applied' })
    expect(match201(buildRoomTemperatureSet(7, { temperature: 26 }), raw(room()))).toMatchObject({ verdict: 'unchanged' })
    expect(match201(buildRoomTemperatureSet(7, { switch: 0 }), raw(room({ on: false })))).toMatchObject({ verdict: 'applied' })
    expect(match201(buildRoomTemperatureSet(7, { eco: 1 }), raw(room({ eco: null })))).toMatchObject({ verdict: 'unverifiable' })
    expect(match201(buildRoomTemperatureSet(7, { eco: 1 }), raw(room({ eco: 1, connected: false })))).toMatchObject({ verdict: 'unknown' })
  })
  it('206：所有房间都是目标开关 → 已生效；有不等的 → 未变化', () => {
    expect(match206({ on: false, roomIds: [7, 8] }, raw(room({ on: false }), room({ key: '8', equipmentId: 8, on: false })))).toMatchObject({ verdict: 'applied' })
    expect(match206({ on: true, roomIds: [7, 8] }, raw(room(), room({ key: '8', equipmentId: 8, on: false })))).toMatchObject({ verdict: 'unchanged' })
  })
  it('206：按确认后预检的目标房间逐个检查——回读缺了其中一个 → 无法核对（不因现存房间一致就判已生效）；多出来的房间不看', () => {
    expect(match206({ on: true, roomIds: [7, 8] }, raw(room()))).toMatchObject({ verdict: 'unverifiable' })
    expect(match206({ on: true, roomIds: [7] }, raw(room(), room({ key: '9', equipmentId: 9, on: false })))).toMatchObject({ verdict: 'applied' })
  })
})

describe('回读房间 ID 歧义（S9 在共用比对器之前检查）', () => {
  it('201：目标设备 ID 在回读里重复（第一条恰好一致）→ 改了的字段无法核对；不重复照常比对', () => {
    const q = buildRoomTemperatureSet(7, { temperature: 26 })
    expect(match201(q, raw(room({ setTemp: 26 }), room({ setTemp: 25.5 })))).toEqual({ verdict: 'unverifiable', fields: { temperature: 'unverifiable' } })
    expect(match201(q, raw(room({ setTemp: 26 }), room({ key: '8', equipmentId: 8 })))).toMatchObject({ verdict: 'applied' })
  })
  it('206：回读里有 ID 为 0 / 无效的房间，或目标 ID 重复 → 无法核对', () => {
    const p = { on: true, roomIds: [7, 8] }
    const r8 = room({ key: '8', equipmentId: 8 })
    expect(match206(p, raw(room(), r8, room({ key: '0', equipmentId: 0 })))).toMatchObject({ verdict: 'unverifiable' })
    expect(match206(p, raw(room(), r8, room({ on: false })))).toMatchObject({ verdict: 'unverifiable' })
    expect(match206(p, raw(room(), r8))).toMatchObject({ verdict: 'applied' })
  })
})

describe('206 回读歧义逐目标汇总（verdictOf：结果未知 > 未变化 > 无法核对 > 已生效）', () => {
  const p = { on: true, roomIds: [7, 8, 9] }
  const r8 = room({ key: '8', equipmentId: 8 })
  const dup7 = [room(), room({ on: false })]
  it('歧义 + 另一个目标面板离线 → 结果未知', () => {
    expect(match206(p, raw(...dup7, r8, room({ key: '9', equipmentId: 9, connected: false })))).toEqual({ verdict: 'unknown', fields: { switch: 'unknown' } })
    expect(match206(p, raw(room(), r8, room({ key: '9', equipmentId: 9, connected: false }), room({ key: '0', equipmentId: 0 })))).toMatchObject({ verdict: 'unknown' })
  })
  it('歧义 + 另一个目标不一致 → 未变化', () => {
    expect(match206(p, raw(...dup7, r8, room({ key: '9', equipmentId: 9, on: false })))).toEqual({ verdict: 'unchanged', fields: { switch: 'unchanged' } })
    expect(match206(p, raw(room(), r8, room({ key: '9', equipmentId: 9, on: false }), room({ key: '0', equipmentId: 0 })))).toMatchObject({ verdict: 'unchanged' })
  })
  it('只有歧义（其余一致）→ 无法核对；其余目标缺失也按无法核对', () => {
    expect(match206(p, raw(...dup7, r8, room({ key: '9', equipmentId: 9 })))).toEqual({ verdict: 'unverifiable', fields: { switch: 'unverifiable' } })
    expect(match206(p, raw(...dup7, r8))).toMatchObject({ verdict: 'unverifiable' })
  })
})


describe('末端核对（201 改了 end_modes：逐个比对 is_selected，switch 不比）', () => {
  const E = [
    { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
    { optionName: '顶辐射', type: 1, isSelected: false, isChange: true, switch: 0 },
    { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 },
  ]
  const sent = E.map((m, i) => (i === 1 ? { ...m, isSelected: true } : m))
  const q = (o: Parameters<typeof buildRoomTemperatureSet>[1] = {}) => buildRoomTemperatureSet(7, { endModes: sent, ...o })
  const withEnds = (ends: typeof E, o: Partial<RoomView> = {}) => raw(room({ wireEndModes: ends, ...o }))

  it('核对数据：改了末端带 ends（按顺序 type:选中），没改末端不带', () => {
    expect(record201(q())).toEqual({ msg: 201, deviceId: 7, target: { temperature: -1, eco: -1, switch: -1, ends: '0:1,1:1,3:0' } })
    expect(record201(buildRoomTemperatureSet(7, { temperature: 26, endModes: [] })).target).not.toHaveProperty('ends')
  })
  it('带 ends 的写锁记录落盘后能还原（刷新后仍按末端核对）', () => {
    const now = Date.now()
    const stored = { v: 1, op: 'op1', keys: ['project:p1'], projectId: 'p1', userId: null, sentAt: now - 1000, ...record201(q()) }
    const back = parseStored(JSON.stringify(stored), now)
    expect(back).toMatchObject({ msg: 201, deviceId: 7, target: { ends: '0:1,1:1,3:0' } })
    expect(matchRoomSet(back!, withEnds(sent), { switchReported: true })).toMatchObject({ verdict: 'applied', fields: { ends: 'applied' } })
    expect(matchRoomSet(back!, withEnds(E), { switchReported: true })).toMatchObject({ verdict: 'unchanged' })
  })
  it('选中一致 → 已生效（末端 switch 不同也不影响）', () => {
    expect(match201(q(), withEnds(sent))).toEqual({ verdict: 'applied', fields: { ends: 'applied' } })
    expect(match201(q(), withEnds(sent.map((m) => ({ ...m, switch: m.switch ? 0 : 1 }))))).toMatchObject({ verdict: 'applied' })
  })
  it('选中不一致 → 未变化', () => {
    expect(match201(q(), withEnds(E))).toEqual({ verdict: 'unchanged', fields: { ends: 'unchanged' } })
  })
  it('末端个数变了 / 某个位置的 type 变了 → 无法核对（不能一一对应）', () => {
    expect(match201(q(), withEnds(sent.slice(0, 2)))).toEqual({ verdict: 'unverifiable', fields: { ends: 'unverifiable' } })
    expect(match201(q(), withEnds([...sent, { optionName: '地暖', type: 2, isSelected: false, isChange: true, switch: 0 }]))).toMatchObject({ verdict: 'unverifiable' })
    expect(match201(q(), withEnds([sent[1], sent[0], sent[2]]))).toMatchObject({ verdict: 'unverifiable' })
  })
  it('面板离线 → 结果未知；房间不在 → 无法核对；回读里设备 id 重复 → 无法核对', () => {
    expect(match201(q(), withEnds(sent, { connected: false }))).toMatchObject({ verdict: 'unknown', fields: { ends: 'unknown' } })
    expect(match201(q(), raw(room({ equipmentId: 8 })))).toMatchObject({ verdict: 'unverifiable' })
    const r = withEnds(sent)
    expect(match201(q(), { data: [...r.data, ...r.data] })).toMatchObject({ verdict: 'unverifiable', fields: { ends: 'unverifiable' } })
  })
  it('末端和温度一起改：温度一致但末端不一致 → 整体未变化（不会因温度一致就判已生效）', () => {
    expect(match201(q({ temperature: 26 }), withEnds(E, { setTemp: 26 }))).toEqual({ verdict: 'unchanged', fields: { temperature: 'applied', ends: 'unchanged' } })
    expect(match201(q({ temperature: 26 }), withEnds(sent, { setTemp: 26 }))).toMatchObject({ verdict: 'applied' })
  })
})

describe('演示数据的末端核对', () => {
  it('roomsAsReply 带上末端（演示模式改末端后也能核对）', () => {
    const ends = [{ optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 }]
    expect(raw(room({ wireEndModes: ends })).data[0].endModes).toEqual(ends)
  })
})
