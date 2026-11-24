// 温控面板的下发流程（201 单房间设置 / 开关、206 全部开关）。锁用 src/api/writeLock.ts 的共用写锁（按控制屏，三处共用；
// 结果未知的核对、有效期、刷新恢复、跨标签同步都在那里），这里只负责温控自己的流程与展示：
//
//   （用户已确认）
//        │ acquire(project)：同屏已被锁 → 'busy'
//        ▼
//   preflight  新发一次 200（hooks.ts 的 useFreshRead：先取消在途 200，绑定会话），用新读数重新校验并组装，与确认时比对
//        │     读取失败 / 不一致 / 期间离开、切项目、会话变化 → 不写，放锁（'aborted'）
//        │     核对数据发送前检查（写锁 checkSentRecord：206 必须带目标房间集合、不超上限）不过 → 不写，放锁并提示（'aborted'）
//        ▼
//   sending    send(payload, beforeSend) 经统一写入口（requestWrite 的 beforeSend 链末：会话、项目、页面仍在 && claim(token)）
//        │     → 拿到 Promise 立刻 markSent(token, promise, 核对数据)；requireVerify 登记核对函数（新读 200 + 逐字段比对）
//        │     到期（WRITE_DEADLINE_MS）还没应答 → markOverdue + 结果未知
//        ▼     settle(token, ok | fail | unknown)
//   verifying  success 只算「已下发」（docs/分工.md 第 4 节）：写锁在原写结算后自动核对（调用这里登记的核对函数，读数同时
//              刷新界面），等第一次核对的结论：全部一致 → 已生效（这时才提示成功、页面才丢草稿、写锁放开）；未变化 / 无法核对 /
//              结果未知 → 按四态展示（逐字段），锁到核对一致或有效期到期（写锁有效期内按 5、20、60 秒自动再核对）。
//              确定失败：写后新读一次刷新界面。结果未知：等写锁核对
//
// 展示隔离：结果按 sessionKey（写锁模块的账号 + 会话代次）存，toast 只在会话与当前项目都没变时弹；新会话看不到旧会话的结果。
import { useSyncExternalStore } from 'react'
import { isApiError } from '@/api/errors'
import {
  acquire, checkSentRecord, claim, currentAccount, lockKeysOf, lockOf, lockVersion, markOverdue, markSent, release, requireVerify, settle, subscribe as subscribeLock,
  type FieldResult, type LockInfo, type LockTarget, type MatchResult, type SentRecord,
} from '@/api/writeLock'
import { getStoredProjectId } from '@/data/org/current'
import { outcomeOf } from '@/features/unified/machine'

export type Stage = 'preflight' | 'sending' | 'verifying'
export type Outcome = 'ok' | 'fail' | 'unknown'
/** ok = 已生效（核对一致）；unverified = 已下发但还没核对一致（未变化 / 无法核对 / 结果未知） */
export type RunResult = Outcome | 'unverified' | 'busy' | 'aborted'
/** 回读：等原写结束 / 读取中 / 已读到 / 读取失败 */
export type Readback = 'waiting' | 'pending' | 'ok' | 'fail'

export interface WriteResult {
  /** 应答：ok = 已下发（success=true，仍待核对）/ fail = 确定没生效 / unknown = 结果未知 */
  outcome: Outcome
  /** 失败原因、未知原因，或成功文案 */
  text: string
  readback: Readback
  /** 回读核对的整体结论（四态）与逐字段结论；还没核对完时没有 */
  verdict?: FieldResult
  fields?: Record<string, FieldResult>
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
// 会话代次（展示隔离用）：直接用写锁模块的账号与会话代次（登录、恢复、同号重登、退出换代；令牌续期不换代），
// 与 claim 的判断同一套，不再自己维护一份。换代时写锁会通知订阅者（useWrites 订阅了写锁），界面随之重算

export function currentSessionKey(): string {
  const a = currentAccount()
  return `${a.user ?? 'anon'}#${a.gen}`
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
 * 下发失败的分类：复用统一控制的 outcomeOf（src/features/unified/machine.ts，与 #24 写入口同一口径），只有确定的才算「失败」：
 * - 未下发（not-sent）：写防护拦截、写消息校验不过、未登录（401，网关在转发前就拒了）、控制屏未连接（只认 503 且 gRPC code 14）；
 * - 明确被拒（rejected）：控制屏回复 success=false、网关无权限、后端参数错误。
 * 其余一律「结果未知」：超时、断网、500、回复无法解析、中止、期限到，以及不带 code 14 的 503（网关纯文本 503 等，请求可能已到
 * 后端）——这时锁保持，由写锁核对或到期。sent = 请求可能到过后端（确定失败后据此决定要不要回读刷新界面）
 */
export function classify(e: unknown): { outcome: 'fail' | 'unknown'; text: string; sent: boolean } {
  const err = isApiError(e) ? e : null
  const msg = err?.message || (e instanceof Error ? e.message : '') || '未知错误'
  const o = outcomeOf(e)
  if (o === 'not-sent') return { outcome: 'fail', text: `未下发：${msg}`, sent: false }
  if (o === 'rejected') return { outcome: 'fail', text: `下发失败：${msg}`, sent: true }
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
  /**
   * 真正下发（经统一写入口）；resolve 即 success=true（只算已下发）。beforeSend 必须交给 requestWrite 的 beforeSend，
   * 由写入口在 fetch 前同步调用（返回 false 就不发）
   */
  send: (payload: P, beforeSend: () => boolean) => Promise<void>
  /** 写锁持久化的核对数据（消息号、设备 id、目标字段与值） */
  record: (payload: P) => SentRecord
  /** 新发一次 200（不复用写前的请求；绑定会话），读到后界面同步刷新 */
  read: (signal: AbortSignal) => Promise<L>
  /** 读数与下发目标逐字段比对（writeLockVerify.ts 的四态结论） */
  matches: (payload: P, read: L) => MatchResult
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
  const clearKey = () => { if (results.delete(key)) emit() }
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

    // ---- sending：发送前复核放在写入口的 beforeSend 链末（令牌就绪后、fetch 前同步执行），claim 在最后
    const beforeSend = () => {
      const ok = sameSession() && sameProject() && o.present() && claim(token)
      if (ok) claimed = true
      return ok
    }
    const payload = pre.payload
    // 核对数据发送前先查（206 必须带非空、不超上限的目标房间集合等）：不合规就不发，放锁并提示原因
    const sentRecord = o.record(payload)
    const bad = checkSentRecord(sentRecord)
    if (bad) { say(`${o.subject}：${bad}`, true); return 'aborted' }
    setStage('sending')
    let sent: Promise<void>
    try { sent = o.send(payload, beforeSend) } catch (e) { sent = Promise.reject(e) }
    markSent(token, sent, sentRecord)
    // 写锁用它核对：新读一次 200（界面同步刷新），逐字段比对；全部一致写锁才放开。结论记到本次结果里（只对本会话）
    let firstCheck: (v: FieldResult | null) => void = () => {}
    const checked = new Promise<FieldResult | null>((r) => { firstCheck = r })
    requireVerify(token, async (signal) => {
      if (sameSession()) patch({ readback: 'pending' })
      try {
        const r = o.matches(payload, await o.read(signal))
        const det = typeof r === 'object' && r ? r : { verdict: (r === true ? 'applied' : r === 'unverifiable' ? 'unverifiable' : 'unchanged') as FieldResult, fields: {} }
        if (sameSession()) {
          const was = results.get(key)?.verdict
          patch({ readback: 'ok', verdict: det.verdict, fields: det.fields })
          // 后来的自动再核对才一致：补一次成功提示（仍在原项目时提示即可，结果条清掉；不在时把成功留给原项目）
          if (det.verdict === 'applied' && was && was !== 'applied') {
            if (visible()) { say(o.okText); clearKey() } else patch({ text: o.okText })
          }
        }
        firstCheck(det.verdict)
        return r
      } catch (e) {
        if (sameSession()) patch({ readback: 'fail', verdict: 'unknown', fields: undefined })
        firstCheck('unknown')
        throw e
      }
    })
    let outcome: Outcome
    let text: string
    let wrote = true
    try {
      await within(sent, LIMITS.writeDeadlineMs, '等待控制屏应答')
      outcome = 'ok'
      text = '已下发，正在核对…'
    } catch (e) {
      if (e instanceof Deadline) { markOverdue(token); outcome = 'unknown'; text = e.message }
      else { const c = classify(e); outcome = c.outcome; text = c.text; wrote = c.sent && claimed }
    }
    if (outcome !== 'ok') say(outcome === 'unknown' ? `${o.subject} 下发结果未知：${text}` : `${o.subject} ${text}`, true)
    record({ outcome, text, readback: outcome === 'unknown' ? 'waiting' : 'pending' })
    // 结论交给写锁：ok / unknown 进入待核对（原写已结算时立刻自动核对一次），fail 放锁
    settle(token, outcome)
    if (!wrote) { patch({ readback: 'ok' }); return outcome }
    if (outcome === 'unknown') return outcome

    setStage('verifying')
    if (!sameSession()) return outcome // 会话变了：不用新凭据回读
    if (outcome === 'fail') {
      // 确定失败：写后新读一次刷新界面
      const vac = new AbortController()
      let read = false
      try { await within(o.read(vac.signal), LIMITS.preflightMs, '回读面板', vac); read = true } catch { read = false }
      if (sameSession()) patch({ readback: read ? 'ok' : 'fail' })
      return outcome
    }
    // 已下发：等写锁的第一次核对结论（核对超时由写锁兜底，这里多等一点）
    const verdict = await within(checked, LIMITS.preflightMs + 5_000, '核对').catch(() => null)
    if (verdict === 'applied') {
      if (visible()) { say(o.okText); clearKey() } else patch({ text: o.okText })
      return 'ok'
    }
    return 'unverified'
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
function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }
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
  resolvedProject = undefined
  LIMITS.preflightMs = PREFLIGHT_MS
  LIMITS.writeDeadlineMs = WRITE_DEADLINE_MS
  emit()
}
