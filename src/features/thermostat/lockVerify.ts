// 温控下发接入共用写锁（src/api/writeLock.ts）的核对部分：201 / 206 的持久化核对数据，以及用 200 的读数比对
// （src/api/writeLockVerify.ts 的 matchRoomSet / matchAllRoomsSwitch）。读取走当前数据源（真实接口为 ctrl 200，演示数据为内存）。
import type { CtrlReply, WriteQuery } from '@/api/ctrl'
import { registerVerifier, type SentRecord } from '@/api/writeLock'
import { matchAllRoomsSwitch, matchRoomSet } from '@/api/writeLockVerify'
import { roomsAsReply } from './model'
import { thermostatSource } from './source'

/** 201 的核对数据：设备 id 与温度、节能、开关三个可改字段（-1 = 不改，比对时跳过） */
export const record201 = (q: WriteQuery<201>): SentRecord => ({ msg: 201, deviceId: q.equipmentId, target: { temperature: q.temperature, eco: q.eco, switch: q.switch } })
/** 206（全部开关）要下发的内容：开 / 关，以及确认后预检读到的目标房间 id 集合（核对时逐个检查，回读缺了的按无法核对） */
export interface AllSwitch { on: boolean; roomIds: number[] }
/** 206 的核对数据（带目标房间 id 集合，随记录落盘，刷新恢复后同样逐个检查） */
export const record206 = (p: AllSwitch): SentRecord => ({ msg: 206, deviceId: null, target: { switch: p.on ? 1 : 0 }, roomIds: [...p.roomIds] })

/** 201 / 206 写后核对：用 200 的原始读数逐字段比对（writeLockVerify.ts，四态） */
export const match201 = (q: WriteQuery<201>, raw: Pick<CtrlReply<200>, 'data'>) => matchRoomSet(record201(q), raw)
export const match206 = (p: AllSwitch, raw: Pick<CtrlReply<200>, 'data'>) => matchAllRoomsSwitch(record206(p), raw)
export { roomsAsReply }

/**
 * 注册 201 / 206 的核对器（刷新恢复、写后自动核对都可用）。应用初始化时在 configureWriteLock（统一控制的
 * setupUnifiedWriteLock 已在 AppProvider 里注入 resolveProject）之后、组织数据就绪时调用（src/app/writeLockSetup.ts）。
 * 返回取消注册
 */
export function registerThermostatVerifiers(): () => void {
  const read = async (projectId: string, signal: AbortSignal) => (await thermostatSource().roomsRaw(projectId, signal)).raw
  const off201 = registerVerifier(201, async (rec, signal) => matchRoomSet(rec, await read(rec.projectId, signal)))
  const off206 = registerVerifier(206, async (rec, signal) => matchAllRoomsSwitch(rec, await read(rec.projectId, signal)))
  return () => { off201(); off206() }
}
