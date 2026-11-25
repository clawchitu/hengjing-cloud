// 温控下发接入共用写锁（src/api/writeLock.ts）的核对部分：201 / 206 的持久化核对数据，以及用 200 的读数比对
// （src/api/writeLockVerify.ts 的 matchRoomSet / matchAllRoomsSwitch）。读取走当前数据源（真实接口为 ctrl 200，演示数据为内存）。
import type { CtrlReply, WriteQuery } from '@/api/ctrl'
import type { FieldResult, MatchDetail, SentRecord, StoredLock } from '@/api/writeLock'
import { encodeEnds, isNoChange, matchAllRoomsSwitch, matchRoomSet, verdictOf } from '@/api/writeLockVerify'
import { validRoomId } from './model'
import { roomsAsReply } from './model'
import { thermostatSource } from './source'

/**
 * 201 的核对数据：设备 id 与温度、节能、开关三个可改字段（-1 = 不改，比对时跳过）；改了末端（end_modes 非空）时再加 ends
 * （按顺序的「type:选中」，见 writeLockVerify.ts 的 encodeEnds；switch 不核对）
 */
export const record201 = (q: WriteQuery<201>): SentRecord => ({
  msg: 201, deviceId: q.equipmentId,
  target: { temperature: q.temperature, eco: q.eco, switch: q.switch, ...(q.endModes?.length ? { ends: encodeEnds(q.endModes) } : {}) },
})
/** 206（全部开关）要下发的内容：开 / 关，以及确认后预检读到的目标房间 id 集合（核对时逐个检查，回读缺了的按无法核对） */
export interface AllSwitch { on: boolean; roomIds: number[] }
/** 206 的核对数据（带目标房间 id 集合，随记录落盘，刷新恢复后同样逐个检查） */
export const record206 = (p: AllSwitch): SentRecord => ({ msg: 206, deviceId: null, target: { switch: p.on ? 1 : 0 }, roomIds: [...p.roomIds] })

type Reply200 = Pick<CtrlReply<200>, 'data'>
const unverifiable = (fields: string[]): MatchDetail => ({ verdict: 'unverifiable', fields: Object.fromEntries(fields.map((f) => [f, 'unverifiable' as const])) })

/**
 * 回读里房间 ID 的歧义检查（在调用 #31 的共用比对器之前做；比对器按 find 取第一个匹配房间，重复时可能取到恰好一致的那条）：
 * - 201：回读里目标设备 ID 出现不止一次 → 改了的字段全部无法核对；
 * - 206：逐个目标房间处理——回读里 ID 重复的目标记无法核对，其余目标照常判四态（交给共用比对器逐个判）；回读里另有
 *   设备 ID 为 0 / 无效的房间（可能是没法标识的被控房间）再记一项无法核对；全部交给 verdictOf 汇总
 *   （歧义 + 离线 → 结果未知；歧义 + 不一致 → 未变化；只有歧义 → 无法核对）。
 * 有歧义返回汇总后的结论（不会是已生效，锁保持），核对数据本身不对返回 false，没有歧义返回 null（照常比对）
 */
export function ambiguity(rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target' | 'roomIds'>, reply: Reply200): MatchDetail | false | null {
  const data = reply.data ?? []
  const count = (id: number) => data.filter((r) => r.id === id).length
  if (rec.msg === 201) {
    if (rec.deviceId === null || count(rec.deviceId) <= 1) return null
    return unverifiable(Object.entries(rec.target).filter(([k, v]) => !isNoChange(201, k, v)).map(([k]) => k))
  }
  if (rec.msg === 206) {
    const ids = rec.roomIds ?? []
    const invalid = data.some((r) => !validRoomId(r.id))
    if (!invalid && !ids.some((id) => count(id) > 1)) return null
    const per: FieldResult[] = []
    for (const id of ids) {
      if (count(id) > 1) { per.push('unverifiable'); continue }
      const one = matchAllRoomsSwitch({ ...rec, roomIds: [id] }, reply)
      if (!one) return false
      per.push(one.fields.switch ?? one.verdict)
    }
    if (invalid) per.push('unverifiable')
    const v = verdictOf(per)
    return { verdict: v, fields: { switch: v } }
  }
  return null
}
/** 先查歧义，再交给共用比对器 */
export const matchRoomSetChecked = (rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target'>, reply: Reply200) => { const a = ambiguity(rec, reply); return a === null ? matchRoomSet(rec, reply) : a }
export const matchAllRoomsSwitchChecked = (rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target' | 'roomIds'>, reply: Reply200) => { const a = ambiguity(rec, reply); return a === null ? matchAllRoomsSwitch(rec, reply) : a }

/** 201 / 206 写后核对：用 200 的原始读数逐字段比对（先查房间 ID 歧义，再用 writeLockVerify.ts 的四态比对） */
export const match201 = (q: WriteQuery<201>, raw: Reply200) => matchRoomSetChecked(record201(q), raw)
export const match206 = (p: AllSwitch, raw: Reply200) => matchAllRoomsSwitchChecked(record206(p), raw)
export { roomsAsReply }

/**
 * 201 / 206 的核对函数（刷新恢复、写后自动核对都用）。由 src/app/writeLockSetup.ts 的 registerThermostatVerifiersOnce 注册，这里不注册。
 */
const readRaw = async (projectId: string, signal: AbortSignal) => (await thermostatSource().roomsRaw(projectId, signal)).raw
export const verifier201 = async (rec: StoredLock, signal: AbortSignal) => matchRoomSetChecked(rec, await readRaw(rec.projectId, signal))
export const verifier206 = async (rec: StoredLock, signal: AbortSignal) => matchAllRoomsSwitchChecked(rec, await readRaw(rec.projectId, signal))
