// 下发前的控制屏实时预检（赤兔 11/25 定，S13 走查 P2 修订）：S9 温控、S10c 新风（都经 features/thermostat/writes.ts 的 runOp）与
// S12 统一控制（features/unified/batch.ts 逐项目）共用这里的函数，以及写结果说明里的「504 可能离线」一句。
//
// - 每次下发前现查 ctrl 205（DeviceSummaryGet，读路由与解码同 S11 的 src/data/connections.ts），不缓存、不复用连接页的查询；
// - checkScreenOnce：查一次，单独 5 秒超时；超时就中止这次 205（迟到的应答直接丢弃，不改结论）；
// - preflightScreen：第一次超时自动再查一次（同样 5 秒）；两次都超时才判 timeout。503 / 403 / 其他失败不重查。
//   重查只发 205 读请求，不碰写请求；一次预检只给一个结论（S13 走查 P2：现场 205 偶发超过 5 秒、随后 0.3 秒就返回）；
// - 结论和文案分开（S13 P2）：503 → offline「控制屏未连接」；两次都超时 → timeout「控制屏在线检查超时」；
//   403（kind forbidden）→ forbidden，单独文案、不给重试；其余失败（500、断网、回包解不开）→ error「控制屏在线检查失败」。
//   会话 authed 且本地 permission_paths 没有 205（can(CONN_ROUTE)）时直接 'forbidden'、不发请求；
// - 没通过（不是 online）→ 调用方拦下、不发写请求（S9/S10c 预检期间短暂占锁、没通过立即释放；S12 不取锁）；
// - 205 只用于提前拦截：通过之后照常走原来的预检、下发与四态核对，判法不变（205 通过不代表一定能写成功）。
// 演示数据模式不发请求，直接按 online（演示数据的写本身也不发请求）。
import { CONN_ROUTE, toConnRows } from '@/data/connections'
import { can } from '@/data/session'
import { isMockMode } from './config'
import { getSession } from './session'
import { callCtrl } from './ctrl'
import { ApiError, isApiError } from './errors'

export type ScreenState = 'online' | 'offline' | 'timeout' | 'forbidden' | 'error'
/** 205 预检每次查询的单独超时 */
export const SCREEN_CHECK_MS = 5_000
/** 超时后最多再查几次（S13 P2：只重查一次） */
export const SCREEN_RETRIES = 1
/** 一次写请求等应答的上限（同 config.ctrlTimeoutMs 默认 12 秒）：统一控制决定还来不来得及重查时用 */
export const SCREEN_WRITE_MS = 12_000
/** 503：控制屏未连接 */
export const SCREEN_OFFLINE_TEXT = '控制屏未连接，暂不能下发'
/** 统一控制批次结果里离线项目的标注 */
export const SCREEN_OFFLINE_ROW = '未下发（控制屏未连接），可重新勾选下发'
/** 两次都超时（S13 P2）：和 503 分开，不说控制屏未连接 */
export const SCREEN_TIMEOUT_TEXT = '控制屏在线检查超时，未下发，请重试'
export const SCREEN_TIMEOUT_ROW = SCREEN_TIMEOUT_TEXT
/** 其他失败（500、断网、回包解不开）：同样不说控制屏未连接 */
export const SCREEN_ERROR_TEXT = '控制屏在线检查失败，未下发，请重试'
export const SCREEN_ERROR_ROW = SCREEN_ERROR_TEXT
/** 205 返回 403（账号没有连接状态权限）：同样拦下，单独文案 */
export const SCREEN_FORBIDDEN_TEXT = '当前账号无连接状态权限，无法确认控制屏在线，暂不能下发，请联系管理员'
export const SCREEN_FORBIDDEN_ROW = `未下发（${SCREEN_FORBIDDEN_TEXT}）`
type Blocked = Exclude<ScreenState, 'online'>
/** 预检没通过时给用户看的原因（温控、新风的提示和结果条） */
export const screenBlockText = (s: Blocked) =>
  s === 'forbidden' ? SCREEN_FORBIDDEN_TEXT : s === 'timeout' ? SCREEN_TIMEOUT_TEXT : s === 'error' ? SCREEN_ERROR_TEXT : SCREEN_OFFLINE_TEXT
/** 统一控制批次结果行的标注 */
export const screenBlockRow = (s: Blocked) =>
  s === 'forbidden' ? SCREEN_FORBIDDEN_ROW : s === 'timeout' ? SCREEN_TIMEOUT_ROW : s === 'error' ? SCREEN_ERROR_ROW : SCREEN_OFFLINE_ROW
/** 写请求收到网关纯文本 504（上游约 10 秒没等到控制屏应答）时，结果说明补的一句 */
export const NO_REPLY_504_NOTE = '控制屏 10 秒内没有应答，可能离线'

const classify = (e: unknown): ScreenState => {
  if (!isApiError(e)) return 'error'
  if (e.kind === 'aborted') return 'offline' // 调用方取消：调用方自己丢弃结论
  if (e.kind === 'timeout' && e.status === undefined) return 'timeout'
  if (e.kind === 'forbidden' && e.status === 403) return 'forbidden'
  if (e.status === 503) return 'offline'
  return 'error'
}

/** 会话已就绪（authed）且本地 permission_paths 没有 205（网关同样会回 403）：直接 forbidden，不发请求 */
const lacksPermission = () => getSession().status === 'authed' && !can(CONN_ROUTE)

/**
 * 现查一次 ctrl 205：成功（能解码）→ online；超过 5 秒 → timeout（并中止这次请求，迟到的应答丢弃）；403 → forbidden；
 * 503 → offline；其他失败 → error；调用方已取消 → offline（调用方自己丢弃）。不重查，重查见 preflightScreen
 */
export async function checkScreenOnce(projectId: string, signal?: AbortSignal): Promise<ScreenState> {
  if (isMockMode()) return 'online'
  // 会话还在加载等其他状态时权限列表不可信，照常请求 205，由网关的应答判断
  if (lacksPermission()) return 'forbidden'
  if (signal?.aborted) return 'offline'
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ScreenState>((r) => { timer = setTimeout(() => { r('timeout'); ac.abort() }, SCREEN_CHECK_MS) })
  const read = callCtrl(205, projectId, undefined, { signal: ac.signal }).then(
    (reply): ScreenState => { try { toConnRows(reply); return 'online' } catch { return 'error' } },
    classify,
  )
  try {
    return await Promise.race([read, timeout])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 下发前预检（温控、新风用）：查一次；超时且调用方没取消 → 再查一次（同样 5 秒）。最坏 10 秒。
 * 统一控制按批次剩余时间决定重不重查，自己用 checkScreenOnce 组合（batch.ts）
 */
export async function preflightScreen(projectId: string, signal?: AbortSignal): Promise<ScreenState> {
  let r = await checkScreenOnce(projectId, signal)
  for (let i = 0; i < SCREEN_RETRIES && r === 'timeout'; i++) {
    if (signal?.aborted) return 'offline'
    r = await checkScreenOnce(projectId, signal)
  }
  return r
}

/** 写请求的错误是网关纯文本 504（没有 gRPC 码；带 code 4 的 JSON 504 不算） */
export const isNoReply504 = (e: unknown): e is ApiError => isApiError(e) && e.status === 504 && e.code === undefined

/** 纯文本 504：在错误说明后补「控制屏 10 秒内没有应答，可能离线」；kind / status / code 不变（结果分类照旧是结果未知） */
export function withNoReplyNote(e: unknown): unknown {
  if (!isNoReply504(e) || e.message.includes(NO_REPLY_504_NOTE)) return e
  return new ApiError(e.kind, `${e.message}；${NO_REPLY_504_NOTE}`, { status: e.status, code: e.code, cause: e })
}
