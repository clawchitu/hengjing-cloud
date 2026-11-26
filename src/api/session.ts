// 登录态（真实接口模式）。状态只有三种：anon 未登录、loading 正在取 /me 确认身份、authed 已登录。
//
// - 登录：POST /auth/login（isdp=true）→ 用拿到的令牌取 GET /me → 确认本次登录仍有效（期间没有退出或
//   再次登录）后才写入存储、转为 authed。/me 失败视为登录失败。
// - 令牌只在 sessionStorage（tokens.ts）：关掉浏览器就没了，要重新登录。
// - 刷新页面：存储里有令牌就取 /me 恢复；失败（令牌被拒、断网、超时）→ anon。断网时不清令牌，下次还能恢复。
// - 新开的标签页（sessionStorage 是空的）：经频道向已登录的标签页要令牌，ASK_TIMEOUT_MS 内拿到就照上面恢复，
//   没有标签页回应 → anon（登录页）。要令牌期间是 loading，路由守卫不跳转。
// - /me 的结果（用户、是否经销商、permission_paths）只放内存，不写浏览器存储，角色无法靠改存储伪造。
// - 过期前 60 秒主动续期（定时器；切回标签页、网络恢复时补查）；请求里的 401 / 403 token err 由 http.ts
//   续期重放。续期失败一律触发 onSessionExpired → 这里转为 anon，页面由路由守卫跳回登录页。
// - 跨标签页（sessionChannel.ts）：别的标签页续期 → 换上新令牌、重排定时器；别的标签页退出 → 本页也清令牌转为 anon；
//   别的标签页登录 → 已登录或恢复中的标签页换上新令牌（同一账号的 refresh_token 只有最新的有效），换了账号
//   （JWT 的 sub 变了）→ 回到 loading 重新取 /me，期间不渲染页面，避免「旧用户的身份 + 新用户的令牌」。
//   在登录页（anon）的标签页不因别处登录而自动登录。
import { can as matchPath, isDealer, logout, login, me, setCurrentUserId, type MeUser } from './auth'
import { ApiError } from './errors'
import { adoptRotation, onSessionExpired, refreshSession, REFRESH_LEEWAY_MS } from './http'
import { hasSessionChannel, onSessionMessage, postSession, type SessionMessage } from './sessionChannel'
import { clearTokens, isTokens, jwtSub, purgeLegacyTokens, readTokens, writeTokens, type Tokens } from './tokens'

/** 新开的标签页等别的标签页回应令牌的时间 */
export const ASK_TIMEOUT_MS = 300

export type SessionStatus = 'anon' | 'loading' | 'authed'

export interface SessionInfo {
  user: MeUser
  /** /me 的 user_entity.type === 1；0 或缺失为平台用户 */
  dealer: boolean
  permissionPaths: readonly string[]
}

export interface SessionState { status: SessionStatus; info: SessionInfo | null; reason?: ApiError }

let state: SessionState = { status: 'anon', info: null }
const subs = new Set<(s: SessionState) => void>()
/** 每次登录、恢复、退出都加一；过时的异步结果（比如恢复途中用户又点了登录）据此丢弃 */
let gen = 0
/** 当前会话的用户（access_token 的 sub），用来区分「别的标签页续期」和「别的标签页换了账号」 */
let lastSub: string | null = null

function set(next: SessionState) {
  state = next
  if (next.status !== 'authed') lastSub = null
  schedule()
  for (const fn of subs) fn(state)
}
function toAnon(reason?: ApiError) {
  ++gen
  setCurrentUserId('')
  set({ status: 'anon', info: null, reason })
}

export const getSession = () => state
export function subscribeSession(fn: (s: SessionState) => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** permission_paths 里有没有这条路由（/v1/... 模板匹配）。未登录一律 false。只影响显示，数据范围由后端保证 */
export function can(route: string): boolean {
  return state.status === 'authed' && !!state.info && matchPath(state.info.permissionPaths, route)
}

async function fetchMe(accessToken?: string): Promise<SessionInfo> {
  const r = await me({ accessToken, track: false })
  const user = r.user_entity
  if (!user?.id) throw new ApiError('server', '获取当前用户失败')
  return { user, dealer: isDealer(user), permissionPaths: Array.isArray(r.permission_paths) ? r.permission_paths : [] }
}

function accept(info: SessionInfo, accessToken: string) {
  setCurrentUserId(info.user.id)
  set({ status: 'authed', info })
  lastSub = jwtSub(accessToken)
}

/**
 * 登录并取 /me。失败时抛出 ApiError（文案可直接提示），登录态保持 anon。
 * 第三个参数是旧的「记住我」，已不起作用（令牌一律存 sessionStorage）；保留只为兼容现有调用
 */
export async function signIn(mobile: string, password: string, _legacyRemember?: boolean): Promise<SessionInfo> {
  const g = ++gen
  try {
    const t = await login(mobile, password, { store: false })
    if (g !== gen) throw new ApiError('aborted', '登录已取消')
    const info = await fetchMe(t.accessToken)
    // 登录途中退出了、或又发起了一次登录 / 恢复：本次结果作废（令牌还没写，不会覆盖别的会话）
    if (g !== gen) throw new ApiError('aborted', '登录已取消')
    writeTokens(t)
    accept(info, t.accessToken)
    // 同一账号只有最新的 refresh_token 有效：告诉别的已登录标签页换上这份，免得它们下次续期被拒
    postSession({ type: 'login', to: t })
    return info
  } catch (e) {
    if (g === gen) { setCurrentUserId(''); set({ status: 'anon', info: null }) }
    throw e
  }
}

/**
 * 用已存的令牌恢复登录态（刷新页面、新开标签页时，可以无条件调用）。本页没有令牌就先向别的标签页要，
 * 要不到 → anon
 */
export async function restoreSession(): Promise<SessionState> {
  let t = readTokens()
  if (!t && hasSessionChannel()) {
    const g = ++gen
    if (state.status !== 'loading') set({ status: 'loading', info: null })
    const asked = await askPeers()
    const got = asked && followRotations(asked)
    if (!asks.size) seenRotations.clear()
    // 等待期间登录、退出或又开始了一次恢复：这次作废
    if (g !== gen) return state
    t = readTokens()
    if (!t && got) { writeTokens(got); t = got }
  }
  // 没有令牌：总是通知一次（store 首屏可能自己先进了 loading，要让它看到 anon）
  if (!t) { if (state.status !== 'anon') toAnon(); else set({ status: 'anon', info: null }); return state }
  const g = ++gen
  if (state.status !== 'loading') set({ status: 'loading', info: null })
  try {
    const info = await fetchMe()
    if (g !== gen) return state
    const now = readTokens()
    if (!now) { toAnon(); return state }
    // 取 /me 期间存储里换成了别的账号：这份结果不是当前令牌的，重来
    if (jwtSub(now.accessToken) !== jwtSub(t.accessToken)) return restoreSession()
    accept(info, now.accessToken)
  } catch (e) {
    if (g === gen) { setCurrentUserId(''); set({ status: 'anon', info: null, reason: e instanceof ApiError ? e : undefined }) }
  }
  return state
}

/** 主动退出：先清本地登录态、通知所有标签页一起退出，再调 /auth/invalidate（见 auth.ts） */
export async function signOut() {
  const done = logout() // 同步部分先取出令牌和 user_id 并清掉本地
  toAnon()
  postSession({ type: 'logout' })
  await done
}

// ---------------------------------------------------------------------------
// 新开的标签页向已登录的标签页要令牌

const asks = new Map<string, (t: Tokens | null) => void>()
/**
 * 要令牌期间收到的续期广播（旧 refresh → 新令牌）。回应和续期广播可能来自不同的标签页、先后没有保证：
 * 先到的续期广播本页还没有令牌可换，记下来，拿到回应后沿着链换成最新的
 */
const seenRotations = new Map<string, Tokens>()
function followRotations(t: Tokens): Tokens {
  for (let i = 0; i < 20 && seenRotations.has(t.refreshToken); i++) t = seenRotations.get(t.refreshToken)!
  return t
}
const askId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

/** 广播 ask，取第一个回应；ASK_TIMEOUT_MS 内没有回应返回 null */
function askPeers(): Promise<Tokens | null> {
  const id = askId()
  return new Promise((resolve) => {
    const finish = (t: Tokens | null) => { clearTimeout(timer); asks.delete(id); resolve(t) }
    const timer = setTimeout(() => finish(null), ASK_TIMEOUT_MS)
    asks.set(id, finish)
    postSession({ type: 'ask', id })
  })
}

// ---------------------------------------------------------------------------
// 过期、多标签页、主动续期

let timer: ReturnType<typeof setTimeout> | null = null
function clearTimer() { if (timer) { clearTimeout(timer); timer = null } }

function schedule() {
  clearTimer()
  if (state.status !== 'authed') return
  const t = readTokens()
  // 已登录却没有令牌（被别处清掉了）：兜底转为未登录
  if (!t) { toAnon(); return }
  // 提前 60 秒再多留 5 秒，保证定时器触发时已进入 http.ts 的续期窗口
  const wait = Math.max(1000, t.expiresAt - Date.now() - REFRESH_LEEWAY_MS + 5000)
  timer = setTimeout(() => { timer = null; void renewIfDue() }, Math.min(wait, 2 ** 31 - 1))
}

/** 剩余时长进入续期窗口就续期，否则按剩余时长重排。定时器、切回标签页、网络恢复时调用 */
async function renewIfDue() {
  if (state.status !== 'authed') return
  const cur = readTokens()
  if (cur && cur.expiresAt - Date.now() > REFRESH_LEEWAY_MS) { schedule(); return }
  try { await refreshSession() } catch { /* 失败的过期处理在 http.ts（通知 → anon） */ }
  schedule()
}

/** 本页的令牌按别的标签页的消息换了（续期或登录） */
function onTokensChanged() {
  const t = readTokens()
  if (!t) { if (state.status !== 'anon') toAnon(); return }
  if (state.status === 'anon') return
  const sub = jwtSub(t.accessToken)
  // 同一用户续期：只重排定时器。换了账号（或判断不了）：回到 loading 重新取 /me；恢复途中也重来
  if (state.status === 'authed' && sub !== null && sub === lastSub) { schedule(); return }
  void restoreSession()
}

/** 别的标签页发来的消息 */
function onMessage(m: SessionMessage) {
  switch (m.type) {
    case 'rotated':
      // 登录页上的标签页（恢复失败时可能还留着令牌）不跟着续期；from 对上就是同一会话，只重排定时器
      if (asks.size && isTokens(m.to)) seenRotations.set(m.from, m.to)
      if (state.status === 'anon') return
      if (adoptRotation(m) && state.status === 'authed') schedule()
      return
    case 'ask': {
      // 只有已登录的标签页回应；恢复中、登录页上的不回应（手里的令牌还没确认有效）
      const t = readTokens()
      if (state.status === 'authed' && t) postSession({ type: 'give', id: m.id, tokens: t })
      return
    }
    case 'give':
      if (isTokens(m.tokens)) asks.get(m.id)?.(m.tokens)
      return
    case 'login':
      // 本页在登录页：不自动登录。已登录或恢复中：换上新令牌（同一账号旧的 refresh_token 已作废）
      if (state.status === 'anon' || !isTokens(m.to)) return
      writeTokens(m.to)
      onTokensChanged()
      return
    case 'logout':
      // 令牌一律清掉：登录页上的标签页也可能留着令牌（恢复时断网不清），不清的话刷新又能进去。
      // 已是 anon 时不 toAnon()，不打断本页正在进行的登录（signIn 确认之后才写令牌，清存储不影响它）
      clearTokens()
      if (state.status !== 'anon') toAnon()
      return
  }
}

let wired = false
/** 接上过期通知与跨标签页同步。应用启动时调一次（重复调用无副作用），返回撤销函数供测试使用 */
export function initSession(): () => void {
  if (wired) return () => {}
  wired = true
  purgeLegacyTokens()
  const offMessages = onSessionMessage(onMessage)
  // 已经是 anon 时不处理：没有令牌的零星请求也会发过期通知，不能因此作废正在进行的登录
  const offExpired = onSessionExpired((reason) => { if (state.status !== 'anon') toAnon(reason) })
  // 后台标签页的定时器会被浏览器推迟，休眠唤醒后也可能错过：切回前台、网络恢复时补查一次
  const onWake = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (state.status === 'authed') void renewIfDue()
  }
  const w = typeof window !== 'undefined' ? window : null
  const d = typeof document !== 'undefined' ? document : null
  w?.addEventListener('online', onWake)
  d?.addEventListener('visibilitychange', onWake)
  return () => {
    offExpired()
    offMessages()
    w?.removeEventListener('online', onWake)
    d?.removeEventListener('visibilitychange', onWake)
    clearTimer()
    wired = false
  }
}

/** 仅供测试：重置模块内状态 */
export function __resetSessionForTests() {
  clearTimer()
  gen = 0
  lastSub = null
  for (const finish of [...asks.values()]) finish(null)
  seenRotations.clear()
  state = { status: 'anon', info: null }
  subs.clear()
}
