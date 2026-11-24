// 温控面板的下发流程（201 单房间设置 / 开关、206 全部开关）。锁用 src/api/writeLock.ts 的共用写锁（按控制屏，三处共用；
// 结果未知的核对、有效期、刷新恢复、跨标签同步都在那里），这里只负责温控自己的流程与展示：
//
//   （用户已确认）
//        │ acquire(project)：同屏已被锁 → 'busy'
//        ▼
//   preflight  新发一次 200（hooks.ts 的 useFreshRooms：先取消在途 200，绑定会话），用新读数重新校验并组装，与确认时比对
//        │     读取失败 / 不一致 / 期间离开、切项目、会话变化 → release(token)，不写（'aborted'）
//        ▼     发送前最后一个同步点：会话、项目、页面仍在，并 claim(token)
//   sending    send() → 立刻 markSent(token, promise, 核对数据)；requireVerify 登记核对函数（新读 200 + 比对目标值）
//        │     到期（WRITE_DEADLINE_MS）还没应答 → markOverdue + 结果未知
//        ▼     settle(token, ok | fail | unknown)
//   verifying  成功 / 确定失败：写后新读一次 200 刷新界面（展示用）
//              结果未知：写锁在原写结算后自动核对（调用这里登记的核对函数，读数同时刷新界面），一致即解锁；
//              不一致 / 读取失败则保持，直到页面「核对」一致或写锁有效期到（到期发强制重读事件）
//
// 展示隔离：结果按 sessionKey（账号 + 会话代次）存，toast 只在会话与当前项目都没变时弹；新会话看不到旧会话的结果。
// #24（写入口的 beforeSend）合并后：claim 移到 requestWrite 的 beforeSend: () => … && claim(token)。
import { useSyncExternalStore } from 'react'
import { isApiError } from '@/api/errors'
import { subscribeSession } from '@/api/session'
import {
  acquire, claim, lockKeysOf, lockOf, lockVersion, markOverdue, markSent, release, requireVerify, settle, subscribe as subscribeLock,
  type LockInfo, type LockTarget, type SentRecord,
} from '@/api/writeLock'
import { getStoredProjectId } from '@/data/org/current'
import { getSessionView } from '@/data/session'

export type Stage = 'preflight' | 'sending' | 'verifying'
export type Outcome = 'ok' | 'fail' | 'unknown'
export type RunResult = Outcome | 'busy' | 'aborted'
/** 回读：等原写结束 / 读取中 / 已读到 / 读取失败 */
export type Readback = 'waiting' | 'pending' | 'ok' | 'fail'

export interface WriteResult {
  outcome: Outcome
  /** 失败原因、未知原因，或成功文案 */
  text: string
  readback: Readback
  /** 结果未知时，回读与下发值是否一致（一致即视为已生效，写锁已放开） */
  matched?: boolean
}

/** 本标签正在进行的一次下发（只用于界面阶段展示；互斥靠写锁） */
export interface Running { target: string; stage: Stage; sessionKey: string }

export const ALL = 'all'
/** 预检读取的最长时间 */
export const PREFLIGHT_MS = 15_000
/** 等写入口应答的最长时间（写 12 秒 + 续期 12 秒 + 重放 12 秒的最长链）；到期只决定界面标「结果未确认」，锁由写锁管 */
export const WRITE_DEADLINE_MS = 45_000
export const LIMITS = { preflightMs: PREFLIGHT_MS, writeDeadlineMs: WRITE_DEADLINE_MS }

// ---------------------------------------------------------------------------
// 会话代次（展示隔离用）：账号变化（含变为未登录）就加一。订阅回调里更新并通知；渲染期间读取只计算、不通知

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
export function currentSessionKey(): string {
  watchSession()
  syncSession()
  return `${lastUserKey ?? 'anon'}#${sessionGen}`
}

// 当前项目：存储里的选择 + 页面报告的实际解析结果（回退到第一个项目时不写存储）
let resolvedProject: string | undefined
export function noteCurrentProject(id: string) { resolvedProject = id }

// ---------------------------------------------------------------------------

let running = new Map<string, Running>()
let results = new Map<string, WriteResult>()
let version = 0
const subs = new Set<() => void>()
function emit() { version += 1; for (const fn of subs) fn() }
const rk = (sessionKey: string, projectId: string, target: string) => `${sessionKey}\n${projectId}\n${target}`

export const runningOf = (projectId: string) => running.get(projectId) ?? null
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
function within<T>(p: Promise<T>, ms: number, what: string, ac?: AbortController): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  const timer = new Promise<never>((_, reject) => { t = setTimeout(() => { ac?.abort(); reject(new Deadline(what)) }, Math.max(0, ms)) })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

export type Preflight<P> = { ok: true; payload: P } | { ok: false; reason: string }
export interface OpSpec<P, L> {
  /** 加锁目标（S6a 的 Project：按控制屏 → DTU → 项目 id 加锁） */
  project: LockTarget
  /** 房间键或 ALL */
  target: string
  /** 提示里的主语，如「客厅」「全部开启」 */
  subject: string
  okText: string
  /** 确认后的预检：新发一次 200，用这份读数重新校验并组装要下发的内容；不一致返回原因 */
  preflight: (signal: AbortSignal) => Promise<Preflight<P>>
  /** 真正下发（经统一写入口）；resolve 即 success=true */
  send: (payload: P) => Promise<void>
  /** 写锁持久化的核对数据（消息号、设备 id、目标字段与值） */
  record: (payload: P) => SentRecord
  /** 新发一次 200（不复用写前的请求；绑定会话），读到后界面同步刷新 */
  read: (signal: AbortSignal) => Promise<L>
  /** 读数与下发的目标值是否一致 */
  matches: (payload: P, read: L) => boolean
  /** 发起的页面还在（没卸载） */
  present: () => boolean
  toast: (text: string, err?: boolean) => void
}

/** 执行一次下发（见文件头） */
export async function runOp<P, L>(o: OpSpec<P, L>): Promise<RunResult> {
  const projectId = o.project.id
  const acq = acquire(o.project, o.subject)
  if (!acq.ok) return 'busy'
  const token = acq.token
  const run: Running = { target: o.target, stage: 'preflight', sessionKey: currentSessionKey() }
  running.set(projectId, run)
  results.delete(rk(run.sessionKey, projectId, o.target))
  emit()
  const selAtStart = getStoredProjectId()
  const sameSession = () => currentSessionKey() === run.sessionKey
  const sameProject = () => getStoredProjectId() === selAtStart && (resolvedProject === undefined || resolvedProject === projectId)
  const visible = () => sameSession() && sameProject()
  const say = (text: string, err?: boolean) => { if (visible()) { try { o.toast(text, err) } catch { /* 提示失败不影响流程 */ } } }
  const setStage = (s: Stage) => { run.stage = s; emit() }
  const key = rk(run.sessionKey, projectId, o.target)
  const record = (r: WriteResult) => { results.set(key, r); emit() }
  const patch = (p: Partial<WriteResult>) => { const cur = results.get(key); if (cur) record({ ...cur, ...p }) }
  let claimed = false

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

    // ---- 发送前最后一个同步点：复核并认领写锁
    // TODO(#24)：#24 合并后改为 requestWrite 的 beforeSend: () => … && claim(token)，由写入口在 fetch 前同步调用
    if (!sameSession() || !sameProject() || !o.present() || !claim(token)) return 'aborted'
    claimed = true
    const payload = pre.payload
    setStage('sending')
    let sent: Promise<void>
    try { sent = o.send(payload) } catch (e) { sent = Promise.reject(e) }
    markSent(token, sent, o.record(payload))
    // 结果未知时写锁用它核对：新读一次 200（界面同步刷新），一致即解锁。读数也记到本次结果里（只对本会话）
    requireVerify(token, async (signal) => {
      if (sameSession()) patch({ readback: 'pending' })
      try {
        const same = o.matches(payload, await o.read(signal))
        if (sameSession()) patch({ readback: 'ok', matched: same })
        return same
      } catch (e) {
        if (sameSession()) patch({ readback: 'fail' })
        throw e
      }
    })
    let outcome: Outcome
    let text: string
    let wrote = true
    try {
      await within(sent, LIMITS.writeDeadlineMs, '等待控制屏应答')
      outcome = 'ok'
      text = o.okText
    } catch (e) {
      if (e instanceof Deadline) { markOverdue(token); outcome = 'unknown'; text = e.message }
      else { const c = classify(e); outcome = c.outcome; text = c.text; wrote = c.sent }
    }
    // 成功：仍在原项目就提示，否则把结果留给原项目；失败 / 未知：提示（若仍可见）并记录
    if (outcome === 'ok') {
      if (visible()) say(text)
      else record({ outcome, text, readback: 'pending' })
    } else {
      say(outcome === 'unknown' ? `${o.subject} 下发结果未知：${text}` : `${o.subject} ${text}`, true)
      record({ outcome, text, readback: outcome === 'unknown' ? 'waiting' : 'pending' })
    }
    // 结论交给写锁（unknown 时它在原写结算后自动核对）
    settle(token, outcome)
    if (!wrote) { patch({ readback: 'ok' }); return outcome }
    if (outcome === 'unknown') return outcome

    // ---- verifying（成功 / 确定失败）：写后新读一次刷新界面
    setStage('verifying')
    if (!sameSession()) return outcome // 会话变了：不用新凭据回读
    const vac = new AbortController()
    let read = false
    try { await within(o.read(vac.signal), LIMITS.preflightMs, '回读面板', vac); read = true } catch { read = false }
    if (sameSession()) patch({ readback: read ? 'ok' : 'fail' })
    return outcome
  } catch {
    // 回调意外抛错：还没认领就放锁；已认领的由写锁按「发出后」的规则处理
    if (claimed) settle(token, 'unknown')
    return claimed ? 'unknown' : 'aborted'
  } finally {
    if (!claimed) release(token)
    if (running.get(projectId) === run) running.delete(projectId)
    emit()
  }
}

// ---------------------------------------------------------------------------

/** 订阅某个项目的下发状态：写锁（按该项目的控制屏查）、本标签进行中的阶段、本会话的结果 */
export function useWrites(project: LockTarget | null): { lock: LockInfo | null; running: Running | null; result: (target: string) => WriteResult | null } {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  useSyncExternalStore(subscribeLock, lockVersion, lockVersion)
  const id = project?.id ?? ''
  return { lock: project ? lockOf(project) : null, running: running.get(id) ?? null, result: (t) => getResult(id, t) }
}
function subscribe(fn: () => void) { watchSession(); subs.add(fn); return () => { subs.delete(fn) } }
const getVersion = () => version
/** 仅供测试 */
export const __versionForTests = () => version

/** 项目是否被锁住（同屏的其他项目在下发也算） */
export const isLocked = (project: LockTarget) => !!lockOf(project)
export { lockKeysOf }

/** 仅供测试：清空状态 */
export function __resetWritesForTests() {
  running = new Map()
  results = new Map()
  unsubSession = null
  lastUserKey = undefined
  resolvedProject = undefined
  LIMITS.preflightMs = PREFLIGHT_MS
  LIMITS.writeDeadlineMs = WRITE_DEADLINE_MS
  emit()
}
