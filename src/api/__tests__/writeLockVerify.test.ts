// 写锁核对的纯比对函数：201 / 206 对照 200 的读数。
import { describe, expect, it } from 'vitest'
import type { CtrlReply } from '../ctrl'
import { matchAllRoomsSwitch, matchRoomSet } from '../writeLockVerify'

const room = (o: Partial<CtrlReply<200>['data'][number]> = {}) => ({
  id: 406658286, name: '房间11', temperature: 22, humidity: 60, dewPoint: 13.9, setTemp: 24.5, setHumi: 0, windSpeed: 3, eco: 0, switch: 1, mode: 0, endModes: [], isConnected: true, ...o,
})
const reply = (...rooms: ReturnType<typeof room>[]) => ({ data: rooms }) as CtrlReply<200>

describe('201 → 200', () => {
  it('改了的字段都一致才算一致；-1 不比；float 设定温度按 0.05 比较', () => {
    expect(matchRoomSet({ msg: 201, deviceId: 406658286, target: { temperature: 24.5, eco: -1, switch: -1 } }, reply(room({ setTemp: 24.500001 })))).toBe(true)
    expect(matchRoomSet({ msg: 201, deviceId: 406658286, target: { temperature: 24.5 } }, reply(room({ setTemp: 25 })))).toBe(false)
    expect(matchRoomSet({ msg: 201, deviceId: 406658286, target: { eco: 1, temperature: -1 } }, reply(room({ eco: 1 })))).toBe(true)
    expect(matchRoomSet({ msg: 201, deviceId: 406658286, target: { switch: 0 } }, reply(room({ switch: 1 })))).toBe(false)
  })
  it('找不到房间、没有可比字段、不认识的字段、消息号不对 → 不一致', () => {
    expect(matchRoomSet({ msg: 201, deviceId: 1, target: { temperature: 24.5 } }, reply(room()))).toBe(false)
    expect(matchRoomSet({ msg: 201, deviceId: 406658286, target: { temperature: -1, eco: -1 } }, reply(room()))).toBe(false)
    expect(matchRoomSet({ msg: 201, deviceId: 406658286, target: { windSpeed: 3 } }, reply(room()))).toBe(false)
    expect(matchRoomSet({ msg: 201, deviceId: 406658286, target: { temperature: 24.5, windSpeed: 3 } }, reply(room()))).toBe(false)
    expect(matchRoomSet({ msg: 206, deviceId: 406658286, target: { temperature: 24.5 } }, reply(room()))).toBe(false)
    expect(matchRoomSet({ msg: 201, deviceId: null, target: { temperature: 24.5 } }, reply(room()))).toBe(false)
  })
})

describe('206 → 200', () => {
  it('所有已连接房间的开关都等于目标值；未连接的不算；没有已连接的房间 → 不一致', () => {
    expect(matchAllRoomsSwitch({ msg: 206, target: { switch: 0 } }, reply(room({ switch: 0 }), room({ id: 2, switch: 1, isConnected: false })))).toBe(true)
    expect(matchAllRoomsSwitch({ msg: 206, target: { switch: 0 } }, reply(room({ switch: 0 }), room({ id: 2, switch: 1 })))).toBe(false)
    expect(matchAllRoomsSwitch({ msg: 206, target: { switch: 1 } }, reply(room({ isConnected: false })))).toBe(false)
    expect(matchAllRoomsSwitch({ msg: 206, target: { switch: -1 } }, reply(room()))).toBe(false)
  })
})
