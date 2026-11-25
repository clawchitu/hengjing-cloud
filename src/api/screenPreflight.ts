// 下发前的控制屏实时预检（赤兔 11/25 定）：S9 温控、S10c 新风（都经 features/thermostat/writes.ts 的 runOp）与 S12 统一控制
// （features/unified/batch.ts 逐项目）共用这一个函数，以及写结果说明里的「504 可能离线」一句。
//
// - 每次下发前现查 ctrl 205（DeviceSummaryGet，读路由与解码同 S11 的 src/data/connections.ts），不缓存、不复用连接页的查询；
// - 单独 5 秒超时；返回 503、超时或任何失败 → 不是 online，调用方按「控制屏未连接，暂不能下发」拦下、不发写请求（S9/S10c 预检期间短暂占锁、没通过立即释放；S12 不取锁），界面给「重试」；
//   会话 authed 且本地 permission_paths 没有 205（can(CONN_ROUTE)）时直接 'forbidden'、不发请求；返回 403（kind forbidden）→ 'forbidden'：同样拦下，但单独文案（赤兔 11/25），不给重试；
// - 205 只用于提前拦截：通过之后照常走原来的预检、下发与四态核对，判法不变（205 通过不代表一定能写成功）。
// 演示数据模式不发请求，直接按 online（演示数据的写本身也不发请求）。
import { CONN_ROUTE, toConnRows } from '@/data/connections'
import { can } from '@/data/session'
import { isMockMode } from './config'
import { getSession } from './session'
import { callCtrl } from './ctrl'
import { ApiError, isApiError } from './errors'

export type ScreenState = 'online' | 'offline' | 'timeout' | 'forbidden'
/** 205 预检的单独超时 */
export const SCREEN_CHECK_MS = 5_000
/** 预检没通过时给用户看的原因（三处共用） */
export const SCREEN_OFFLINE_TEXT = '控制屏未连接，暂不能下发'
/** 统一控制批次结果里离线项目的标注 */
export const SCREEN_OFFLINE_ROW = '未下发（控制屏未连接），可重新勾选下发'
/** 205 返回 403（账号没有连接状态权限）：同样拦下，单独文案 */
export const SCREEN_FORBIDDEN_TEXT = '当前账号无连接状态权限，无法确认控制屏在线，暂不能下发，请联系管理员'
export const SCREEN_FORBIDDEN_ROW = `未下发（${SCREEN_FORBIDDEN_TEXT}）`
/** 预检没通过时给用户看的原因：403 单独一句，其余（503 / 超时 / 失败）都是控制屏未连接 */
export const screenBlockText = (s: Exclude<ScreenState, 'online'>) => (s === 'forbidden' ? SCREEN_FORBIDDEN_TEXT : SCREEN_OFFLINE_TEXT)
/** 写请求收到网关纯文本 504（上游约 10 秒没等到控制屏应答）时，结果说明补的一句 */
export const NO_REPLY_504_NOTE = '控制屏 10 秒内没有应答，可能离线'

/** 现查一次 ctrl 205：成功（能解码）→ online；超过 5 秒 → timeout；403 无权限 → forbidden；503 / 其他失败 / 调用方取消 → offline */
export async function preflightScreen(projectId: string, signal?: AbortSignal): Promise<ScreenState> {
  if (isMockMode()) return 'online'
  // 会话已就绪（authed）且本地 permission_paths 没有 205（网关同样会回 403）：直接 forbidden，不发请求；
  // 会话还在加载等其他状态时权限列表不可信，照常请求 205，由网关的应答判断
  if (getSession().status === 'authed' && !can(CONN_ROUTE)) return 'forbidden'
  if (signal?.aborted) return 'offline'
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ScreenState>((r) => { timer = setTimeout(() => { r('timeout'); ac.abort() }, SCREEN_CHECK_MS) })
  const read = callCtrl(205, projectId, undefined, { signal: ac.signal }).then(
    (reply): ScreenState => { toConnRows(reply); return 'online' },
    (e): ScreenState => (!isApiError(e) ? 'offline' : e.kind === 'timeout' && e.status === undefined ? 'timeout' : e.kind === 'forbidden' && e.status === 403 ? 'forbidden' : 'offline'),
  )
  try {
    return await Promise.race([read, timeout])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 写请求的错误是网关纯文本 504（没有 gRPC 码；带 code 4 的 JSON 504 不算） */
export const isNoReply504 = (e: unknown): e is ApiError => isApiError(e) && e.status === 504 && e.code === undefined

/** 纯文本 504：在错误说明后补「控制屏 10 秒内没有应答，可能离线」；kind / status / code 不变（结果分类照旧是结果未知） */
export function withNoReplyNote(e: unknown): unknown {
  if (!isNoReply504(e) || e.message.includes(NO_REPLY_504_NOTE)) return e
  return new ApiError(e.kind, `${e.message}；${NO_REPLY_504_NOTE}`, { status: e.status, code: e.code, cause: e })
}
