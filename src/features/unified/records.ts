// 统一控制的执行记录（POST /ctrl/unified-ctrls-records，docs/api/接口文档.md 11.2）与批量下发的发送函数。
//
// 后端 11/26 08:43（周强）：统一控制改用 unified-ctrls-send 下发（会写执行记录）；203 只是转发给控制屏的消息类型，不写记录。
// 做法（方案见 PR 描述）：仍是每个项目一条下发（project_ids 只放这一个项目，一个 batch_id），状态机、写锁、205 预检、
// 下发前后 200 回读都不变；只把「203 同步应答」换成「send 返回 batch_id → 轮询这条记录的执行状态」：
//
// | 记录（按 batch_id 查，本项目恰好 1 条） | 等价于原 203 应答 | 之后 |
// | 2 成功                                  | success=true      | 只算「已下发」，由 200 回读定 已生效 / 未变化 / 无法核对 / 结果未知 |
// | 3 失败                                  | success=false     | 明确被拒 → 失败，放锁 |
// | 4 超时、1 等待中直到窗口结束、0 条、多条、result 认不出、查询一直失败、403、离开页面、换了账号 | 应答未知 | 回读一致 → 已生效，否则结果未知；写锁转 unknown 继续自动核对 |
//
// 记录永远不会单独产生「已生效」。send 本身：认领前出错 = 未下发；403 / 400 = 失败；超时、断网、5xx、503（含 code 14）、
// 200 但没有 batch_id = 结果未知（请求可能已入库并转发给控制屏，不能让用户以为没发而重复下发）。
import { getUnifiedCtrlsRecords, sendUnifiedCtrls, type CtrlReply, type WriteQuery } from '@/api/ctrl'
import { getConfig } from '@/api/config'
import { ApiError, isApiError } from '@/api/errors'
import { currentAccount, sameAccount } from '@/api/writeLock'
import type { BatchProject, BatchSender } from './batch'

export type RecordResult = 'pending' | 'success' | 'failure' | 'timeout' | 'unknown'

/** result：数字 1–4、数字字符串、或以 WAITING / PENDING / SUCCESS / FAIL(ED|URE) / TIMEOUT 结尾的枚举名；其余（含 0、缺省）认不出 */
export function normalizeResult(v: unknown): RecordResult {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN
  if (n === 1) return 'pending'
  if (n === 2) return 'success'
  if (n === 3) return 'failure'
  if (n === 4) return 'timeout'
  if (typeof v !== 'string') return 'unknown'
  const s = v.trim().toUpperCase()
  if (/(^|_)(WAITING|PENDING)$/.test(s)) return 'pending'
  if (/(^|_)SUCCESS$/.test(s)) return 'success'
  if (/(^|_)(FAIL|FAILED|FAILURE)$/.test(s)) return 'failure'
  if (/(^|_)TIMEOUT$/.test(s)) return 'timeout'
  return 'unknown'
}

/** 记录里的 message 只在「失败」时进「下发核对」明细：去控制字符、截断 80 字 */
export function cleanMessage(v: unknown): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

/**
 * 记录的 operate_time（"yyyy-MM-dd HH:mm:ss"）：后端 11/26 确认是 UTC、不带时区，由前端转换。按 UTC 解析，转成北京时间
 * （Asia/Shanghai）同样格式；格式不对返回 null（结果卡退回前端记录的下发时间）
 */
export function utcToBeijing(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v.trim()) : null
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || d.getUTCHours() !== +m[4] || d.getUTCMinutes() !== +m[5] || d.getUTCSeconds() !== +m[6]) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export type Picked = { kind: 'one'; result: RecordResult; message: string; operateTime: string | null } | { kind: 'none' } | { kind: 'many' }
/** 本批次里本项目的记录：batch_id、project_id 都对上的恰好一条才采用（REVIEW 12.3 第 9 条：重复或缺失都算无法确认） */
export function pickRecord(reply: unknown, batchId: string, projectId: string): Picked {
  const list = (reply as { records?: unknown } | null)?.records
  const rows = (Array.isArray(list) ? list : []).filter((r): r is Record<string, unknown> =>
    !!r && typeof r === 'object' && (r as Record<string, unknown>).project_id === projectId && (r as Record<string, unknown>).batch_id === batchId)
  if (rows.length === 0) return { kind: 'none' }
  if (rows.length > 1) return { kind: 'many' }
  return { kind: 'one', result: normalizeResult(rows[0].result), message: cleanMessage(rows[0].message), operateTime: utcToBeijing(rows[0].operate_time) }
}

/** 记录轮询：send 返回后 1 秒查第一次，之后上一次返回后隔 2.5 秒；单次 5 秒超时；窗口 = ctrlTimeoutMs（默认 12 秒） */
export const RECORD_FIRST_MS = 1_000
export const RECORD_EVERY_MS = 2_500
export const RECORD_REQUEST_MS = 5_000

export const RECORD_TEXT = {
  timeout: '已下发，结果未知：执行记录为「超时」（控制屏 30 秒内未回调）',
  pending: '已下发，结果未知：执行记录仍在等待中',
  none: '已下发，结果未知：未查到本次执行记录',
  many: '已下发，结果未知：执行记录重复，无法确认',
  unrecognized: '已下发，结果未知：执行记录状态无法识别',
  forbidden: '已下发，结果未知：当前账号无执行记录查询权限',
  readFailed: '已下发，结果未知：执行记录查询失败',
  aborted: '已下发，结果未知：已离开页面，未继续查询执行记录',
  account: '已下发，结果未知：登录账号已变化，未采用执行记录',
  noBatch: '已下发，结果未知：下发接口未返回批次号',
  sendUnavailable: '已下发，结果未知：下发接口暂不可用（503）',
  failed: '执行记录：失败',
} as const

/** operateTime：记录的操作时间（已转北京时间），没有或格式不对为 null */
export type RecordOutcome = { kind: 'success'; operateTime: string | null } | { kind: 'failure'; message: string; operateTime: string | null } | { kind: 'unknown'; note: string }

export interface WaitDeps {
  query?: (filter: { batch_id: string }, signal: AbortSignal) => Promise<unknown>
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  windowMs?: number
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const t = setTimeout(done, ms)
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve() }
  signal.addEventListener('abort', done)
})

/** 轮询本项目这条记录，直到终态（成功 / 失败 / 超时）或窗口结束；只读，不重试下发 */
export async function waitRecord(batchId: string, projectId: string, signal: AbortSignal, deps: WaitDeps = {}): Promise<RecordOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const query = deps.query ?? ((f, s) => getUnifiedCtrlsRecords(f, s, RECORD_REQUEST_MS))
  const end = now() + (deps.windowMs ?? getConfig().ctrlTimeoutMs)
  const acct = currentAccount()
  let last: string = RECORD_TEXT.none
  await sleep(RECORD_FIRST_MS, signal)
  for (;;) {
    if (signal.aborted) return { kind: 'unknown', note: RECORD_TEXT.aborted }
    let reply: unknown
    let ok = false
    try { reply = await query({ batch_id: batchId }, signal); ok = true } catch (e) {
      if (signal.aborted) return { kind: 'unknown', note: RECORD_TEXT.aborted }
      // 403 无权限：不再查（也不当成登录失效）
      if (isApiError(e) && e.kind === 'forbidden') return { kind: 'unknown', note: RECORD_TEXT.forbidden }
      last = RECORD_TEXT.readFailed
    }
    // 迟到的响应：离开页面或换了账号就丢弃
    if (signal.aborted) return { kind: 'unknown', note: RECORD_TEXT.aborted }
    if (!sameAccount(acct, currentAccount())) return { kind: 'unknown', note: RECORD_TEXT.account }
    if (ok) {
      const p = pickRecord(reply, batchId, projectId)
      if (p.kind === 'many') return { kind: 'unknown', note: RECORD_TEXT.many }
      if (p.kind === 'none') last = RECORD_TEXT.none
      else if (p.result === 'success') return { kind: 'success', operateTime: p.operateTime }
      else if (p.result === 'failure') return { kind: 'failure', message: p.message, operateTime: p.operateTime }
      else if (p.result === 'timeout') return { kind: 'unknown', note: RECORD_TEXT.timeout }
      else last = p.result === 'pending' ? RECORD_TEXT.pending : RECORD_TEXT.unrecognized
    }
    if (now() + RECORD_EVERY_MS > end) return { kind: 'unknown', note: last }
    await sleep(RECORD_EVERY_MS, signal)
  }
}

/** 下发接口返回 503（含 code 14）：批量接口对屏离线是记「失败」而不是 503，这里的 503 含义未知 → 结果未知（不是「未下发」） */
function sendError(e: unknown): unknown {
  if (isApiError(e) && e.kind === 'unavailable') return new ApiError('unavailable', RECORD_TEXT.sendUnavailable, { status: e.status, cause: e })
  return e
}

/**
 * 统一控制的发送函数（替代 writeCtrl(203)）：unified-ctrls-send 只带这一个项目 → batch_id → 轮询记录 → 折算成原 203 应答的形状。
 * 成功 → { success: true, operateTime }；失败 → { success: false, msg, operateTime }（operateTime 是记录的操作时间，已转北京时间，结果卡优先显示它）（状态机按明确被拒）；其余 → 抛 timeout（状态机按应答未知，交给回读和写锁）
 */
export function createRecordSender(deps: WaitDeps & { send?: typeof sendUnifiedCtrls } = {}): BatchSender {
  const send = deps.send ?? sendUnifiedCtrls
  return async (project: BatchProject, query: WriteQuery<203>, opts) => {
    let res: { batch_id?: unknown } | null | undefined
    try { res = await send([project], query, { beforeSend: opts.beforeSend }) } catch (e) { throw sendError(e) }
    const batchId = typeof res?.batch_id === 'string' && res.batch_id ? res.batch_id : null
    if (!batchId) throw new ApiError('timeout', RECORD_TEXT.noBatch)
    const r = await waitRecord(batchId, project.id, opts.signal, deps)
    if (r.kind === 'success') return { success: true, msg: '', operateTime: r.operateTime } as unknown as CtrlReply<203>
    if (r.kind === 'failure') return { success: false, msg: r.message ? `${RECORD_TEXT.failed}（${r.message}）` : RECORD_TEXT.failed, operateTime: r.operateTime } as unknown as CtrlReply<203>
    throw new ApiError('timeout', r.note)
  }
}
