// 温控面板的下发状态机（模块级，页面卸载后仍存活）。201（单房间设置 / 开关）与 206（全部开关）都走这里。
//
// 每个操作带 { projectId, sessionKey, opId }。sessionKey = 账号（userKey）+ 会话代次：退出、换账号、同账号重新登录都会换代。
// 同一项目同一时间只有一个操作持有项目锁（preflight / sending / verifying / unknown-locked 四个阶段都算持锁）。
//
//   （用户已确认）
//        │ 项目已被锁 → 'busy'，什么都不做
//        ▼
//   ┌──────────┐ 新发一次 200（先取消该项目在途的 200，不复用缓存），用这份读数重新校验并组装，与确认时的 Query 比对
//   │preflight │── 读取失败 / 不一致 / 期间离开页面、切项目、会话变化 / 超时 ──► 释放锁，不写（'aborted'，提示重新核对）
//   └────┬─────┘
//        │ 发送前同步再核对会话代次、当前项目、页面仍在
//        ▼
//   ┌──────────┐ writeCtrl（S4 统一写入口）。原 send Promise 的结算单独跟踪（sendPending）
//   │ sending  │── 确定失败（写防护、503、success=false 等）──┐
//   └────┬─────┘── 超时 / 断网 / 500 / 解析失败 / 总期限到 ──┤（结果未知）
//        │ success=true                                       │
//        ▼                                                    ▼
//   ┌──────────┐ 写完成后取消在途 200 再新发一次 200 回读（写前启动的轮询结果不算）
//   │verifying │  会话已变化：不用新凭据回读 → 写已结束（成功 / 确定失败）则释放锁，结果未知则进入 unknown-locked
//   └────┬─────┘
//        │ 回读成功 → done（释放锁）
//        │ 回读失败 / 期限到 / 回调异常，且写可能已生效 → unknown-locked
//        ▼
//   ┌───────────────┐ 禁止该项目再次下发；页面显示「上次下发结果未知」（成功但回读失败时为「已成功、状态未核对」）和「核对」
//   │unknown-locked │── 核对：新发一次 200 读取成功，且原 send 已结算 ──► 释放锁
//   └───────────────┘   原 send 未结算（sending-pending）：核对可以读、可以展示读数，但不解锁，提示「上一条指令尚未结束」；
//                       读取途中会话变化：结果丢弃，不解锁；核对失败：保留锁，可再次核对
//
// 原 send 一定会结算：http.ts 的 send() 对每次 fetch 设 AbortController，到 ctrlTimeoutMs（默认 12 秒）就 abort 底层请求，
// 401 续期与重放各自也有同样的超时；最长链约 12（写）+ 12（续期）+ 12（重放）秒，所以写 + 回读总期限取 45 秒
// （LIMITS.writeTotalMs）。总期限只是兜底：到期按结果未知锁住，原 send 结算前不允许解锁。
//
// 已知限制（v1 不做）：锁只在本标签页内存里，刷新或另开标签页后没有。理由：201 / 206 都是设置绝对值（温度 = X、
// 开关 = 0 / 1），重复下发幂等；刷新后页面重新读 200 展示真实状态；跨标签页的原子互斥需要额外基础设施，超出 v1 范围。
//
// 预检、回读、核对的读取都绑定发起时的会话代次与 AbortSignal：返回后写缓存或改锁之前再校验，失效就丢弃（见 hooks.ts 的
// useFreshRooms）。展示隔离：结果按 sessionKey 存，toast 只在会话与当前项目都没变时弹；新会话看不到旧会话的结果，
// 只看到项目被锁和「核对」。
import { useSyncExternalStore } from 'react'
import { isApiError } from '@/api/errors'
import { subscribeSession } from '@/api/session'
import { getStoredProjectId } from '@/data/org/current'
import { getSessionView } from '@/data/session'

export type Phase = 'preflight' | 'sending' | 'verifying' | 'unknown-locked'
export type Outcome = 'ok' | 'fail' | 'unknown'
export type RunResult = Outcome | 'busy' | 'aborted'
/** 回读核对：进行中 / 已读到 / 读取失败 */
export type Readback = 'pending' | 'ok' | 'fail'
/** 核对的结果：已解锁 / 读到了但原指令还没结束 / 读取失败 / 读取途中会话变化（丢弃） / 没有可核对的锁 */
export type CheckResult = 'unlocked' | 'send-pending' | 'failed' | 'stale' | 'none'

export interface WriteResult {
  outcome: Outcome
  /** 失败原因、未知原因，或成功文案 */
  text: string
  readback: Readback
}

export interface Lock {
  opId: number
  projectId: string
  sessionKey: string
  target: string
  subject: string
  phase: Phase
  /** 写的结果（sending 之后才有） */
  outcome?: Outcome
  /** 原 send Promise 还没结算（请求可能仍在路上） */
  sendPending: boolean
  /** unknown-locked 时正在核对 */
  checking?: boolean
}

export const ALL = 'all'
const DEFAULT_LIMITS = { preflightMs: 15_000, writeTotalMs: 45_000 }
export const LIMITS = { ...DEFAULT_LIMITS }

// ---------------------------------------------------------------------------
// 会话代次：账号变化（含变为未登录）就加一。订阅回调里更新并通知；渲染期间读取只计算、不通知

let sessionGen = 0
let lastUserKey: string | null | undefined
let unsubSession: (() => void) | null = null
function syncSession(): boolean {
  const k = getSessionView().userKey
  if (k === lastUserKey) return false
  lastUserKey = k
  sessionGen += 1
  return true
}
function watchSession() {
  if (!unsubSession) unsubSession = subscribeSession(() => { if (syncSession()) emit() })
}
/** 当前会话标识（只读：不触发订阅者更新，可在渲染期间调用） */
export function currentSessionKey(): string {
  watchSession()
  syncSession()
  return `${lastUserKey ?? 'anon'}#${sessionGen}`
}

// ---------------------------------------------------------------------------
// 当前项目：存储里的选择（切换项目会写入）+ 页面报告的实际解析结果（回退到第一个项目时不写存储）

let resolvedProject: string | undefined
/** 温控页每次渲染报告实际的当前项目 */
export function noteCurrentProject(id: string) { resolvedProject = id }

// ---------------------------------------------------------------------------
// 状态

let seq = 0
let locks = new Map<string, Lock>()
let results = new Map<string, WriteResult>()
let version = 0
const subs = new Set<() => void>()
function emit() { version += 1; for (const fn of subs) fn() }
const rk = (sessionKey: string, projectId: string, target: string) => `${sessionKey}\n${projectId}\n${target}`

export const lockOf = (projectId: string): Lock | null => locks.get(projectId) ?? null
/** 当前会话能看到的结果 */
export const getResult = (projectId: string, target: string) => results.get(rk(currentSessionKey(), projectId, target)) ?? null
export function clearResult(projectId: string, target: string) {
  if (results.delete(rk(currentSessionKey(), projectId, target))) emit()
}

/**
 * 下发失败的分类。确定没有生效的才算「失败」：写防护、参数错误、未登录 / 无权限、控制屏未连接（503，消息没发出去）、
 * 控制屏明确回复 success=false。其余（超时、断网、500、回复无法解析、中止、期限到）指令都可能已到控制屏，一律「结果未知」
 */
const DEFINITE_FAIL = new Set(['write_blocked', 'bad_request', 'unauthenticated', 'forbidden', 'unavailable', 'ctrl'])
export function classify(e: unknown): { outcome: 'fail' | 'unknown'; text: string; sent: boolean } {
  const err = isApiError(e) ? e : null
  const msg = err?.message || (e instanceof Error ? e.message : '') || '未知错误'
  if (err && DEFINITE_FAIL.has(err.kind)) return { outcome: 'fail', text: err.kind === 'write_blocked' ? `未下发：${msg}` : `下发失败：${msg}`, sent: err.kind !== 'write_blocked' }
  return { outcome: 'unknown', text: msg, sent: true }
}

class Deadline extends Error { constructor(what: string) { super(`${what}超时`) } }
/** 有界等待：到期 reject（并中止 signal 对应的读取）；原 Promise 不会被取消 */
function within<T>(p: Promise<T>, ms: number, what: string, ac?: AbortController): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  const timer = new Promise<never>((_, reject) => { t = setTimeout(() => { ac?.abort(); reject(new Deadline(what)) }, Math.max(0, ms)) })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

export type Preflight<P> = { ok: true; payload: P } | { ok: false; reason: string }
export interface OpSpec<P> {
  projectId: string
  /** 房间键或 ALL */
  target: string
  /** 提示里的主语，如「客厅」「全部开启」 */
  subject: string
  okText: string
  /** 确认后的预检：新发一次 200，用这份读数重新校验并组装要下发的内容；不一致返回原因 */
  preflight: (signal: AbortSignal) => Promise<Preflight<P>>
  /** 真正下发（经统一写入口）；resolve 即 success=true */
  send: (payload: P) => Promise<void>
  /** 写后回读：新发一次 200（不复用写前的请求）；失败或会话已变化时 reject */
  verify: (signal: AbortSignal) => Promise<unknown>
  /** 发起的页面还在（没卸载）；预检期间为 false 就中止 */
  present: () => boolean
  toast: (text: string, err?: boolean) => void
}

/** 执行一次下发（见文件头的状态图） */
export async function runOp<P>(o: OpSpec<P>): Promise<RunResult> {
  if (locks.has(o.projectId)) return 'busy'
  const selAtStart = getStoredProjectId()
  const op: Lock = { opId: ++seq, projectId: o.projectId, sessionKey: currentSessionKey(), target: o.target, subject: o.subject, phase: 'preflight', sendPending: false }
  locks.set(o.projectId, op)
  results.delete(rk(op.sessionKey, o.projectId, o.target))
  emit()
  const sameSession = () => currentSessionKey() === op.sessionKey
  const sameProject = () => getStoredProjectId() === selAtStart && (resolvedProject === undefined || resolvedProject === o.projectId)
  const visible = () => sameSession() && sameProject()
  const say = (text: string, err?: boolean) => { if (visible()) { try { o.toast(text, err) } catch { /* 提示失败不影响状态机 */ } } }
  const setPhase = (ph: Phase) => { op.phase = ph; emit() }
  const record = (r: WriteResult) => { results.set(rk(op.sessionKey, o.projectId, o.target), r); emit() }
  const release = () => { if (locks.get(o.projectId)?.opId === op.opId) { locks.delete(o.projectId); emit() } }

  let mayHaveWritten = false
  let finalState: 'released' | 'unknown-locked' = 'released'
  try {
    // ---- preflight
    const pac = new AbortController()
    let pre: Preflight<P>
    try {
      pre = await within(o.preflight(pac.signal), LIMITS.preflightMs, '确认后重新读取面板', pac)
    } catch (e) {
      pre = { ok: false, reason: `确认后重新读取面板失败（${e instanceof Error ? e.message : '未知错误'}）` }
    }
    if (!sameSession() || !sameProject() || !o.present()) return 'aborted' // 离开、切项目、会话变化：不写，不向别处提示
    if (!pre.ok) { say(`${o.subject}：${pre.reason}，本次未下发，请重新核对后再下发`, true); return 'aborted' }

    // ---- sending（发送前同步再核对）
    if (!sameSession() || !sameProject() || !o.present()) return 'aborted'
    setPhase('sending')
    mayHaveWritten = true
    const deadlineAt = Date.now() + LIMITS.writeTotalMs
    let outcome: Outcome
    let text: string
    // 原 send 的结算单独跟踪：期限到了它也可能还在路上
    op.sendPending = true
    const sent = o.send(pre.payload)
    sent.then(() => {}, () => {}).finally(() => { op.sendPending = false; emit() })
    try {
      await within(sent, deadlineAt - Date.now(), '等待控制屏应答')
      outcome = 'ok'
      text = o.okText
    } catch (e) {
      const c = e instanceof Deadline ? { outcome: 'unknown' as const, text: e.message, sent: true } : classify(e)
      outcome = c.outcome
      text = c.text
      if (!c.sent) mayHaveWritten = false
    }
    op.outcome = outcome
    // 成功：仍在原项目就提示，否则把结果留给原项目；失败 / 未知：提示（若仍可见）并记录
    if (outcome === 'ok') {
      if (visible()) say(text)
      else record({ outcome, text, readback: 'pending' })
    } else {
      say(outcome === 'unknown' ? `${o.subject} 下发结果未知：${text}` : `${o.subject} ${text}`, true)
      record({ outcome, text, readback: 'pending' })
    }
    // 写防护拦截等「没发出去」的：不需要回读
    if (!mayHaveWritten) { record({ outcome, text, readback: 'ok' }); return outcome }

    // ---- verifying
    setPhase('verifying')
    // 会话变了：不用新凭据回读。写已结束（成功 / 确定失败）则释放；结果未知则锁住待核对
    const sessionGone = () => { if (outcome === 'unknown') finalState = 'unknown-locked'; return outcome }
    if (!sameSession()) return sessionGone()
    const vac = new AbortController()
    let read = false
    if (deadlineAt - Date.now() > 0) { // 期限已用完就不再回读（直接按未知处理）
      try {
        await within(o.verify(vac.signal), deadlineAt - Date.now(), '回读面板', vac)
        read = true
      } catch { read = false }
    }
    if (!sameSession()) return sessionGone() // 回读途中会话变化：读数丢弃
    const cur = results.get(rk(op.sessionKey, o.projectId, o.target))
    if (cur) record({ ...cur, readback: read ? 'ok' : 'fail' })
    if (!read && outcome !== 'fail') finalState = 'unknown-locked'
    if (op.sendPending) finalState = 'unknown-locked' // 原 send 还没结算：无论如何不解锁
    return outcome
  } catch {
    // 回调意外抛错：还没写就释放；可能已写就锁住
    if (mayHaveWritten) finalState = 'unknown-locked'
    return mayHaveWritten ? 'unknown' : 'aborted'
  } finally {
    if (finalState === 'unknown-locked' && locks.get(o.projectId)?.opId === op.opId) setPhase('unknown-locked')
    else release()
  }
}

/**
 * unknown-locked 的核对：新发一次 200。读取成功、会话没变、且原 send 已结算才解锁；原 send 未结算时只读不解锁。
 * read 应绑定 signal 与发起时的会话（会话变化时 reject）
 */
export async function checkLocked(projectId: string, read: (signal: AbortSignal) => Promise<unknown>): Promise<CheckResult> {
  const l = locks.get(projectId)
  if (!l || l.phase !== 'unknown-locked' || l.checking) return 'none'
  const key = currentSessionKey()
  l.checking = true
  emit()
  const ac = new AbortController()
  try {
    try {
      await within(read(ac.signal), LIMITS.preflightMs, '核对读取', ac)
    } catch {
      return currentSessionKey() !== key ? 'stale' : 'failed'
    }
    if (currentSessionKey() !== key) return 'stale'
    if (l.sendPending) return 'send-pending'
    if (locks.get(projectId)?.opId === l.opId) locks.delete(projectId)
    const r = results.get(rk(l.sessionKey, projectId, l.target))
    if (r && l.sessionKey === key) results.set(rk(l.sessionKey, projectId, l.target), { ...r, readback: 'ok' })
    return 'unlocked'
  } finally {
    l.checking = false
    emit()
  }
}

// ---------------------------------------------------------------------------

/** 订阅某个项目的下发状态 */
export function useWrites(projectId: string): { lock: Lock | null; mine: boolean; result: (target: string) => WriteResult | null } {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  const lock = lockOf(projectId)
  return { lock, mine: !!lock && lock.sessionKey === currentSessionKey(), result: (t) => getResult(projectId, t) }
}
function subscribe(fn: () => void) { watchSession(); subs.add(fn); return () => { subs.delete(fn) } }
const getVersion = () => version
/** 仅供测试 */
export const __versionForTests = () => version

/** 仅供测试：清空状态并重新订阅会话（__resetSessionForTests 会清掉订阅） */
export function __resetWritesForTests() {
  locks = new Map()
  results = new Map()
  unsubSession = null
  lastUserKey = undefined
  resolvedProject = undefined
  Object.assign(LIMITS, DEFAULT_LIMITS)
  emit()
}
