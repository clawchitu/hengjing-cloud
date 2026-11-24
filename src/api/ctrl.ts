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
import { assertWriteAllowed, type WriteOp } from './guard'
import { request } from './http'
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
  const bytes = b64 ? base64Decode(b64) : new Uint8Array()
  const msg = toPlain(fromBinary(schema, bytes)) as Record<string, unknown>
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
// 调用

export interface CtrlOptions { signal?: AbortSignal; userId?: string }

/**
 * 调一条 ctrl 同步消息。写类消息（201/203/204/206）先过写操作防护；写操作超时不重发，
 * 提示「结果未知」，由页面回读确认。
 */
export async function callCtrl<T extends CtrlType>(type: T, projectId: string, query?: Partial<CtrlQuery<T>>, opts: CtrlOptions = {}): Promise<CtrlReply<T>> {
  const def: CtrlDef = CTRL[type]
  if (def.write) assertWriteAllowed(def.write, [projectId])
  const body = encodeMessage(def.query, query ?? {})
  try {
    const res = await request<{ body?: string }>(`/ctrl/${def.route}`, {
      body: { project_id: projectId, user_id: opts.userId ?? getCurrentUserId(), body },
      timeoutMs: getConfig().ctrlTimeoutMs,
      signal: opts.signal,
    })
    return decodeReply(def.reply, res.body) as CtrlReply<T>
  } catch (e) {
    if (def.write && e instanceof ApiError && e.kind === 'timeout') {
      throw new ApiError('timeout', '未收到控制屏应答，下发结果未知', { status: e.status, code: e.code, cause: e })
    }
    throw e
  }
}

/** 批量统一控制：POST /ctrl/unified-ctrls-send（操作人由后端取登录用户，不传 user_id） */
export async function sendUnifiedCtrls(projectIds: string[], query: Partial<CtrlQuery<203>>) {
  const ids = [...new Set(projectIds)]
  assertWriteAllowed('unified-ctrls-send', ids)
  return request<{ batch_id?: string; total?: number }>('/ctrl/unified-ctrls-send', {
    body: { project_ids: ids, body: encodeMessage(pb.UnifiedCtrlSetQuerySchema, query) },
  })
}

/** 批量统一控制执行记录（只读） */
export function getUnifiedCtrlsRecords(filter: { batch_id?: string; project_id?: string } = {}, signal?: AbortSignal) {
  return request<{ records?: Array<Record<string, unknown>>; total?: string | number }>('/ctrl/unified-ctrls-records', { body: filter, signal })
}
