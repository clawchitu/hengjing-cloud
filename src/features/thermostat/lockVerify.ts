// 温控下发接入共用写锁（src/api/writeLock.ts）的核对部分：201 / 206 的持久化核对数据，以及用 200 的读数比对
// （src/api/writeLockVerify.ts 的 matchRoomSet / matchAllRoomsSwitch）。读取走当前数据源（真实接口为 ctrl 200，演示数据为内存）。
import type { CtrlReply, WriteQuery } from '@/api/ctrl'
import { registerVerifier, type SentRecord } from '@/api/writeLock'
import { matchAllRoomsSwitch, matchRoomSet } from '@/api/writeLockVerify'
import type { RoomView } from './model'
import { thermostatSource } from './source'

/** 页面用的房间读数 → 200 Reply 的形状（只填比对用到的字段；读不到的值填不会相等的数） */
export function roomsAsReply(list: readonly RoomView[]): Pick<CtrlReply<200>, 'data'> {
  return {
    data: list.map((r) => ({
      id: r.equipmentId, setTemp: r.setTemp ?? Number.NaN, eco: r.eco ?? -2, switch: r.on ? 1 : 0, isConnected: r.connected,
    })) as unknown as CtrlReply<200>['data'],
  }
}

/** 201 的核对数据：设备 id 与温度、节能、开关三个可改字段（-1 = 不改，比对时跳过） */
export const record201 = (q: WriteQuery<201>): SentRecord => ({ msg: 201, deviceId: q.equipmentId, target: { temperature: q.temperature, eco: q.eco, switch: q.switch } })
/** 206 的核对数据 */
export const record206 = (on: boolean): SentRecord => ({ msg: 206, deviceId: null, target: { switch: on ? 1 : 0 } })

export const match201 = (q: WriteQuery<201>, list: readonly RoomView[]) => matchRoomSet(record201(q), roomsAsReply(list))
export const match206 = (on: boolean, list: readonly RoomView[]) => matchAllRoomsSwitch(record206(on), roomsAsReply(list))

/**
 * 注册 201 / 206 的核对器（刷新恢复的写锁用它核对）。应用初始化时在 configureWriteLock 之后调用（src/app/writeLockSetup.ts）。
 * 返回取消注册
 */
export function registerThermostatVerifiers(): () => void {
  const read = (projectId: string, signal: AbortSignal) => thermostatSource().rooms(projectId, signal)
  const off201 = registerVerifier(201, async (rec, signal) => matchRoomSet(rec, roomsAsReply(await read(rec.projectId, signal))))
  const off206 = registerVerifier(206, async (rec, signal) => matchAllRoomsSwitch(rec, roomsAsReply(await read(rec.projectId, signal))))
  return () => { off201(); off206() }
}
