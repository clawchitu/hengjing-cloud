// 写操作防护。所有下发类接口（ctrl 201、203、204、206 和批量统一控制）只有一个入口：
// http.ts 的 requestWrite()，它在发送前调用这里的 assertWriteAllowed()；普通的 request()
// 遇到写接口路径（先规范化再判断，见 normalizePath）或非规范路径直接拒绝。
// 规则（方案 3.6，按 S4 要求简化）：
// - writeMode='off'：全部拦截；
// - 默认 writeMode='test-only'：只在测试环境放行，生产环境一律拦截；
// - 生产环境下发必须在运行时配置里显式写 writeMode='on'（须负责人确认）；
// - 项目白名单 writeProjectCodes 按项目 code 比对（任何环境都生效）：只放行名单里的 code，
//   名单为空则拒绝所有写操作；code 缺失、为空串、不是字符串一律拒绝。请求里用的是后端实体 id。
// 判断不出环境时 config.ts 按生产处理，所以「不确定」等于「拦截」。
import { fromBinary, type DescMessage } from '@bufbuild/protobuf'
import { base64Decode, base64Encode } from '@bufbuild/protobuf/wire'
import { getConfig, type RuntimeConfig } from './config'
import { ApiError } from './errors'
import { isSendableMode } from './values'
import * as pb from './gen/ctrl200_pb.js'

/** 写接口 → 路径（相对 apiBase） */
export const WRITE_ROUTES = {
  'ctrl-201': '/ctrl/room-temperature-set',
  'ctrl-203': '/ctrl/unified-ctrl-set',
  'ctrl-204': '/ctrl/running-ctrl-set',
  'ctrl-206': '/ctrl/project-room-switch-set',
  'unified-ctrls-send': '/ctrl/unified-ctrls-send',
} as const

export type WriteOp = keyof typeof WRITE_ROUTES
export const WRITE_OPS = Object.keys(WRITE_ROUTES) as WriteOp[]

/**
 * 路径规范化（用于判断是否写接口，按 fetch/URL 的归一规则从严处理）：
 * 去掉空白和控制字符、反斜杠当斜杠、去掉查询串和锚点、解百分号编码、
 * 处理 . 和 ..、合并重复斜杠、转小写、去掉开头的 /v1。
 */
export function normalizePath(path: string): string {
  let s = String(path).replace(/[\u0000-\u0020\u007f]/g, '').replace(/\\/g, '/').split(/[?#]/)[0]
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(s)
      if (d === s) break
      s = d.replace(/[\u0000-\u0020\u007f]/g, '').replace(/\\/g, '/').split(/[?#]/)[0]
    } catch { break }
  }
  const out: string[] = []
  for (const seg of s.toLowerCase().split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return ('/' + out.join('/')).replace(/^\/v1(?=\/|$)/, '') || '/'
}

/** 路径里是否有非规范写法（. 或 .. 段、反斜杠、空白或控制字符）；request() 直接拒绝这类路径 */
export function isNonCanonicalPath(path: string): boolean {
  const p = String(path).split(/[?#]/)[0]
  return /[\\\u0000-\u0020\u007f]/.test(p) || /(^|\/)\.{1,2}(\/|$)/.test(p) || /%(2e|5c|2f|0[0-9a-f]|1[0-9a-f]|20)/i.test(p)
}

const WRITE_PATHS = new Set<string>(Object.values(WRITE_ROUTES))

/**
 * 是否写接口路径（先 normalizePath）。除了已登记的 5 个，ctrl 下所有 *-set / *-send /
 * 透传控制消息也按写处理，防止以后新增的下发接口不小心走普通请求；ctrl 段出现在任意层级都算。
 */
export function isWritePath(path: string): boolean {
  const p = normalizePath(path)
  return WRITE_PATHS.has(p) || /(^|\/)ctrl\/[^/]*(-set|-send|-ctrl-message)$/.test(p) || /(^|\/)ctrl\/(trans|pass)-ctrl-message/.test(p)
}

export type WriteDecision = { ok: true } | { ok: false; reason: string }

/** 写操作的目标项目：code 用于白名单比对，id（后端实体 id）用于请求体 */
export interface WriteProject { id: string; code: string }

/** 只读一次 id / code 并校验类型，得到不可变快照（防 getter 前后取值不同）；不合规返回 null */
export function snapshotProject(p: unknown): WriteProject | null {
  if (!p || typeof p !== 'object') return null
  let id: unknown, code: unknown
  try { ({ id, code } = p as Record<string, unknown>) } catch { return null }
  // 首尾有空白也拒绝：id 会原样写进请求体，code 要和名单精确相等
  if (typeof id !== 'string' || !id || id.trim() !== id || typeof code !== 'string' || !code || code.trim() !== code) return null
  return Object.freeze({ id, code })
}

function decide(op: WriteOp, projects: readonly (WriteProject | null)[], cfg: RuntimeConfig): WriteDecision {
  if (!WRITE_OPS.includes(op)) return { ok: false, reason: `未登记的写操作：${op}` }
  if (cfg.writeMode === 'off') return { ok: false, reason: '下发已关闭（writeMode=off）' }
  if (cfg.apiEnv !== 'test' && cfg.writeMode !== 'on') return { ok: false, reason: '生产环境下发未开启' }
  if (!projects.length) return { ok: false, reason: '未指定项目' }
  if (projects.some((p) => p === null)) return { ok: false, reason: '项目缺少有效的 id 或 code' }
  const allow = Array.isArray(cfg.writeProjectCodes) ? cfg.writeProjectCodes : []
  if (!allow.length) return { ok: false, reason: '下发名单为空' }
  const outside = (projects as WriteProject[]).filter((p) => !allow.includes(p.code)).map((p) => p.code)
  if (outside.length) return { ok: false, reason: `项目不在下发名单内：${outside.join('、')}` }
  return { ok: true }
}

export function checkWrite(op: WriteOp, projects: readonly unknown[], cfg: RuntimeConfig = getConfig()): WriteDecision {
  if (!Array.isArray(projects)) return { ok: false, reason: '未指定项目' }
  return decide(op, projects.map(snapshotProject), cfg)
}

/**
 * 通过则返回项目快照（之后请求体只能用这份快照里的 id），不通过抛 write_blocked。
 * 同一 id 出现多次按一个处理；同一 id 对应不同 code 视为数据异常，拒绝。
 */
export function assertWriteAllowed(op: WriteOp, projects: readonly unknown[], cfg: RuntimeConfig = getConfig()): WriteProject[] {
  const snaps = Array.isArray(projects) ? projects.map(snapshotProject) : []
  const d = decide(op, snaps, cfg)
  if (!d.ok) throw new ApiError('write_blocked', d.reason)
  const byId = new Map<string, WriteProject>()
  for (const p of snaps as WriteProject[]) {
    const prev = byId.get(p.id)
    if (prev && prev.code !== p.code) throw new ApiError('write_blocked', '同一项目 id 对应了不同的 code')
    byId.set(p.id, p)
  }
  return [...byId.values()]
}

/**
 * 写消息内容的最后防线（ctrl.ts 的 encodeWrite 在编码后再解码，把解出来的值交给这里，和后端看到的一致）：
 * - 后端口径「0 是真实值，数值字段不变传 -1」，而 proto3 里没赋值的标量编码后就是 0。所以除了明确给出的字段（目标 id、用户改动），
 *   任何数值为 0 一律拒发。明确给出的列表（end_modes 完整回传）里的值是读到的原样，不逐项查；没给的列表必须为空。
 * - 例外：203（含批量统一控制）的运行模式 system_mode 是枚举 OperatingMode，0 = OPERATION_MODE_NONE 就是「不变」（proto 注释；
 *   11/25 15:35 真机确认），所以这一项的 0 合法。反过来它只能是 0 或界面可选的模式（values.ts OPERATING_MODES）：
 *   -1 不在枚举里（11/25 #60 之后传 -1：后端报 unknown enum、网关 504、指令没执行），-1 和其他枚举外的值一律拒发。
 */
export function assertNoImplicitZero(op: WriteOp, decoded: Readonly<Record<string, unknown>>, explicit: ReadonlySet<string>): void {
  const is203 = op === 'ctrl-203' || op === 'unified-ctrls-send'
  if (is203) {
    if (decoded.systemMode === -1) throw new ApiError('write_blocked', '运行模式为 -1（枚举里没有 -1，不变应传 0 = OPERATION_MODE_NONE），未下发')
    if (!isSendableMode(decoded.systemMode)) throw new ApiError('write_blocked', `运行模式 ${String(decoded.systemMode)} 不是可选的模式，未下发`)
  }
  const walk = (o: Readonly<Record<string, unknown>>, path: string, top: boolean) => {
    for (const [k, v] of Object.entries(o)) {
      const name = path + k
      if (top && explicit.has(k)) continue
      // 203 运行模式的 0 是枚举里的「不变」，上面已按枚举查过
      if (top && is203 && k === 'systemMode') continue
      if (typeof v === 'number' && v === 0) throw new ApiError('write_blocked', `写消息字段 ${name} 为 0 但不是明确的改动（不变应传 -1），未下发`)
      if (Array.isArray(v)) {
        if (v.length) throw new ApiError('write_blocked', `写消息字段 ${name} 不是明确的改动，应为空列表，未下发`)
      } else if (v && typeof v === 'object') walk(v as Record<string, unknown>, name + '.', false)
    }
  }
  walk(decoded, '', true)
}

/**
 * 写消息里所有枚举字段（含嵌套消息、列表）的值都必须是该枚举里定义过的值；-1 等枚举外的值一律拒发（write_blocked）。
 * proto3 枚举是开放的，编码不拦枚举外的值，但后端 Java 解码会报 unknown enum（11/25 203 传 -1 → 504、没执行）。
 * 对解码后的值检查（和后端看到的一致：没上线的枚举字段解出 0）。map 字段写消息里没有，出现就拒发
 */
export function assertEnumsDefined(schema: DescMessage, decoded: Readonly<Record<string, unknown>>, path = ''): void {
  const check = (x: unknown, e: { typeName: string; values: readonly { number: number }[] }, at: string) => {
    if (typeof x !== 'number' || !e.values.some((ev) => ev.number === x)) {
      throw new ApiError('write_blocked', `写消息字段 ${at} 的值 ${String(x)} 不在枚举 ${e.typeName} 里，未下发`)
    }
  }
  for (const f of schema.fields) {
    const name = path + f.localName
    const v = decoded[f.localName]
    if (f.fieldKind === 'enum') check(v, f.enum, name)
    else if (f.fieldKind === 'message') { if (v && typeof v === 'object') assertEnumsDefined(f.message, v as Record<string, unknown>, name + '.') }
    else if (f.fieldKind === 'list') {
      if (!Array.isArray(v)) continue
      if (f.listKind === 'enum') v.forEach((x, i) => check(x, f.enum, `${name}[${i}]`))
      else if (f.listKind === 'message') v.forEach((x, i) => assertEnumsDefined(f.message, x as Record<string, unknown>, `${name}[${i}].`))
    } else if (f.fieldKind === 'map') throw new ApiError('write_blocked', `写消息字段 ${name} 是 map，未核对过，未下发`)
  }
}

/** 写接口 → 请求体里 body 的 Query schema（批量统一控制与 203 同一个 Query） */
export const WRITE_QUERY_SCHEMAS: Readonly<Record<WriteOp, DescMessage>> = Object.freeze({
  'ctrl-201': pb.RoomTemperatureSetQuerySchema,
  'ctrl-203': pb.UnifiedCtrlSetQuerySchema,
  'ctrl-204': pb.RunningCtrlSetQuerySchema,
  'ctrl-206': pb.ProjectRoomSwitchSetQuerySchema,
  'unified-ctrls-send': pb.UnifiedCtrlSetQuerySchema,
})

/**
 * 经 ctrl.ts encodeWrite 校验过的 body（按写接口登记，计数）。proto3 里明确给出的 0 和漏掉的字段在线上一模一样（都不上线），
 * 发送边界只看 body 分不出来，所以「隐式 0」检查只能在知道明确字段的 encodeWrite 里做；requestWrite 只接受这里登记过的 body，
 * 直接拿手写的 body（比如空串 = 全部 0 = 关系统、关房间）调 requestWrite 一律拒发。只应由 encodeWrite 调用
 */
const sealedBodies = new Map<string, number>()
const SEALED_MAX = 256
const sealKey = (op: WriteOp, body: string) => `${op}\n${body}`
export function sealWriteBody(op: WriteOp, body: string): void {
  const k = sealKey(op, body)
  sealedBodies.set(k, (sealedBodies.get(k) ?? 0) + 1)
  // 没发出去的（发送前被拦下）不会被取走：超过上限丢最早的，最多让那条要重新组装
  while (sealedBodies.size > SEALED_MAX) sealedBodies.delete(sealedBodies.keys().next().value as string)
}
/** 取走登记（一次一用）：requestWrite 一进来就取，不管后面成功还是被拦下，登记都不会留下给别的调用借用 */
export function takeWriteBodySeal(op: WriteOp, body: unknown): boolean {
  if (typeof body !== 'string') return false
  const k = sealKey(op, body)
  const n = sealedBodies.get(k)
  if (!n) return false
  if (n === 1) sealedBodies.delete(k)
  else sealedBodies.set(k, n - 1)
  return true
}
/** 测试用：清空登记 */
export const __resetSealedForTests = () => sealedBodies.clear()

/**
 * 发送边界检查（http.ts requestWrite 在发出前调用，绕不过）：
 * - body 必须是 encodeWrite 刚校验并登记过的（requestWrite 一进来就用 takeWriteBodySeal 取走，sealed 是取的结果），否则拒发——堵住直接调 requestWrite 发手写 body（含隐式 0）；
 * - 再把 body（Query 的 base64）按该写接口的 schema 解码：所有枚举字段必须在枚举里；203 / 批量统一控制的运行模式只能是 0（不变）或界面可选的模式。
 * body 缺失、不是字符串、解不出来一律拒发
 */
export function assertWriteBody(op: WriteOp, body: unknown, sealed: boolean): void {
  const schema = WRITE_QUERY_SCHEMAS[op]
  if (!schema) throw new ApiError('write_blocked', `未登记的写操作：${op}`)
  if (typeof body !== 'string') throw new ApiError('write_blocked', '写请求体缺少 body，未下发')
  if (!sealed) throw new ApiError('write_blocked', '写请求体没有经过写消息组装校验（encodeWrite），未下发')
  let decoded: Record<string, unknown>
  try {
    const bytes = body ? base64Decode(body) : new Uint8Array()
    // 只认规范 base64（encodeMessage 的输出）：带空白、base64url、中间带填充的拼接串等，本地和后端可能解出不同的字节，一律拒发
    if (base64Encode(bytes) !== body) throw new Error('不是规范 base64')
    decoded = fromBinary(schema, bytes) as unknown as Record<string, unknown>
  } catch (e) {
    throw new ApiError('write_blocked', '写请求体无法按 proto 解码，未下发', { cause: e })
  }
  assertEnumsDefined(schema, decoded)
  if ((op === 'ctrl-203' || op === 'unified-ctrls-send') && !isSendableMode(decoded.systemMode)) {
    throw new ApiError('write_blocked', `运行模式 ${String(decoded.systemMode)} 不是可选的模式，未下发`)
  }
}
