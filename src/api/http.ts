// fetch 封装：JSON 请求、Bearer 令牌、超时、错误归一、令牌自动续期。
//
// 续期规则（docs/api/实测记录-1124.md Q4②）：
// - POST /auth/refresh {refresh_token} 必须带 Authorization: Bearer <当前 access_token>；
// - 每次刷新都会换新的 refresh_token，旧值立即作废 → 同一时刻只能有一个刷新在跑（单飞）；
// - access_token 过期前 60 秒主动续期；请求返回「未认证」（401 code 16 或网关 403 token err）时
//   续期一次并重放一次，再失败就清掉登录态并通知 onSessionExpired。
// 多标签页之间的互斥（Web Locks）在 S5 接入。
//
// 写接口只能走 requestWrite()（先过 guard.ts 防护、不重试、超时/断网提示结果未知）；
// request() 遇到写接口路径直接拒绝。
import { getConfig } from './config'
import { ApiError, errorFromResponse, errorFromThrown } from './errors'
import { assertWriteAllowed, isWritePath, WRITE_ROUTES, type WriteOp } from './guard'
import { clearTokens, readTokens, tokensFromResponse, writeTokens, type Tokens } from './tokens'

export interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** 是否带令牌（login 不带）。默认 true */
  auth?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/** 提前续期的余量 */
export const REFRESH_LEEWAY_MS = 60_000

// ---------------------------------------------------------------------------
// 会话过期通知（多个并发请求同时失败时 3 秒内只通知一次）

type Listener = (reason: ApiError) => void
const listeners = new Set<Listener>()
let lastExpiredAt = -Infinity
export function onSessionExpired(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
function expireSession(reason: ApiError) {
  clearTokens()
  const now = Date.now()
  if (now - lastExpiredAt < 3000) return
  lastExpiredAt = now
  for (const fn of listeners) fn(reason)
}

// ---------------------------------------------------------------------------
// 底层：一次 fetch，不做续期

const url = (path: string) => getConfig().apiBase + (path.startsWith('/') ? path : '/' + path)

async function send<T>(path: string, opts: RequestOptions, accessToken: string | null): Promise<T> {
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctl.abort() }, opts.timeoutMs ?? getConfig().requestTimeoutMs)
  const onAbort = () => ctl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  const method = opts.method ?? 'POST'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method === 'POST') headers['Content-Type'] = 'application/json'
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  try {
    const res = await fetch(url(path), {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: ctl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw errorFromResponse(res.status, res.headers.get('content-type'), text)
    if (!text.trim()) return {} as T
    try { return JSON.parse(text) as T } catch (e) {
      throw new ApiError('server', '服务器返回了无法解析的数据', { status: res.status, cause: e })
    }
  } catch (e) {
    throw errorFromThrown(e, timedOut)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// 续期（单飞）

let inflight: Promise<Tokens> | null = null

/** 刷新令牌。并发调用共用同一个请求。失败时清掉登录态并通知过期 */
export function refreshSession(): Promise<Tokens> {
  if (inflight) return inflight
  inflight = (async () => {
    const cur = readTokens()
    if (!cur) throw new ApiError('unauthenticated', '登录已过期，请重新登录')
    try {
      const r = await send<{ access_token?: string; refresh_token?: string; expires_in?: number }>(
        '/auth/refresh', { body: { refresh_token: cur.refreshToken } }, cur.accessToken)
      const next = tokensFromResponse(r)
      // 刷新途中退出或重新登录了：不能用旧会话的结果覆盖新会话
      const now = readTokens()
      if (!now || now.refreshToken !== cur.refreshToken) {
        if (now) return now
        throw new ApiError('unauthenticated', '登录已过期，请重新登录')
      }
      writeTokens(next)
      return next
    } catch (e) {
      const err = e instanceof ApiError ? e : errorFromThrown(e, false)
      // 失败的是旧会话：存储里已是另一个会话（或已退出），不清它
      const now = readTokens()
      if (!now || now.refreshToken !== cur.refreshToken) throw err
      // 网络问题不等于令牌失效，不清登录态；令牌被拒才算过期
      if (err.kind === 'unauthenticated' || err.kind === 'forbidden' || err.kind === 'bad_request') {
        const expired = new ApiError('unauthenticated', '登录已过期，请重新登录', { status: err.status, code: err.code, cause: err })
        expireSession(expired)
        throw expired
      }
      throw err
    }
  })().finally(() => { inflight = null })
  return inflight
}

/** 当前可用的 access_token；快过期时先续期 */
async function freshAccessToken(): Promise<string | null> {
  const t = readTokens()
  if (!t) return null
  if (t.expiresAt - Date.now() > REFRESH_LEEWAY_MS) return t.accessToken
  return (await refreshSession()).accessToken
}

// ---------------------------------------------------------------------------
// 对外入口

/** 普通请求（读接口、登录等）。写接口一律拒绝，须走 requestWrite() */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (isWritePath(path)) throw new ApiError('write_blocked', `写接口只能经 requestWrite() 下发：${path}`)
  return authed<T>(path, opts)
}

/**
 * 唯一的写入口：路径由写操作决定，发送前过写操作防护；不自动重试；
 * 超时或断网时结果未知（请求可能已经到达控制屏），提示页面回读确认，不重发。
 */
export async function requestWrite<T>(op: WriteOp, projectIds: readonly string[], body: unknown, opts: Omit<RequestOptions, 'body' | 'method' | 'auth'> = {}): Promise<T> {
  assertWriteAllowed(op, projectIds)
  try {
    return await authed<T>(WRITE_ROUTES[op], { ...opts, method: 'POST', body })
  } catch (e) {
    if (e instanceof ApiError && (e.kind === 'timeout' || e.kind === 'network')) {
      throw new ApiError(e.kind, e.kind === 'timeout' ? '未收到控制屏应答，下发结果未知' : '网络中断，下发结果未知', { status: e.status, code: e.code, cause: e })
    }
    throw e
  }
}

async function authed<T>(path: string, opts: RequestOptions): Promise<T> {
  if (opts.auth === false) return send<T>(path, opts, null)
  const token = await freshAccessToken()
  if (!token) {
    const err = new ApiError('unauthenticated', '登录已过期，请重新登录')
    expireSession(err)
    throw err
  }
  try {
    return await send<T>(path, opts, token)
  } catch (e) {
    if (!(e instanceof ApiError) || e.kind !== 'unauthenticated') throw e
    // 被拒的令牌如果已被别的请求续期替换，直接用新令牌重放；否则续期一次
    const now = readTokens()
    const next = now && now.accessToken !== token ? now.accessToken : (await refreshSession()).accessToken
    try {
      return await send<T>(path, opts, next)
    } catch (e2) {
      if (e2 instanceof ApiError && e2.kind === 'unauthenticated') expireSession(e2)
      throw e2
    }
  }
}

/** 仅供测试：重置模块内状态 */
export function __resetHttpForTests() {
  inflight = null
  lastExpiredAt = -Infinity
  listeners.clear()
}
