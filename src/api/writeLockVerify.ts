// 写锁核对用的纯比对函数（不发请求，读取由调用方注入）：把持久化的核对数据（消息号、设备 id、目标字段与值）与回读结果比对。
// 按消息类型回读：201 / 206 → 200（房间温控数据）；204 → 210（运行控制数据，matchRunningCtrl）。
// 下发时数值字段「不变」传 -1（后端 11/25 答复第 4 条，201 / 204 / 206 所有字段）；枚举字段用枚举里的不变值（203 的 system_mode = 0，见 ctrl.ts）。
//
// 比对口径（11/24 Fable 裁定；与统一控制 src/features/unified/batch.ts 的 summarizeRooms 同一套读数规则）：
// - 200 的 switch、set_temp、eco 是 proto3 普通标量，值为 0 时线上本来就省略，解码出来的 0 就是真实读数，直接比对。
// - 逐字段四态（FieldResult）：
//     applied 已生效（读到且一致）/ unchanged 未变化（读到但不一致：指令已下发、设备状态暂未变化，不等于失败）/
//     unverifiable 无法核对 / unknown 结果未知（读数不可信：目标房间面板离线）。
//   无法核对用于四种情况：① 整个目标房间条目缺失；② 回包成功但没有任何房间（如 {}）；③ 写入目标在 200 里没有对应字段
//   （见 VERIFIABLE_FIELDS）；④ 206 没有可信的目标房间集合（roomIds 缺失或为空）。读数无效（-100 无效数据、65536 未初始化、
//   -1、非有限数）按设备没回报，也算无法核对（与 summarizeRooms 一致）。0 是有效读数（后端 11/25 答复第 9 条）。
// - 房间开关（201 / 206 的 switch）：后端 11/25 答复第 1 条，控制屏没上报房间状态，200 读到的是默认值 0。
//   features.roomSwitchReported 为 false（默认）时，开关一律无法核对——读到的 0 不能当作「未变化」，也不能当作「已生效」。
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
import { roomSwitchReported } from './config'
import { INVALID_HOURLY, MODE_UNCHANGED, NO_DATA } from './values'
import { isDeviceId, type FieldResult, type MatchDetail, type SentRecord } from './writeLock'

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
  204: Object.freeze(['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch']),
})
/** 某消息号的某个写入字段能不能核对 */
export const isVerifiableField = (msg: number, field: string) => (VERIFIABLE_FIELDS[msg] ?? []).includes(field)
/**
 * 按消息类型判断写入字段是否为「不改」（唯一口径，写锁与比对函数都用它）：数值字段是 -1；
 * 203 的 systemMode 是枚举，「不改」是 0（OPERATION_MODE_NONE），它的 -1 不算「不改」（-1 在发送前就被 checkSentRecord 和 guard 拒绝）。
 * 其余字段的 0 不是「不改」
 */
export const isNoChange = (msg: number, field: string, v: unknown) => (msg === 203 && field === 'systemMode' ? v === MODE_UNCHANGED : v === -1)

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

/** 读数有效：有限数，且不是 -1（「不变」/ 210 里表示该项不能设置）、65536（未初始化 / 无数据）、-100（无效数据）。0 有效 */
const validReading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v !== -1 && v !== NO_DATA && v !== INVALID_HOURLY

/** 比对选项：switchReported 默认取 roomSwitchReported()（演示数据恒为 true） */
export interface RoomMatchOpts { switchReported?: boolean }
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
export function matchRoomSet(rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target'>, reply: Rooms, opts: RoomMatchOpts = {}): MatchDetail | false {
  if (rec.msg !== 201 || rec.deviceId === null) return false
  const switchReported = opts.switchReported ?? roomSwitchReported()
  const changed = Object.entries(rec.target).filter(([k, v]) => !isNoChange(201, k, v))
  if (!changed.length) return false
  const room = (reply.data ?? []).find((r) => r.id === rec.deviceId)
  const fields: Record<string, FieldResult> = {}
  for (const [field, v] of changed) {
    if (!isVerifiableField(201, field) || typeof v !== 'number') { fields[field] = 'unverifiable'; continue }
    if (!room) { fields[field] = 'unverifiable'; continue }
    // 开关未上报：开关一律无法核对，先于离线判断（离线与否都拿不到可信的开关读数）
    if (field === 'switch' && !switchReported) { fields[field] = 'unverifiable'; continue }
    if (room.isConnected !== true) { fields[field] = 'unknown'; continue }
    const got = ROOM_READ[field](room)
    if (!validReading(got)) { fields[field] = 'unverifiable'; continue }
    // 开关只有 0 / 1 是有效状态，其他值（如 2）按设备没回报，无法核对，不判「未变化」
    if (field === 'switch' && got !== 0 && got !== 1) { fields[field] = 'unverifiable'; continue }
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
export function matchAllRoomsSwitch(rec: Pick<SentRecord, 'msg' | 'target' | 'roomIds'>, reply: Rooms, opts: RoomMatchOpts = {}): MatchDetail | false {
  const want = rec.target.switch
  if (rec.msg !== 206 || isNoChange(206, 'switch', want) || (want !== 0 && want !== 1)) return false
  if (!rec.roomIds?.length) return detail({ switch: 'unverifiable' })
  const switchReported = opts.switchReported ?? roomSwitchReported()
  const rooms = reply.data ?? []
  // 开关未上报：一律无法核对（先于离线判断）
  const judge = (r: Room | undefined): FieldResult =>
    !r || !switchReported ? 'unverifiable' : r.isConnected !== true ? 'unknown' : !validReading(r.switch) || (r.switch !== 0 && r.switch !== 1) ? 'unverifiable' : r.switch === want ? 'applied' : 'unchanged'
  const perRoom: FieldResult[] = rec.roomIds.map((id) => judge(rooms.find((r) => r.id === id)))
  return detail({ switch: verdictOf(perRoom) })
}

type Running = Partial<Pick<CtrlReply<210>, 'id' | 'controlType' | 'dewPoint' | 'humiditySet' | 'windSpeed' | 'switch'>>
/** 204 字段 → 210 读数 */
const RUNNING_READ: Record<string, (r: Running) => unknown> = {
  controlType: (r) => r.controlType ?? 0,
  dewPoint: (r) => r.dewPoint ?? 0,
  humiditySet: (r) => r.humiditySet ?? 0,
  windSpeed: (r) => r.windSpeed ?? 0,
  switch: (r) => r.switch ?? 0,
}
const SETPOINT = new Set(['dewPoint', 'humiditySet'])
/**
 * 204 的设定值比较：先按 0.01 取整成整数再比，差小于 5（即 0.05）判一致，差正好 0.05 判不一致。
 * 直接用浮点差会在边界上误判（如 2.05 - 2 = 0.04999…）；取整也吸收了 proto float（32 位）编解码的误差（如 13.05 → 13.0500002）。
 * 201 仍用 sameTemp，不在这里改。
 */
const sameSetpoint = (a: number, b: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) < 5

/**
 * 204（新风运行设置）→ 210 回读，逐字段四态，整体按 verdictOf。
 * - 只判 target 里不是 -1 的字段；没有改动、消息号不对、设备 id 为空 → false。
 * - 回包 id 不等于目标设备 id（含空回包、只回了 #2 错误文案的回包）→ 全部无法核对。
 * - control_type / switch / wind_speed 是 proto3 标量，0 在线上省略，解码出的 0 是真实读数，直接比对；读到 -1、65536 或非有限数
 *   按设备没回报，记无法核对（同文件头口径；210 读到 -1 表示这一项不能设置，本来也不会下发它）。
 * - dew_point / humidity_set 读数为 -1（界面显示 --）、65536 或非有限数 → 无法核对；读数 control_type = -1（露点与湿度均不可控）时
 *   这两项也无法核对。浮点按 0.05 比较（sameSetpoint：取整到 0.01 后比，正好差 0.05 判不一致）。
 * - 210 没有 is_connected：设备在线与否由调用方另读 202 判断并传入。connected 必须明确为 true 才比对，否则（false 或漏传）
 *   可核对字段记结果未知，同 201 的 isConnected !== true。
 * - 设备 id 不是正整数 → false。
 */
export function matchRunningCtrl(
  rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target'>, reply: Running | null | undefined, opts: { connected: boolean },
): MatchDetail | false {
  if (rec.msg !== 204 || !isDeviceId(rec.deviceId)) return false
  const changed = Object.entries(rec.target).filter(([k, v]) => !isNoChange(204, k, v))
  if (!changed.length) return false
  const r = reply ?? {}
  const idOk = typeof r.id === 'number' && r.id === rec.deviceId
  const fields: Record<string, FieldResult> = {}
  for (const [field, v] of changed) {
    if (!isVerifiableField(204, field) || typeof v !== 'number' || !idOk) { fields[field] = 'unverifiable'; continue }
    if (opts.connected !== true) { fields[field] = 'unknown'; continue }
    const got = RUNNING_READ[field](r)
    if (!validReading(got)) { fields[field] = 'unverifiable'; continue }
    if (SETPOINT.has(field)) {
      if ((r.controlType ?? 0) === -1) { fields[field] = 'unverifiable'; continue }
      fields[field] = sameSetpoint(got, v) ? 'applied' : 'unchanged'
    } else fields[field] = got === v ? 'applied' : 'unchanged'
  }
  return detail(fields)
}

/** 204 的五个可写字段在界面上的叫法（禁用原因、拦截原因里用） */
export const LABEL_204: Readonly<Record<string, string>> = Object.freeze({ controlType: '控制类型', dewPoint: '露点设定', humiditySet: '湿度设定', windSpeed: '风速', switch: '开关' })
export const FIELDS_204 = Object.freeze(['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch'] as const)
export type Field204 = (typeof FIELDS_204)[number]
export const BLOCK_204_CONTROL_TYPE = '该设备当前露点与湿度均不可控，不能设置'
export const BLOCK_204_NOT_SETTABLE = '该设备的这一项不能设置'
export const BLOCK_204_NO_READING = '没有读到这台新风设备的运行设置，未下发'
export const block204Field = (f: string) => `「${LABEL_204[f] ?? f}」不能设置，未下发`

/**
 * 210 读数 → 每一项能不能设置（后端 11/25 答复第 5 条：210 读到 -1 表示这一项不能设置，前端把这一项限制成不能设置）：
 * - 某一项读到 -1：这一项不能设置（返回原因），其余项照常；
 * - control_type = -1（露点与湿度均不可控）：控制类型、露点设定、湿度设定三项都不能设置，风速和开关照常（方案 A11）；
 * - 缺省 0 是真实读数，可以设置；65536、非有限数按没有读数显示 --，不因此禁用。
 * 返回 null 表示可以设置。界面（S10c 的 editBlock）按这个禁用对应控件；发送前 blocked204 再查一次
 */
export function settable204(reading: Running | null | undefined): Record<Field204, string | null> {
  const r = reading ?? {}
  const ct = r.controlType ?? 0
  const one = (f: Field204): string | null => {
    if (ct === -1 && (f === 'controlType' || f === 'dewPoint' || f === 'humiditySet')) return BLOCK_204_CONTROL_TYPE
    return RUNNING_READ[f](r) === -1 ? BLOCK_204_NOT_SETTABLE : null
  }
  return Object.fromEntries(FIELDS_204.map((f) => [f, one(f)])) as Record<Field204, string | null>
}

/**
 * 204 发送前的读数检查（后端 11/25 答复第 4、5 条；推翻了 Fable 11/25 的「读到 -1 就整次不下发」和 echo 带回读数的做法）：
 * - 读数为空、或 reading.id 不等于 deviceId（空回包、错误文案回包解码后全是 0）：一律拦下；
 * - 用户改了的字段在 settable204 里不能设置：拦下，提示是哪一项（界面已禁用，这里是兜底）；
 * - 没改的字段一律传 -1（不变），不看它们的读数，所以没改的项读到 -1 不影响下发。
 * changed 是用户改了的字段名。返回 null 表示可以发
 */
export function blocked204(reading: Running | null | undefined, deviceId: number | null, changed: readonly string[]): string | null {
  if (!reading || !isDeviceId(deviceId) || reading.id !== deviceId) return BLOCK_204_NO_READING
  const ok = settable204(reading)
  const bad = changed.find((f) => (ok as Record<string, string | null>)[f] !== null)
  return bad ? block204Field(bad) : null
}
