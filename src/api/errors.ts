// 错误归一：把 HTTP 状态、后端 JSON {code,message}、网关纯文本、网络/超时、ctrl 业务错误
// 统一成 ApiError，页面只看 kind 决定怎么展示。依据 docs/api/实测记录-1124.md「错误体格式」。

export type ApiErrorKind =
  | 'unauthenticated' // 未登录 / 令牌失效：401 code 16，或网关 403 "token err"
  | 'forbidden' // 无权限：网关 403 "no permission"，或 code 7
  | 'unavailable' // 控制屏未连接：503 code 14
  | 'timeout' // 前端超时，或 504 code 4（控制屏未应答）
  | 'network' // 网络断开
  | 'bad_request' // 参数错误等 4xx
  | 'server' // 500 code 13 等
  | 'ctrl' // ctrl 业务失败：HTTP 200，但回复里带错误文案或 success=false
  | 'write_blocked' // 写操作被前端防护拦截（guard.ts）
  | 'aborted' // 调用方主动取消（如页面卸载）

// ---------------------------------------------------------------------------
// 脱敏：错误信息、日志里不能出现令牌原文

const JWT = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g
const BEARER = /(Bearer\s+)[^\s"',;]+/gi
const TOKEN_FIELD = /((?:access|refresh)_?token["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi
const secretSources: Array<() => string[]> = []
/** 登记额外的敏感串来源（tokens.ts 登记当前令牌） */
export function registerSecrets(fn: () => string[]) { secretSources.push(fn) }

/** 把文本里的 JWT、Bearer 值、*_token 字段值和已登记的令牌原文替换成 *** */
export function redact(text: string): string {
  let out = text.replace(JWT, '***').replace(BEARER, '$1***').replace(TOKEN_FIELD, '$1***')
  for (const src of secretSources) {
    let list: string[] = []
    try { list = src() } catch { /* 读不到存储就跳过 */ }
    for (const s of list) if (s && s.length >= 8) out = out.split(s).join('***')
  }
  return out
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  /** 后端 gRPC 错误码（JSON 错误体里的 code） */
  readonly code?: number
  constructor(kind: ApiErrorKind, message: string, opts: { status?: number; code?: number; cause?: unknown } = {}) {
    super(redact(message), opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'ApiError'
    this.kind = kind
    this.status = opts.status
    this.code = opts.code
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError

const DEFAULT_TEXT: Record<ApiErrorKind, string> = {
  unauthenticated: '登录已过期，请重新登录',
  forbidden: '无权限',
  unavailable: '控制屏未连接',
  timeout: '请求超时',
  network: '网络连接失败',
  bad_request: '请求参数有误',
  server: '服务器错误',
  ctrl: '操作失败',
  write_blocked: '当前环境不允许下发',
  aborted: '请求已取消',
}
export const defaultText = (k: ApiErrorKind) => DEFAULT_TEXT[k]

/** gRPC 码 → kind（网关按 gRPC 码映射 HTTP：16→401、13→500、14→503） */
function kindOfGrpc(code: number): ApiErrorKind | null {
  switch (code) {
    case 16: return 'unauthenticated'
    case 7: return 'forbidden'
    case 14: return 'unavailable'
    case 4: return 'timeout'
    case 3: case 5: case 6: case 9: case 11: return 'bad_request'
    case 1: return 'aborted'
    case 0: return null
    default: return 'server'
  }
}

function kindOfStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  if (status === 502) return 'network'
  if (status === 503) return 'unavailable'
  if (status === 504 || status === 408) return 'timeout'
  if (status >= 400 && status < 500) return 'bad_request'
  return 'server'
}

/** 由非 2xx 响应的状态码、Content-Type 和响应文本生成 ApiError */
export function errorFromResponse(status: number, contentType: string | null, text: string): ApiError {
  const body = text.trim()
  // 网关层错误是纯文本
  if (!/json/i.test(contentType ?? '') || !body.startsWith('{')) {
    if (status === 403 && body === 'token err') return new ApiError('unauthenticated', DEFAULT_TEXT.unauthenticated, { status })
    if (status === 403 && body === 'no permission') return new ApiError('forbidden', DEFAULT_TEXT.forbidden, { status })
    const kind = kindOfStatus(status)
    return new ApiError(kind, DEFAULT_TEXT[kind], { status })
  }
  let code: number | undefined
  let message: string | undefined
  try {
    const j = JSON.parse(body) as { code?: unknown; message?: unknown }
    if (typeof j.code === 'number') code = j.code
    if (typeof j.message === 'string' && j.message) message = j.message
  } catch { /* 当作无体处理 */ }
  // 502（Worker / 网关连不上后端）：请求可能已经到了后端，按网络中断处理，写操作提示结果未知
  const kind = status === 502 ? 'network' : (code !== undefined ? kindOfGrpc(code) : null) ?? kindOfStatus(status)
  // 令牌类错误的后端文案（no token / jwt.ParseWithClaims failed…）是技术细节，统一成中文提示
  // （「密码错误，请重试」这类业务文案保留）
  const technical = kind === 'unauthenticated' && /token|jwt/i.test(message ?? '')
  return new ApiError(kind, message && !technical ? message : DEFAULT_TEXT[kind], { status, code })
}

/** fetch 本身抛出的错误（断网、超时、取消） */
export function errorFromThrown(e: unknown, timedOut: boolean): ApiError {
  if (isApiError(e)) return e
  if (timedOut) return new ApiError('timeout', DEFAULT_TEXT.timeout, { cause: e })
  if (e instanceof DOMException && e.name === 'AbortError') return new ApiError('aborted', DEFAULT_TEXT.aborted, { cause: e })
  return new ApiError('network', DEFAULT_TEXT.network, { cause: e })
}

/** 读请求是否值得自动重试一次（写请求一律不重试） */
export const isRetryable = (e: unknown) => isApiError(e) && (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'server')
