// ctrl 同步消息（MessageType 200–210）与批量统一控制。
//
// 请求：POST /ctrl/<route> { project_id, user_id, body }，body 是 Query 的 protobuf 二进制的 base64；
// 响应：{ body }，是 Reply 的 base64（带每 76 字符的换行，解码前去掉空白）。
// 编解码用 @bufbuild/protobuf 由 proto/ctrl200.proto 生成（src/api/gen/）。int64 在边界上统一
// 转为 number，页面拿到的是普通对象（不含 $typeName）。
//
// 错误：HTTP 层的错误由 http.ts 归一（503 控制屏未连接、504 控制屏未应答等）；
// 另外 ctrl 的业务失败是 HTTP 200：
// - 设置类 Reply { success, msg }：success 不为 true 即失败，msg 是原因；
// - 读取类 Reply：控制屏把错误文案放在 #2 字段（proto 里没有这个字段，或 210 里 #2 是 name 但
//   回复里只有 #2），见 docs/api/实测记录-1124.md。
import { create, fromBinary, toBinary, ScalarType, type DescMessage, type MessageShape } from '@bufbuild/protobuf'
import { base64Decode, base64Encode, BinaryReader, WireType } from '@bufbuild/protobuf/wire'
import { getCurrentUserId } from './auth'
import { getConfig } from './config'
import { ApiError } from './errors'
import { type WriteOp, type WriteProject } from './guard'
import { request, requestWrite } from './http'
import * as pb from './gen/ctrl200_pb.js'

interface CtrlDef { route: string; query: DescMessage; reply: DescMessage; write?: WriteOp }

export const CTRL = {
  200: { route: 'room-temperature-data-get', query: pb.RoomTemperatureDataGetQuerySchema, reply: pb.RoomTemperatureDataGetReplySchema },
  201: { route: 'room-temperature-set', query: pb.RoomTemperatureSetQuerySchema, reply: pb.RoomTemperatureSetReplySchema, write: 'ctrl-201' },
  202: { route: 'fresh-dehumidifier-get', query: pb.FreshDehumidifierGetQuerySchema, reply: pb.FreshDehumidifierGetReplySchema },
  203: { route: 'unified-ctrl-set', query: pb.UnifiedCtrlSetQuerySchema, reply: pb.UnifiedCtrlSetReplySchema, write: 'ctrl-203' },
  204: { route: 'running-ctrl-set', query: pb.RunningCtrlSetQuerySchema, reply: pb.RunningCtrlSetReplySchema, write: 'ctrl-204' },
  205: { route: 'device-summary-get', query: pb.DeviceSummaryGetQuerySchema, reply: pb.DeviceSummaryGetReplySchema },
  206: { route: 'project-room-switch-set', query: pb.ProjectRoomSwitchSetQuerySchema, reply: pb.ProjectRoomSwitchSetReplySchema, write: 'ctrl-206' },
  207: { route: 'air-sensor-get', query: pb.TPAirSensorGetQuerySchema, reply: pb.TPAirSensorGetReplySchema },
  208: { route: 'air-sensor-data-hour-get', query: pb.TPAirSensorDataHourGetQuerySchema, reply: pb.TPAirSensorDataHourGetReplySchema },
  209: { route: 'room-temperature-data-hour-get', query: pb.TPRoomPanelDataHourGetQuerySchema, reply: pb.TPRoomPanelDataHourGetReplySchema },
  210: { route: 'running-ctrl-get', query: pb.RunningCtrlGetQuerySchema, reply: pb.RunningCtrlGetReplySchema },
} as const satisfies Record<number, CtrlDef>

export type CtrlType = keyof typeof CTRL

/** 生成的消息类型 → 页面用的普通对象：bigint 换成 number，去掉 $typeName / $unknown */
export type Plain<T> = T extends bigint ? number
  : T extends readonly (infer U)[] ? Plain<U>[]
  : T extends object ? { [K in keyof T as K extends '$typeName' | '$unknown' ? never : K]: Plain<T[K]> }
  : T

export type CtrlQuery<T extends CtrlType> = Plain<MessageShape<(typeof CTRL)[T]['query']>>
export type CtrlReply<T extends CtrlType> = Plain<MessageShape<(typeof CTRL)[T]['reply']>>

// ---------------------------------------------------------------------------
// 编解码

const INT64 = new Set<ScalarType>([ScalarType.INT64, ScalarType.UINT64, ScalarType.SINT64, ScalarType.FIXED64, ScalarType.SFIXED64])
const toBig = (v: unknown) => (typeof v === 'number' ? BigInt(Math.trunc(v)) : v)

/** 普通对象 → create() 的初始化参数：按 schema 把 int64 字段的 number 转成 bigint */
function toInit(schema: DescMessage, plain: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of schema.fields) {
    const v = plain[f.localName]
    if (v === undefined || v === null) continue
    if (f.fieldKind === 'scalar') out[f.localName] = INT64.has(f.scalar) ? toBig(v) : v
    else if (f.fieldKind === 'message') out[f.localName] = toInit(f.message, v as Record<string, unknown>)
    else if (f.fieldKind === 'list') {
      const arr = v as unknown[]
      out[f.localName] = f.listKind === 'message' ? arr.map((x) => toInit(f.message, x as Record<string, unknown>))
        : f.listKind === 'scalar' && INT64.has(f.scalar) ? arr.map(toBig) : arr
    } else out[f.localName] = v
  }
  return out
}

function toPlain(v: unknown): unknown {
  if (typeof v === 'bigint') {
    const n = Number(v)
    if (!Number.isSafeInteger(n)) throw new ApiError('server', `数值超出安全范围：${v}`)
    return n
  }
  if (Array.isArray(v)) return v.map(toPlain)
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (k !== '$typeName' && k !== '$unknown') out[k] = toPlain(x)
    return out
  }
  return v
}

export function encodeMessage(schema: DescMessage, plain: object = {}): string {
  const bytes = toBinary(schema, create(schema, toInit(schema, plain as Record<string, unknown>) as never))
  return bytes.length ? base64Encode(bytes) : ''
}

/** 顶层字段扫描：字段号集合，以及 #2 的字符串值（若是长度分隔类型） */
function scanTopLevel(bytes: Uint8Array): { fields: Set<number>; field2?: string } {
  const r = new BinaryReader(bytes)
  const fields = new Set<number>()
  let field2: string | undefined
  while (r.pos < r.len) {
    const [no, wt] = r.tag()
    fields.add(no)
    if (no === 2 && wt === WireType.LengthDelimited) field2 = new TextDecoder().decode(r.bytes())
    else r.skip(wt, no)
  }
  return { fields, field2 }
}

/** 解出 Reply；ctrl 业务失败时抛 ApiError('ctrl') */
export function decodeReply(schema: DescMessage, body: string | undefined): unknown {
  const b64 = (body ?? '').replace(/\s+/g, '')
  let bytes: Uint8Array
  let msg: Record<string, unknown>
  try {
    bytes = b64 ? base64Decode(b64) : new Uint8Array()
    msg = toPlain(fromBinary(schema, bytes)) as Record<string, unknown>
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError('server', '控制屏回复无法解析', { cause: e })
  }
  const hasSuccess = schema.fields.some((f) => f.localName === 'success')
  if (hasSuccess) {
    if (msg.success !== true) throw new ApiError('ctrl', (msg.msg as string) || '下发失败')
    return msg
  }
  const { fields, field2 } = scanTopLevel(bytes)
  const declares2 = schema.fields.some((f) => f.number === 2)
  if (field2 !== undefined && (!declares2 || (fields.size === 1 && schema.fields.length > 1))) {
    throw new ApiError('ctrl', field2 || '操作失败')
  }
  return msg
}

// ---------------------------------------------------------------------------
// 写消息：每个字段都必须显式给出（类型必填 + 运行时校验），绝不依赖 proto3 默认值 0，
// 因为 0 在这些字段上的含义是「关闭」「湿度控制」等真实指令。不改的标量传 -1，end_modes 不改传 []。

export const WRITE_CTRL = [201, 203, 204, 206] as const
export type WriteCtrlType = (typeof WRITE_CTRL)[number]
export type ReadCtrlType = Exclude<CtrlType, WriteCtrlType>
export const isWriteCtrl = (t: number): t is WriteCtrlType => (WRITE_CTRL as readonly number[]).includes(t)

/** 写消息的完整 Query：所有字段必填 */
export type WriteQuery<T extends WriteCtrlType> = CtrlQuery<T>

/** 校验写消息每个字段都在且合法（数值有限、字符串、布尔、列表）；缺一个就拒绝下发 */
export function validateWriteQuery(schema: DescMessage, q: unknown, path = ''): void {
  if (!q || typeof q !== 'object') throw new ApiError('bad_request', `写消息缺少内容：${path || schema.name}`)
  const o = q as Record<string, unknown>
  for (const f of schema.fields) {
    const name = path + f.localName
    const v = o[f.localName]
    if (v === undefined || v === null) throw new ApiError('bad_request', `写消息缺少字段：${name}`)
    if (f.fieldKind === 'list') {
      if (!Array.isArray(v)) throw new ApiError('bad_request', `写消息字段应为列表：${name}`)
      if (f.listKind === 'message') v.forEach((x, i) => validateWriteQuery(f.message, x, `${name}[${i}].`))
    } else if (f.fieldKind === 'message') {
      validateWriteQuery(f.message, v, name + '.')
    } else if (f.fieldKind === 'enum' || (f.fieldKind === 'scalar' && f.scalar !== ScalarType.STRING && f.scalar !== ScalarType.BOOL && f.scalar !== ScalarType.BYTES)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError('bad_request', `写消息字段不是有效数值：${name}`)
    } else if (f.fieldKind === 'scalar' && f.scalar === ScalarType.STRING) {
      if (typeof v !== 'string') throw new ApiError('bad_request', `写消息字段应为字符串：${name}`)
    } else if (f.fieldKind === 'scalar' && f.scalar === ScalarType.BOOL) {
      if (typeof v !== 'boolean') throw new ApiError('bad_request', `写消息字段应为布尔值：${name}`)
    }
  }
}

const U = -1 // 后端约定：不变
type Changes<T extends WriteCtrlType, Fixed extends string> = Partial<Omit<WriteQuery<T>, Fixed>>

/** 201 房间温控设置：只改给出的项，其余标量 -1，末端不改传 [] */
export function buildRoomTemperatureSet(equipmentId: number, changes: Changes<201, 'equipmentId'> = {}): WriteQuery<201> {
  return {
    equipmentId,
    temperature: changes.temperature ?? U,
    humidity: changes.humidity ?? U,
    windSpeed: changes.windSpeed ?? U,
    eco: changes.eco ?? U,
    switch: changes.switch ?? U,
    endModes: changes.endModes ?? [],
  }
}

/**
 * 203 统一控制：开关/温度不改为 -1；运行模式是枚举，不改为 0（OPERATION_MODE_NONE）。
 * 后端 11/25 答复「所有字段不变一律传 -1」，但 proto 里 system_mode 是枚举，明确写了 OPERATION_MODE_NONE = 0 是「不变」，-1 不在枚举里，
 * 所以这一项仍按 proto 传 0，已列入待后端确认
 */
export function buildUnifiedCtrlSet(changes: Changes<203, never> = {}): WriteQuery<203> {
  return {
    systemSwitch: changes.systemSwitch ?? U,
    systemMode: changes.systemMode ?? pb.UnifiedCtrlSetQuery_OperatingMode.OPERATION_MODE_NONE,
    roomSwitch: changes.roomSwitch ?? U,
    roomTemp: changes.roomTemp ?? U,
  }
}

/** 204 运行控制设置：id、name 必给，其余不改为 -1 */
export function buildRunningCtrlSet(id: number, name: string, changes: Changes<204, 'id' | 'name'> = {}): WriteQuery<204> {
  return {
    id,
    name,
    controlType: changes.controlType ?? U,
    dewPoint: changes.dewPoint ?? U,
    humiditySet: changes.humiditySet ?? U,
    windSpeed: changes.windSpeed ?? U,
    switch: changes.switch ?? U,
  }
}

/**
 * 206 全部房间开关：必须明确 true 开 / false 关。0 是「全项目房间关闭」，破坏面最大，
 * 所以不做任何真假值转换：undefined、null、'false'、0/1 等非布尔值一律拒绝（值可能来自 any）。
 */
export function buildProjectRoomSwitchSet(on: boolean): WriteQuery<206> {
  if (typeof on !== 'boolean') throw new ApiError('bad_request', `206 全部房间开关须明确传 true 或 false，收到：${on === null ? 'null' : typeof on}`)
  return { switch: on ? 1 : 0 }
}

// ---------------------------------------------------------------------------
// 调用

export interface CtrlOptions { signal?: AbortSignal; userId?: string; /** 只对写消息有效：见 requestWrite 的 beforeSend */ beforeSend?: () => boolean }

/** 只读 ctrl 消息（200/202/205/207–210）。写消息号直接拒绝，须用 writeCtrl() */
export async function callCtrl<T extends ReadCtrlType>(type: T, projectId: string, query?: Partial<CtrlQuery<T>>, opts: CtrlOptions = {}): Promise<CtrlReply<T>> {
  if (isWriteCtrl(type)) throw new ApiError('write_blocked', `写消息 ${type} 只能经 writeCtrl() 下发`)
  const def: CtrlDef = CTRL[type]
  const res = await request<{ body?: string }>(`/ctrl/${def.route}`, {
    body: { project_id: projectId, user_id: opts.userId ?? getCurrentUserId(), body: encodeMessage(def.query, query ?? {}) },
    timeoutMs: getConfig().ctrlTimeoutMs,
    signal: opts.signal,
  })
  return decodeReply(def.reply, res.body) as CtrlReply<T>
}

/**
 * 写 ctrl 消息（201/203/204/206）。Query 必须完整（用 build* 组装），经 requestWrite() 过写防护；
 * 不重试，超时提示「结果未知」，由页面回读确认。
 */
export async function writeCtrl<T extends WriteCtrlType>(type: T, project: WriteProject, query: WriteQuery<T>, opts: CtrlOptions = {}): Promise<CtrlReply<T>> {
  if (!isWriteCtrl(type)) throw new ApiError('bad_request', `不是写消息：${type}`)
  const def: CtrlDef = CTRL[type]
  validateWriteQuery(def.query, query)
  const res = await requestWrite<{ body?: string }>(def.write!, [project],
    { user_id: opts.userId ?? getCurrentUserId(), body: encodeMessage(def.query, query) },
    { timeoutMs: getConfig().ctrlTimeoutMs, signal: opts.signal, beforeSend: opts.beforeSend })
  return decodeReply(def.reply, res.body) as CtrlReply<T>
}

/** 批量统一控制：POST /ctrl/unified-ctrls-send（操作人由后端取登录用户，不传 user_id） */
export async function sendUnifiedCtrls(projects: readonly WriteProject[], query: WriteQuery<203>) {
  validateWriteQuery(pb.UnifiedCtrlSetQuerySchema, query)
  return requestWrite<{ batch_id?: string; total?: number }>('unified-ctrls-send', projects,
    { body: encodeMessage(pb.UnifiedCtrlSetQuerySchema, query) },
    { timeoutMs: getConfig().ctrlTimeoutMs })
}

/** 批量统一控制执行记录（只读） */
export function getUnifiedCtrlsRecords(filter: { batch_id?: string; project_id?: string } = {}, signal?: AbortSignal) {
  return request<{ records?: Array<Record<string, unknown>>; total?: string | number }>('/ctrl/unified-ctrls-records', { body: filter, signal })
}
