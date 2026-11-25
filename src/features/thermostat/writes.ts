// 温控面板的下发流程（201 单房间设置 / 开关、206 全部开关）。锁用 src/api/writeLock.ts 的共用写锁（按控制屏，三处共用；
// 结果未知的核对、有效期、刷新恢复、跨标签同步都在那里），这里只负责温控自己的流程与展示：
//
//   （用户已确认）
//        │ acquire(project)：同屏已被锁 → 'busy'
//        ▼
//   screen     现查一次 ctrl 205（src/api/screenPreflight.ts，单独 5 秒超时，不缓存）：503 / 超时 / 失败 →
//        │     「控制屏未连接，暂不能下发」，不发写请求、放锁，结果条给「重试」（'not-sent'）；205 只提前拦截，四态判法不变
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
  type FieldResult, type LockInfo, type LockTarget, type MatchDetail, type MatchResult, type SentRecord,
} from '@/api/writeLock'
import { getStoredProjectId } from '@/data/org/current'
import { preflightScreen, SCREEN_OFFLINE_TEXT, withNoReplyNote, type ScreenState } from '@/api/screenPreflight'
import { verdictOf } from '@/api/writeLockVerify'
import { outcomeOf } from '@/features/unified/machine'

export type Stage = 'preflight' | 'sending' | 'verifying'
export type Outcome = 'ok' | 'fail' | 'unknown'
/**
 * ok = 已生效（核对一致）；unverified = 已下发但还没核对一致（未变化 / 无法核对 / 结果未知）；
 * fail = 已发出、被明确拒绝（success=false、网关无权限、后端参数错误）；
 * not-sent = 确定没发出（写防护拦截、503 code 14、401、认领前出错如续期断网）——页面据此保留草稿（重新下发时恢复原待确认）
 */
export type RunResult = Outcome | 'not-sent' | 'unverified' | 'busy' | 'aborted'
/** 回读：等原写结束 / 读取中 / 已读到 / 读取失败 */
export type Readback = 'waiting' | 'pending' | 'ok' | 'fail'

export interface WriteResult {
  /** 应答：ok = 已下发（success=true，仍待核对）/ fail = 确定没生效 / unknown = 结果未知 */
  outcome: Outcome
  /** 失败原因、未知原因，或成功文案 */
  text: string
  readback: Readback
  /** 回读核对的整体结论（四态）与逐字段结论（只记写锁认可的核对）；还没核对完时没有 */
  verdict?: FieldResult
  fields?: Record<string, FieldResult>
  /** 写锁没等到有效的一致核对就放开了（有效期到期等）：已恢复下发，结果仍未确认 */
  ended?: 'expired'
  /** 写锁还在自动核对（LockInfo.settling）：界面只显示「正在核对…」，verdict / fields 留着，退避用完或到期后才显示 */
  settling?: boolean
  /** 控制屏实时预检（205）没通过、未下发：结果条给「重试」，值是页面传的 OpSpec.retry（页面据此重新发起同一操作） */
  retry?: string
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
  e = withNoReplyNote(e) // 网关纯文本 504：说明里补「控制屏 10 秒内没有应答，可能离线」（分类不变）
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
  /** 预检、回读提示里读的对象，默认「面板」（S9 不传，文案不变）；S10 传「新风设置」 */
  noun?: string
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
  /**
   * 写锁核对用的读取（可选）：只返回候选读数，apply 写缓存。写锁认可这次核对（一致时调了 commit，或不一致结论记进了锁的
   * lastFields）之后才调 apply；不给时用 read（读到即写缓存）
   */
  readCandidate?: (signal: AbortSignal) => Promise<{ data: L; apply: () => void; latest?: () => boolean }>
  /** 读数与下发目标逐字段比对（writeLockVerify.ts 的四态结论） */
  matches: (payload: P, read: L) => MatchResult
  /** 写锁认可了一次全部一致的核对（之后的自动再核对一致也会调）：页面据此清草稿 */
  onApplied?: () => void
  /** 发起的页面还在（没卸载） */
  present: () => boolean
  /** 205 预检没通过时结果条「重试」带回给页面的标记（页面据此重新发起同一操作，如 'set' / 'on' / 'off'），默认 'retry' */
  retry?: string
  /** 控制屏实时预检，默认现查 ctrl 205（screenPreflight.ts）；测试注入 */
  screen?: (projectId: string, signal: AbortSignal) => Promise<ScreenState>
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
    // ---- 控制屏实时预检（205，每次现查）：没通过 → 不发写请求；锁在 finally 里放（还没认领）
    const sac = new AbortController()
    let screen: ScreenState
    try { screen = await (o.screen ?? preflightScreen)(projectId, sac.signal) } catch { screen = 'offline' }
    if (!sameSession() || !sameProject() || !o.present()) return 'aborted'
    if (screen !== 'online') {
      say(`${o.subject}：${SCREEN_OFFLINE_TEXT}`, true)
      record({ outcome: 'fail', text: `未下发：${SCREEN_OFFLINE_TEXT}`, readback: 'ok', retry: o.retry ?? 'retry' })
      return 'not-sent'
    }

    // ---- preflight
    const pac = new AbortController()
    let pre: Preflight<P>
    try {
      pre = await within(o.preflight(pac.signal), LIMITS.preflightMs, `确认后重新读取${o.noun ?? '面板'}`, pac)
    } catch (e) {
      pre = { ok: false, reason: `确认后重新读取${o.noun ?? '面板'}失败（${e instanceof Error ? e.message : '未知错误'}）` }
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
    // 写锁用它核对：新读一次 200（界面同步刷新），逐字段比对；全部一致写锁才放开。
    // 页面状态（结果条、成功提示、清草稿）只跟写锁「认可」的核对走（#33 的候选提交）：核对函数本身不改页面——
    //   一致 → 返回 { same: true, commit }，写锁确认这次核对仍有效（没过期、没超时、没换号、锁还在）才调 commit，
    //          这时才提示成功、更新结果、通知页面清草稿；
    //   其余 → 返回逐字段结论（MatchDetail），写锁认可后才记到锁的 lastVerify / lastFields，这里订阅写锁再同步给页面。
    //   锁没等到有效的一致就放开（到期、别的标签页删除记录）：结果标为「已到期」，草稿不动（由页面单独维护）
    let firstCheck: (v: FieldResult | null) => void = () => {}
    const checked = new Promise<FieldResult | null>((r) => { firstCheck = r })
    let lastThrew = false
    let applied = false
    let failed = false
    // 「正在核对…」只是进度，不是结论：开始时标 pending，这次核对没被写锁认可（中止等）就恢复原来的显示
    let before: Readback | null = null
    // 这次核对读到的候选读数：写锁认可后才写进查询缓存（每次核对开始时清掉，只对应最近一次核对）
    let candidate: (() => void) | null = null
    let inv = 0
    const applyCandidate = () => { const c = candidate; candidate = null; try { c?.() } catch { /* 写缓存失败不影响锁 */ } }
    requireVerify(token, async (signal) => {
      lastThrew = true // 没读完（超时、中止、出错）都按回读失败
      candidate = null
      const my = ++inv
      if (sameSession()) { const cur = results.get(key); if (cur && before === null) before = cur.readback; patch({ readback: 'pending' }) }
      const got: { data: L; apply: () => void; latest?: () => boolean } = o.readCandidate ? await o.readCandidate(signal) : { data: await o.read(signal), apply: () => {} }
      // 超时后迟到返回的旧核对（已有新一次核对开始）不留候选
      if (my === inv) candidate = got.apply
      const r = o.matches(payload, got.data)
      lastThrew = false
      const det: MatchDetail = typeof r === 'object' && r ? r : { verdict: (r === true ? 'applied' : r === 'unverifiable' ? 'unverifiable' : 'unchanged') as FieldResult, fields: {} }
      if (det.verdict !== 'applied') return r === false || r === 'unverifiable' ? r : det
      // 读到一致，但这次读取之后该项目已有更新的读数（在途或已写入）：这份一致可能已过时，不算已生效——按未变化处理、
      // 不写缓存，交给写锁的退避再核对（新读）
      if (got.latest && !got.latest()) {
        candidate = null
        const fields = Object.fromEntries(Object.keys(det.fields).map((k) => [k, 'unchanged' as const]))
        return { verdict: 'unchanged', fields: Object.keys(fields).length ? fields : { switch: 'unchanged' } } satisfies MatchDetail
      }
      return {
        same: true,
        commit: () => {
          // 定序点（Fable 裁定的收口规则）：放锁与「这次读数仍是最新」在同一同步帧里判断；已被更新的读取取代 → 否决放锁
          if (got.latest && !got.latest()) { candidate = null; return false }
          applied = true
          before = null
          applyCandidate()
          if (sameSession()) {
            const cur = results.get(key)
            // 已下发（success）的这次，或之前核对过不一致、后来才一致：提示成功（在原项目时清结果条，不在时把成功留给原项目）；
            // 结果未知后第一次核对就一致：结果记为一致（与之前相同，不另弹提示）
            if (cur?.outcome === 'ok' || (cur?.verdict && cur.verdict !== 'applied')) {
              if (visible()) { say(o.okText); clearKey() } else patch({ readback: 'ok', verdict: 'applied', fields: det.fields, text: o.okText, settling: false })
            } else patch({ readback: 'ok', verdict: 'applied', fields: det.fields, settling: false })
          }
          try { o.onApplied?.() } catch { /* 页面回调出错不影响锁 */ }
          firstCheck('applied')
        },
      }
    })
    let seen: { v: unknown; f: unknown } = { v: undefined, f: undefined }
    const offLock = subscribeLock(() => {
      const info = lockOf(o.project)
      if (!info || info.key !== token.key) {
        offLock()
        candidate = null
        if (!applied && !failed && sameSession()) patch({ ended: 'expired', settling: false })
        firstCheck(null)
        return
      }
      if (info.lastVerify === seen.v && info.lastFields === seen.f) {
        // 核对结束但没有新的认可结论（中止等）：恢复「正在核对」之前的显示
        if (!info.verifying && before !== null) { const b = before; before = null; if (sameSession()) patch({ readback: b }) }
        // 结论没变、但自动核对结束了（退避用完 / 来不及再排）：改显示最近一次结论
        const cur = results.get(key)
        if (cur && cur.settling && !info.settling && sameSession()) patch({ settling: false })
        return
      }
      before = null
      seen = { v: info.lastVerify, f: info.lastFields }
      // 一致但被否决（读数已被更新的读取取代）：不显示「未变化」，仍按正在核对显示，等退避重核
      if (info.lastVetoed) { candidate = null; if (sameSession()) patch({ readback: 'pending' }); firstCheck(null); return }
      // 写锁认可了这次（不一致的）核对：候选读数这时才写缓存
      applyCandidate()
      const fields = info.lastFields ?? {}
      const vals = Object.values(fields)
      const verdict: FieldResult = vals.length ? verdictOf(vals)
        : info.lastVerify === 'mismatch' ? 'unchanged' : info.lastVerify === 'unverifiable' ? 'unverifiable' : 'unknown'
      const threw = lastThrew && (info.lastVerify === 'failed' || info.lastVerify === 'offline')
      // 还在自动核对（settling）时结论先记下、不显示（界面按 settling 显示「正在核对…」）
      if (sameSession()) patch(threw ? { readback: 'fail', verdict: 'unknown', fields: info.lastFields, settling: info.settling } : { readback: 'ok', verdict, fields: info.lastFields, settling: info.settling })
      firstCheck(verdict)
    })
    let outcome: Outcome
    let text: string
    let wrote = true
    let overdue = false
    try {
      await within(sent, LIMITS.writeDeadlineMs, '等待控制屏应答')
      outcome = 'ok'
      text = '已下发，正在核对…'
    } catch (e) {
      if (e instanceof Deadline) { markOverdue(token); overdue = true; outcome = 'unknown'; text = e.message }
      else { const c = classify(e); outcome = c.outcome; text = c.text; wrote = c.sent && claimed }
    }
    // 没认领就结束（beforeSend 没调到，比如发送前续期断网）：写入口一定没发出 → 按「未下发」，不说「已下发、结果未知」
    if (outcome === 'unknown' && !claimed && !overdue) { outcome = 'fail'; text = `未下发：${text}`; wrote = false }
    if (outcome !== 'ok') say(outcome === 'unknown' ? `${o.subject} 下发结果未知：${text}` : `${o.subject} ${text}`, true)
    failed = outcome === 'fail'
    record({ outcome, text, readback: outcome === 'unknown' ? 'waiting' : 'pending' })
    // 结论交给写锁：ok / unknown 进入待核对（原写已结算时立刻自动核对一次），fail 放锁
    settle(token, outcome)
    if (!wrote) { patch({ readback: 'ok' }); return 'not-sent' }
    if (outcome === 'unknown') return outcome

    setStage('verifying')
    if (!sameSession()) return outcome // 会话变了：不用新凭据回读
    if (outcome === 'fail') {
      // 确定失败：写后新读一次刷新界面
      const vac = new AbortController()
      let read = false
      try { await within(o.read(vac.signal), LIMITS.preflightMs, `回读${o.noun ?? '面板'}`, vac); read = true } catch { read = false }
      if (sameSession()) patch({ readback: read ? 'ok' : 'fail' })
      return outcome
    }
    // 已下发：等写锁的第一次核对结论（核对超时由写锁兜底，这里多等一点）
    // 成功提示、清结果条已在写锁认可后的 commit 里做过
    const verdict = await within(checked, LIMITS.preflightMs + 5_000, '核对').catch(() => null)
    return verdict === 'applied' && applied ? 'ok' : 'unverified'
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
