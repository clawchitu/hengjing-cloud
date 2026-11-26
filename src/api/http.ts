// fetch 封装：JSON 请求、Bearer 令牌、超时、错误归一、令牌自动续期。
//
// 续期规则（docs/api/实测记录-1124.md Q4②）：
// - POST /auth/refresh {refresh_token} 必须带 Authorization: Bearer <当前 access_token>；
// - 每次刷新都会换新的 refresh_token，旧值立即作废 → 同一时刻只能有一个刷新在跑（单飞）；
// - access_token 过期前 60 秒主动续期；请求返回「未认证」（401 code 16 或网关 403 token err）时
//   续期一次并重放一次，再失败就清掉登录态并通知 onSessionExpired。
// 多标签页之间用 Web Locks 互斥：拿到锁后先看存储里的 refresh_token 是否已被别的标签页换掉，
// 换掉了就直接用新令牌，不再发刷新（否则会拿已作废的旧值去刷新，把所有标签页踢下线）。
// 令牌存 sessionStorage，各标签页各存一份（新开的标签页从已登录的标签页要来同一份），所以续期成功后
// 用 BroadcastChannel 把「旧 refresh → 新令牌」告诉其他标签页（sessionChannel.ts），还持有旧值的标签页
// 直接换上新令牌。广播发出后再占住锁一小会儿（ROTATION_SETTLE_MS），让排队的标签页先收到广播再拿锁。
//
// 写接口只能走 requestWrite()（先过 guard.ts 防护、不重试、超时/断网提示结果未知）；
// request() 遇到写接口路径直接拒绝。写请求不走上面的「未认证 → 续期 → 重放」：发送前先确保令牌有效，
// 收到未认证直接结束这次下发（WRITE_AUTH_TEXT），绝不重放；真正调用 fetch 前同步执行一次 beforeSend 复核。
import { getConfig } from './config'
import { ApiError, errorFromResponse, errorFromThrown } from './errors'
import { assertWriteAllowed, assertWriteBodyEnums, isNonCanonicalPath, isWritePath, WRITE_ROUTES, type WriteOp, type WriteProject } from './guard'
import { __resetSessionChannelForTests, hasSessionChannel, postSession, type SessionMessage } from './sessionChannel'
import { clearTokens, isTokens, jwtSub, readTokens, tokensFromResponse, writeTokens, type Tokens } from './tokens'

export interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** 是否带令牌（login 不带）。默认 true */
  auth?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /** 指定用哪个 access_token，不读存储、不续期、不重放（退出时用已经从存储取出的令牌） */
  accessToken?: string
}

/** 提前续期的余量 */
export const REFRESH_LEEWAY_MS = 60_000
/** 刷新被拒后等其他标签页广播新令牌的时间 */
const ROTATION_GRACE_MS = 300
/** 续期成功并广播后继续占锁的时间：锁的交接和广播走不同的通道，先后没有保证 */
const ROTATION_SETTLE_MS = 100

// ---------------------------------------------------------------------------
// 会话过期通知。同一个会话的多个并发请求同时失败时 3 秒内只通知一次；
// 去重按会话（refresh_token）区分，重新登录后的新会话过期照常通知。

type Listener = (reason: ApiError) => void
const listeners = new Set<Listener>()
let lastExpiredAt = -Infinity
let lastExpiredKey: string | undefined
export function onSessionExpired(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
function expireSession(reason: ApiError) {
  // 令牌已经清掉了：说明是刚才那个会话的后续失败，沿用上一次的键
  const key = readTokens()?.refreshToken ?? lastExpiredKey ?? ''
  clearTokens()
  const now = Date.now()
  if (key === lastExpiredKey && now - lastExpiredAt < 3000) return
  lastExpiredAt = now
  lastExpiredKey = key
  for (const fn of listeners) fn(reason)
}

// ---------------------------------------------------------------------------
// 跨标签页同步续期结果（见文件头；频道的订阅在 session.ts 的 initSession）

type Rotation = Extract<SessionMessage, { type: 'rotated' }>
/** 别的标签页续期了：本页还持有同一个旧 refresh_token 就换成新令牌。返回是否换了 */
export function adoptRotation(m: Rotation | null | undefined): boolean {
  if (!m || m.type !== 'rotated' || !isTokens(m.to)) return false
  if (readTokens()?.refreshToken !== m.from) return false
  writeTokens(m.to)
  return true
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 底层：一次 fetch，不做续期

const url = (path: string) => getConfig().apiBase + (path.startsWith('/') ? path : '/' + path)

async function send<T>(path: string, opts: RequestOptions, accessToken: string | null, beforeFetch?: () => void): Promise<T> {
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
    // 写请求的最后复核：和下面的 fetch 调用在同一段同步代码里，中间不让出
    beforeFetch?.()
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

const LOCK_NAME = 'hjc-token-refresh'
/**
 * 跨标签页互斥；不支持 Web Locks 的环境（旧浏览器、node）退化为只在页内单飞。
 * fn 的结果一出来就交给调用方；hold() 为真时（刚广播了新令牌）再占锁 ROTATION_SETTLE_MS 才放
 */
function withRefreshLock<T>(fn: () => Promise<T>, hold: () => boolean): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined
  if (!locks?.request) return fn()
  return new Promise<T>((resolve, reject) => {
    Promise.resolve(locks.request(LOCK_NAME, async () => {
      try { resolve(await fn()) } catch (e) { reject(e); return }
      if (hold()) await new Promise<void>((done) => {
        const t = setTimeout(release, ROTATION_SETTLE_MS)
        function release() { clearTimeout(t); releaseHold = null; done() }
        releaseHold = release
      })
    })).catch(reject)
  })
}
/** 正在占着的锁（续期广播后的那一小段）；测试重置时立即放掉，免得假时钟下锁一直不放 */
let releaseHold: (() => void) | null = null

/** 刷新令牌。页内并发调用共用同一个请求，多标签页之间串行。失败时清掉登录态并通知过期 */
export function refreshSession(): Promise<Tokens> {
  if (inflight) return inflight
  const seen = readTokens()?.refreshToken
  let rotated = false
  inflight = withRefreshLock(async () => {
    const cur = readTokens()
    if (!cur) throw new ApiError('unauthenticated', '登录已过期，请重新登录')
    // 等锁期间别的标签页已经续期（或重新登录）：直接用存储里的新令牌
    if (seen !== undefined && cur.refreshToken !== seen) return cur
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
      postSession({ type: 'rotated', from: cur.refreshToken, to: next })
      rotated = true
      return next
    } catch (e) {
      const err = e instanceof ApiError ? e : errorFromThrown(e, false)
      // refresh 被拒可能是别的标签页刚轮换过、广播还没到：稍等再看一次
      if (hasSessionChannel()) await sleep(ROTATION_GRACE_MS)
      const now = readTokens()
      // 存储里已是新令牌（别的标签页续期，或本页重新登录）：直接用；已退出：不再清
      if (now && now.refreshToken !== cur.refreshToken) return now
      if (!now) throw err
      // 续期失败一律按过期处理、回登录页（含断网、超时、服务器错误）：refresh_token 每次轮换，
      // 失败后无法确定服务端是否已作废旧值，继续用旧值只会更乱
      const expired = new ApiError('unauthenticated', '登录已过期，请重新登录', { status: err.status, code: err.code, cause: err })
      expireSession(expired)
      throw expired
    }
  }, () => rotated).finally(() => { inflight = null })
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
  // 非规范路径（. / ..、反斜杠、空白、编码的分隔符）一律拒绝；写接口路径先规范化再判断，
  // 拼上 apiBase 后的完整地址也判断一次（防 .. 越过 apiBase 的写法）
  if (isNonCanonicalPath(path)) throw new ApiError('bad_request', `请求路径不规范：${JSON.stringify(path)}`)
  if (isWritePath(path) || isWritePath(url(path))) throw new ApiError('write_blocked', `写接口只能经 requestWrite() 下发：${path}`)
  return authed<T>(path, opts)
}

/**
 * 唯一的写入口：路径由写操作决定，发送前过写操作防护（按项目 code 比对白名单）；不自动重试；
 * 超时或断网时结果未知（请求可能已经到达控制屏），提示页面回读确认，不重发。
 * 目标项目字段由这里用防护通过后的快照填入（只用 id）：批量统一控制填 project_ids，其余写消息填
 * project_id（只能一个项目）。调用方的 body 不得自带 project_id / project_ids，否则拒绝。
 * body 只接受普通对象（原型是 Object.prototype 或 null）；字段值是函数（含 toJSON）、getter/setter、
 * Symbol 键一律拒绝，不做清洗。通过后按已校验的描述符拷贝成新对象，再填入快照里的 id。
 */
function plainWriteBody(body: unknown): Record<string, unknown> {
  const bad = (why: string) => new ApiError('write_blocked', `写请求体格式不对：${why}`)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('不是普通对象')
  const out: Record<string, unknown> = {}
  try {
    const proto = Object.getPrototypeOf(body)
    if (proto !== Object.prototype && proto !== null) throw bad('不是普通对象')
    // 键和描述符各只取一次，拷贝只用这次校验过的值（防 Proxy 前后返回不同内容）
    for (const key of Reflect.ownKeys(body)) {
      if (typeof key !== 'string') throw bad('含 Symbol 键')
      const d = Object.getOwnPropertyDescriptor(body, key)
      if (!d) continue
      if (!('value' in d) || d.get || d.set) throw bad(`字段 ${key} 是访问器`)
      if (typeof d.value === 'function') throw bad(`字段 ${key} 是函数`)
      if (/^project_?ids?$/i.test(key)) throw new ApiError('write_blocked', '写请求体不能自带项目字段')
      if (d.enumerable) out[key] = d.value
    }
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw bad('无法读取')
  }
  return out
}

/** 写请求收到未认证（401 / token err）时的提示：不重放，按「没执行」结束 */
export const WRITE_AUTH_TEXT = '登录状态已更新，请重新下发'
/** 令牌解析不出账号（sub）：无法绑定实际令牌的身份，一律不发 */
export const WRITE_LOGIN_ABNORMAL_TEXT = '登录状态异常，请重新登录后下发'
/** 发送前发现存储里已换成别的账号 */
export const WRITE_ACCOUNT_TEXT = '登录账号已变化，未下发'
/** 发送前取消信号已中止 */
export const WRITE_CANCELLED_TEXT = '已取消，未下发'
/** 控制屏未连接（503 code 14）：后端没有转发，确定没执行 */
export const WRITE_OFFLINE_TEXT = '控制屏未连接，未下发'
/** beforeSend 不通过时的提示 */
export const WRITE_RECHECK_TEXT = '发送前复核未通过，未下发'

export interface WriteOptions extends Omit<RequestOptions, 'body' | 'method' | 'auth' | 'accessToken'> {
  /**
   * 发送前复核（同步）：令牌续期等完之后、真正调用 fetch 之前执行一次，返回 true 才发。
   * 调用方在这里复核取消信号、页面是否还在、项目当前在线状态与 code、批次截止时间等。抛错按 false 处理
   */
  beforeSend?: () => boolean
}

export async function requestWrite<T>(op: WriteOp, projects: readonly WriteProject[], body: Record<string, unknown>, opts: WriteOptions = {}): Promise<T> {
  const allowed = assertWriteAllowed(op, projects)
  const copy = plainWriteBody(body)
  let target: Record<string, unknown>
  if (op === 'unified-ctrls-send') target = { project_ids: allowed.map((p) => p.id) }
  else if (allowed.length === 1) target = { project_id: allowed[0].id }
  else throw new ApiError('write_blocked', '单项目写消息只能指定一个项目')
  // 只允许已知的键（单项目 user_id、body；批量只有 body，操作人由后端取登录用户）：别的字段（如批量的 shadow_body）不校验，不能带
  const keys = op === 'unified-ctrls-send' ? ['body'] : ['user_id', 'body']
  const extra = Object.keys(copy).filter((k) => !keys.includes(k))
  if (extra.length) throw new ApiError('write_blocked', `写请求体不能带字段：${extra.join('、')}`)
  if (copy.user_id !== undefined && typeof copy.user_id !== 'string') throw new ApiError('write_blocked', '写请求体 user_id 不是字符串')
  // 发送边界的枚举检查：直接调 requestWrite 也绕不过（201/203/204/206 与批量都经这里）
  assertWriteBodyEnums(op, copy.body)
  const payload = { ...copy, ...target }
  try {
    return await writeOnce<T>(WRITE_ROUTES[op], { ...opts, method: 'POST', body: payload })
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'unavailable' && e.code === 14) {
      throw new ApiError('unavailable', WRITE_OFFLINE_TEXT, { status: e.status, code: 14, cause: e })
    }
    if (e instanceof ApiError && (e.kind === 'timeout' || e.kind === 'network')) {
      const text = e.kind === 'timeout' ? '未收到控制屏应答，下发结果未知' : e.status === 502 ? '后端连接失败，下发结果未知' : '网络中断，下发结果未知'
      throw new ApiError(e.kind, text, { status: e.status, code: e.code, cause: e })
    }
    throw e
  }
}

/**
 * 写请求只发一次：先确保令牌有效（快过期就先续期；没有令牌 → 未发出），再同步执行 beforeSend，通过才 fetch。
 * 收到未认证不重放，抛 unauthenticated（无 status：确定没执行），并在后台续期一次让登录状态更新
 */
async function writeOnce<T>(path: string, opts: WriteOptions & { method: 'POST'; body: unknown }): Promise<T> {
  const { beforeSend, ...rest } = opts
  // 发起时的账号：续期期间存储被换成别的账号，refreshSession 可能直接返回新账号的令牌，这种情况不能发
  const startSub = jwtSub(readTokens()?.accessToken)
  const token = await freshAccessToken()
  if (!token) {
    const err = new ApiError('unauthenticated', '登录已过期，请重新登录')
    expireSession(err)
    throw err
  }
  const check = () => {
    // 最先看取消信号：已中止就不调 fetch
    if (rest.signal?.aborted) throw new ApiError('write_blocked', WRITE_CANCELLED_TEXT)
    // 账号绑定：要用的令牌必须仍是存储里当前账号的令牌（续期期间别的标签页换了账号就不发）
    const cur = readTokens()?.accessToken
    const curSub = jwtSub(cur)
    // 发起时、实际要用的、存储里当前的令牌，任一解析不出 sub（含空串、空白、非字符串）或已退出：
    // 无法可靠绑定身份，不发（本地拦截，确定没执行）。201/203/204/206 与批量都经这里
    if (startSub === null || jwtSub(token) === null || curSub === null) throw new ApiError('write_blocked', WRITE_LOGIN_ABNORMAL_TEXT)
    if (jwtSub(token) !== startSub || curSub !== startSub) throw new ApiError('write_blocked', WRITE_ACCOUNT_TEXT)
    let ok = false
    try { ok = beforeSend ? beforeSend() === true : true } catch { ok = false }
    if (!ok) throw new ApiError('write_blocked', WRITE_RECHECK_TEXT)
  }
  try {
    return await send<T>(path, rest, token, check)
  } catch (e) {
    if (!(e instanceof ApiError) || e.kind !== 'unauthenticated') throw e
    // 令牌被拒：只在存储里仍是这个令牌时续期一次（失败会按过期处理），不重放写请求
    if (readTokens()?.accessToken === token) void refreshSession().catch(() => {})
    throw new ApiError('unauthenticated', WRITE_AUTH_TEXT, { code: e.code, cause: e })
  }
}

async function authed<T>(path: string, opts: RequestOptions): Promise<T> {
  if (opts.auth === false) return send<T>(path, opts, null)
  if (opts.accessToken) return send<T>(path, opts, opts.accessToken)
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
    // 重放绑定发起时的用户：期间换了账号登录，就不能拿新账号的令牌去执行旧账号发起的请求，
    // 也不能因为这次失败把新会话登出
    if (jwtSub(next) !== jwtSub(token)) throw e
    try {
      return await send<T>(path, opts, next)
    } catch (e2) {
      // 只在存储里仍是重放用的那个令牌时才算这个会话过期
      if (e2 instanceof ApiError && e2.kind === 'unauthenticated' && readTokens()?.accessToken === next) expireSession(e2)
      throw e2
    }
  }
}

/** 仅供测试：重置模块内状态 */
export function __resetHttpForTests() {
  inflight = null
  lastExpiredAt = -Infinity
  lastExpiredKey = undefined
  listeners.clear()
  releaseHold?.()
  __resetSessionChannelForTests()
}
