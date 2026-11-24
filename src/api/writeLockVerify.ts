// 写锁核对用的纯比对函数（不发请求，读取由调用方注入）：把持久化的核对数据（消息号、设备 id、目标字段与值）与回读结果比对。
// 按消息类型回读：201 / 206 → 200（房间温控数据）；204 → 210（运行控制数据，本文件暂不提供）。
//
// 比对口径（11/24 Fable 裁定；与统一控制 src/features/unified/batch.ts 的 summarizeRooms 同一套读数规则）：
// - 200 的 switch、set_temp、eco 是 proto3 普通标量，值为 0 时线上本来就省略，解码出来的 0 就是真实读数，直接比对。
// - 逐字段四态（FieldResult）：
//     applied 已生效（读到且一致）/ unchanged 未变化（读到但不一致：指令已下发、设备状态暂未变化，不等于失败）/
//     unverifiable 无法核对 / unknown 结果未知（读数不可信：目标房间面板离线）。
//   无法核对用于四种情况：① 整个目标房间条目缺失；② 回包成功但没有任何房间（如 {}）；③ 写入目标在 200 里没有对应字段
//   （见 VERIFIABLE_FIELDS）；④ 206 没有可信的目标房间集合（roomIds 缺失或为空）。读数无效（-1、65536、非有限数）按设备没回报，也算无法核对（与 summarizeRooms 一致）。
// - 整体结论（verdictOf，唯一的优先级函数）：结果未知 > 未变化 > 无法核对 > 已生效（Fable 裁定 B：未变化是回读确认的
//   不一致，无法核对只是缺证据，取最坏的确定结论；结果未知最前）。整体结论只作标题，逐字段结果给界面逐项列出。
// - 回读请求本身失败（网络错误、超时、非 2xx）由调用方的读取抛错，写锁归为结果未知，不走这里。
// - 写锁只有整体为「已生效」（所有目标字段都一致）才放锁；其余三种都锁到核对一致或有效期到期。
//
// 203（统一控制）对照 docs/api/ctrlcb.proto：200 的 RoomTemperatureData 只有房间级的 switch（#13）与 set_temp（#6），能核对
// 203 的 room_switch 与 room_temp；200–210 里没有系统开关 system_switch 与运行模式 system_mode 的读数，这两项无法核对。
//
// 用法（页面或应用初始化时）：
//   registerVerifier(201, async (rec, signal) => matchRoomSet(rec, await callCtrl(200, rec.projectId, {}, { signal })))
//   registerVerifier(206, async (rec, signal) => matchAllRoomsSwitch(rec, await callCtrl(200, rec.projectId, {}, { signal })))
import type { CtrlReply } from './ctrl'
import { NO_DATA } from './values'
import type { FieldResult, MatchDetail, SentRecord } from './writeLock'

type Rooms = Pick<CtrlReply<200>, 'data'>
type Room = Rooms['data'][number]

/**
 * 「字段可核对」清单：各消息号下，哪些写入字段能在回读里找到对应读数。不在清单里的字段一旦改了（不是 -1），该字段无法核对。
 * 203 只列出能用 200 核对的房间级字段；systemSwitch、systemMode 没有回读。
 */
export const VERIFIABLE_FIELDS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  201: Object.freeze(['temperature', 'eco', 'switch']),
  206: Object.freeze(['switch']),
  203: Object.freeze(['roomSwitch', 'roomTemp']),
})
/** 某消息号的某个写入字段能不能核对 */
export const isVerifiableField = (msg: number, field: string) => (VERIFIABLE_FIELDS[msg] ?? []).includes(field)
/**
 * 按消息类型判断写入字段是否为「不改」（唯一口径，写锁与比对函数都用它）：标量 -1；203 的 systemMode 是枚举，
 * 0（OPERATION_MODE_NONE）= 不改
 */
export const isNoChange = (msg: number, field: string, v: unknown) => v === -1 || (msg === 203 && field === 'systemMode' && v === 0)

/** 混合字段的整体优先级（数字越大越优先）：结果未知 > 未变化 > 无法核对 > 已生效（Fable 裁定 B）。只在这里改 */
const PRIORITY: Record<FieldResult, number> = { unknown: 3, unchanged: 2, unverifiable: 1, applied: 0 }
/** 逐字段结果 → 整体结论（没有字段时为已生效以外的「无法核对」，避免空集合被当作一致） */
export function verdictOf(fields: readonly FieldResult[]): FieldResult {
  if (!fields.length) return 'unverifiable'
  return fields.reduce((a, b) => (PRIORITY[b] > PRIORITY[a] ? b : a), 'applied' as FieldResult)
}
/** 混合结果的摘要：「1 项未生效，1 项无法核对」（只列不一致的类别；全部一致时为空串） */
export function describeFields(fields: Readonly<Record<string, FieldResult>>): string {
  const n = (k: FieldResult) => Object.values(fields).filter((v) => v === k).length
  const parts: string[] = []
  if (n('unknown')) parts.push(`${n('unknown')} 项结果未知`)
  if (n('unchanged')) parts.push(`${n('unchanged')} 项未生效`)
  if (n('unverifiable')) parts.push(`${n('unverifiable')} 项无法核对`)
  return parts.join('，')
}

/** 读数有效：有限数，且不是 -1（「不变」）或 65536（未初始化 / 无数据） */
const validReading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v !== -1 && v !== NO_DATA
/** 设定温度是 float，按 0.05 比较 */
const sameTemp = (a: number, b: number) => Math.abs(a - b) < 0.05

/** 201 字段 → 200 读数 */
const ROOM_READ: Record<string, (r: Room) => number> = {
  temperature: (r) => r.setTemp,
  eco: (r) => r.eco,
  switch: (r) => r.switch,
}

const detail = (fields: Record<string, FieldResult>): MatchDetail => ({ verdict: verdictOf(Object.values(fields)), fields })

/**
 * 201（单房间设置）：目标里每个改了的字段（不是 -1）逐个判四态，整体按 verdictOf。
 * 不在清单里的字段 → 无法核对；回包没有房间、找不到目标房间 → 全部无法核对；目标房间面板离线 → 能核对的字段结果未知；
 * 读数无效 → 无法核对。没有任何改动的字段、消息号不对、设备 id 为空 → false（核对数据本身不对）
 */
export function matchRoomSet(rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target'>, reply: Rooms): MatchDetail | false {
  if (rec.msg !== 201 || rec.deviceId === null) return false
  const changed = Object.entries(rec.target).filter(([k, v]) => !isNoChange(201, k, v))
  if (!changed.length) return false
  const room = (reply.data ?? []).find((r) => r.id === rec.deviceId)
  const fields: Record<string, FieldResult> = {}
  for (const [field, v] of changed) {
    if (!isVerifiableField(201, field) || typeof v !== 'number') { fields[field] = 'unverifiable'; continue }
    if (!room) { fields[field] = 'unverifiable'; continue }
    if (room.isConnected !== true) { fields[field] = 'unknown'; continue }
    const got = ROOM_READ[field](room)
    if (!validReading(got)) { fields[field] = 'unverifiable'; continue }
    fields[field] = (field === 'temperature' ? sameTemp(got, v) : got === v) ? 'applied' : 'unchanged'
  }
  return detail(fields)
}

/**
 * 206（全部房间开关）：只有 switch 一个字段，按房间汇总——有房间离线 → 结果未知；有读到且不一致的 → 未变化；
 * 有读数无效 / 没有房间 → 无法核对；全部一致 → 已生效（同一字段内同样按 verdictOf 的优先级）。
 * 逐个检查 roomIds（确认后预检读到的目标房间），回包里缺了的按无法核对；回包里多出来的房间不看。
 * 没有可信目标集合（roomIds 缺失或为空，如旧版持久化的记录、漏传集合的接入）→ 无法核对：不能据回包里剩下的房间判一致
 */
export function matchAllRoomsSwitch(rec: Pick<SentRecord, 'msg' | 'target' | 'roomIds'>, reply: Rooms): MatchDetail | false {
  const want = rec.target.switch
  if (rec.msg !== 206 || isNoChange(206, 'switch', want) || (want !== 0 && want !== 1)) return false
  if (!rec.roomIds?.length) return detail({ switch: 'unverifiable' })
  const rooms = reply.data ?? []
  const judge = (r: Room | undefined): FieldResult =>
    !r ? 'unverifiable' : r.isConnected !== true ? 'unknown' : !validReading(r.switch) ? 'unverifiable' : r.switch === want ? 'applied' : 'unchanged'
  const perRoom: FieldResult[] = rec.roomIds.map((id) => judge(rooms.find((r) => r.id === id)))
  return detail({ switch: verdictOf(perRoom) })
}
