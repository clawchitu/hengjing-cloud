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
//   ┌──────────┐ writeCtrl（S4 统一写入口）
//   │ sending  │── 确定失败（写防护、503、success=false 等）──┐
//   └────┬─────┘── 超时 / 断网 / 500 / 解析失败 / 期限到 ────┤（结果未知）
//        │ success=true                                       │
//        ▼                                                    ▼
//   ┌──────────┐ 写完成后取消在途 200 再新发一次 200 回读（写前启动的轮询结果不算）
//   │verifying │  会话已变化：不用新凭据回读 → 写已结束（成功 / 确定失败）则释放锁，结果未知则进入 unknown-locked
//   └────┬─────┘
//        │ 回读成功 → done（释放锁）
//        │ 回读失败 / 期限到 / 回调异常，且写可能已生效 → unknown-locked
//        ▼
//   ┌───────────────┐ 禁止该项目再次下发；页面显示「上次下发结果未知」和只读的「核对」按钮
//   │unknown-locked │── 核对（新发一次 200）读取成功 ──► 释放锁
//   └───────────────┘
//
// 总期限：preflight ≤ LIMITS.preflightMs；sending + verifying ≤ LIMITS.writeTotalMs。整个流程有 try/finally，任何异常都会落到
// 「释放锁（还没写）」或「unknown-locked（可能已写）」之一，不会留下悬空的锁。
// 展示隔离：结果按 sessionKey 存，toast 只在会话与当前项目都没变时弹；新会话看不到旧会话的结果，只看到项目被锁和「核对」。
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
  /** unknown-locked 时正在核对 */
  checking?: boolean
}

export const ALL = 'all'
export const LIMITS = { preflightMs: 15_000, writeTotalMs: 30_000 }

// ---------------------------------------------------------------------------
// 会话代次：账号变化（含变为未登录）就加一。真实接口订阅 api/session；演示数据模式在每次读取时比较

let sessionGen = 0
let lastUserKey: string | null | undefined
let unsubSession: (() => void) | null = null
function noteSession() {
  const k = getSessionView().userKey
  if (k !== lastUserKey) { lastUserKey = k; sessionGen += 1; emit() }
}
function watchSession() {
  if (!unsubSession) unsubSession = subscribeSession(() => noteSession())
}
export function currentSessionKey(): string {
  watchSession()
  noteSession()
  return `${lastUserKey ?? 'anon'}#${sessionGen}`
}

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

/** 完成时用户是否仍在原项目（存储里的当前项目；为空表示还没选过，按未切换处理） */
const stillCurrentProject = (projectId: string) => {
  const s = getStoredProjectId()
  return !s || s === projectId
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
/** 有界等待：到期 reject（并中止 signal 对应的读取）；原 Promise 不会被取消（写请求可能仍会完成，所以到期后按结果未知处理） */
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
  /** 写后回读：新发一次 200（不复用写前的请求）；失败 reject */
  verify: (signal: AbortSignal) => Promise<unknown>
  /** 发起的页面还在（没卸载）；预检期间变为 false 就中止 */
  present: () => boolean
  toast: (text: string, err?: boolean) => void
}

/** 执行一次下发（见文件头的状态图） */
export async function runOp<P>(o: OpSpec<P>): Promise<RunResult> {
  if (locks.has(o.projectId)) return 'busy'
  const op: Lock = { opId: ++seq, projectId: o.projectId, sessionKey: currentSessionKey(), target: o.target, subject: o.subject, phase: 'preflight' }
  locks.set(o.projectId, op)
  results.delete(rk(op.sessionKey, o.projectId, o.target))
  emit()
  const sameSession = () => currentSessionKey() === op.sessionKey
  const visible = () => sameSession() && stillCurrentProject(o.projectId)
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
    const left = !sameSession() || !stillCurrentProject(o.projectId) || !o.present()
    if (left) return 'aborted' // 离开、切项目、会话变化：不写，不向别处提示
    if (!pre.ok) { say(`${o.subject}：${pre.reason}，本次未下发，请重新核对后再下发`, true); return 'aborted' }

    // ---- sending（发送前同步再核对）
    if (!sameSession() || !stillCurrentProject(o.projectId) || !o.present()) return 'aborted'
    setPhase('sending')
    mayHaveWritten = true
    const deadlineAt = Date.now() + LIMITS.writeTotalMs
    let outcome: Outcome
    let text: string
    try {
      await within(o.send(pre.payload), deadlineAt - Date.now(), '等待控制屏应答')
      outcome = 'ok'
      text = o.okText
    } catch (e) {
      const c = e instanceof Deadline ? { outcome: 'unknown' as const, text: e.message, sent: true } : classify(e)
      outcome = c.outcome
      text = c.text
      if (!c.sent) mayHaveWritten = false
    }
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
    if (!sameSession()) {
      // 会话变了：不用新凭据回读。写已结束（成功 / 确定失败）则释放；结果未知则锁住待核对
      if (outcome === 'unknown') finalState = 'unknown-locked'
      return outcome
    }
    const vac = new AbortController()
    let read = false
    // 期限已用完就不再回读（直接按未知处理）
    if (deadlineAt - Date.now() > 0) {
      try {
        await within(o.verify(vac.signal), deadlineAt - Date.now(), '回读面板', vac)
        read = true
      } catch { read = false }
    }
    const cur = results.get(rk(op.sessionKey, o.projectId, o.target))
    if (cur) record({ ...cur, readback: read ? 'ok' : 'fail' })
    if (!read && outcome !== 'fail') finalState = 'unknown-locked'
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

/** unknown-locked 的核对：新发一次 200，读取成功才解锁。返回是否解锁 */
export async function checkLocked(projectId: string, read: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> {
  const l = locks.get(projectId)
  if (!l || l.phase !== 'unknown-locked' || l.checking) return false
  l.checking = true
  emit()
  const ac = new AbortController()
  try {
    await within(read(ac.signal), LIMITS.preflightMs, '核对读取', ac)
    if (locks.get(projectId)?.opId === l.opId) locks.delete(projectId)
    const r = results.get(rk(l.sessionKey, projectId, l.target))
    if (r && l.sessionKey === currentSessionKey()) results.set(rk(l.sessionKey, projectId, l.target), { ...r, readback: 'ok' })
    return true
  } catch {
    return false
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
function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }
const getVersion = () => version

/** 仅供测试：清空状态并重新订阅会话（__resetSessionForTests 会清掉订阅） */
export function __resetWritesForTests() {
  locks = new Map()
  results = new Map()
  unsubSession = null
  lastUserKey = undefined
  LIMITS.preflightMs = 15_000
  LIMITS.writeTotalMs = 30_000
  emit()
}
