// 统一控制下发流程的显式状态机：
//
//   idle ──request(校验通过)──▶ confirming ──confirm──▶ sending ──▶ success（已生效：下发后回读逐字段一致）
//    ▲  ◀──request(校验不过，带 errors)  │   │            ├──▶ unapplied（未变化：success=true，有字段读到了但和下发的不一样；混合时按排序算）
//    │  ◀──cancel / abort──────────────┘   │            ├──▶ unverifiable（无法核对：success=true，没有不一致的，但有字段没回报 / 读不到）
//    │                                      │            ├──▶ failure（没发出 / 明确被拒）
//    │  ◀──abort 或发送前复核不过──────────────┘            └──▶ unknown（结果未知：应答未知且回读没核对一致，或 success=true 但回读失败）
//    └────────────────reset───────────── success / unapplied / unverifiable / failure / unknown
//
// 下发结果口径（Fable 11/24 裁定）：控制屏 success=true 只算「已下发，待核对」，以下发后回读为准。只有回读逐字段一致才是 success；
// 应答结果未知（超时等）但回读一致也升为 success（via='readback'）。
// 混合字段的总结果排序（Fable 11/25 改 B）：结果未知 > 未变化 > 无法核对 > 已生效（逐字段结论见 rules.ts fieldResults）。
//
// - transition() 是纯函数：不合法的事件原样返回当前状态（比如 sending 期间再点确认）。
// - createUnifiedController() 负责副作用：确认时按最新上下文复核、下发前读一次、真正发送前再核对
//   （AbortSignal 没取消、世代号没变、项目 code 没变、按最新上下文校验仍通过；任何一项不符就终止回 idle）、
//   经 S4 的统一写入口 writeCtrl(203) 下发一次、下发后读一次并逐字段核对、写脱敏日志。
// - 全程不重试：sending 期间重复 confirm() 返回同一个 Promise；结束后只能 reset() 再走一遍确认。
// - abort()：页面卸载或切换项目时调用。发送前的流程立即终止；已经发出的下发无法撤回，照常走完回读。
import { writeCtrl, type CtrlReply, type WriteQuery } from '@/api/ctrl'
import { ApiError, isApiError, type ApiErrorKind } from '@/api/errors'
import type { WriteProject } from '@/api/guard'
import { TEXT } from './constants'
import { consoleLogger, makeEntry, type EntryInput, type UnifiedLogEvent, type UnifiedLogger } from './log'
import { changedFields, describeQuery, echoMismatches, echoVerdict, validateUnified, type EchoMismatch, type Issue, type UnifiedContext, type UnifiedDraft, type UnifiedEcho } from './rules'

export interface UnifiedTarget { projectId: string; projectCode: string; projectName: string }
export type SendingStep = 'read-before' | 'send' | 'read-after'
/**
 * failure 的原因：
 * - not-sent：没发出（下发前读取失败、写防护拦截、写消息校验不过、发送前复核不过、登录状态失效）
 * - rejected：明确被拒（控制屏 success=false、网关无权限 / 令牌失效、后端参数错误）
 * 结果未知（超时、断网、500、503、取消等）不进 failure，见 unknown 状态
 */
export type FailureOutcome = 'not-sent' | 'rejected'
export type Outcome = FailureOutcome | 'unknown'

type Base = { target: UnifiedTarget; query: WriteQuery<203> }
export type UnifiedState<S = unknown> =
  | { status: 'idle'; errors: string[] }
  | ({ status: 'confirming'; draft: UnifiedDraft; items: Array<{ label: string; value: string }> } & Base)
  | ({ status: 'sending'; step: SendingStep; before?: S } & Base)
  /** 已生效：回读逐字段一致。via='reply'：Reply success=true；via='readback'：应答结果未知，但回读逐字段一致 */
  | ({ status: 'success'; via: 'reply' | 'readback'; before: S; after: S } & Base)
  /** 未变化：Reply success=true，有字段读到了但和下发的不一样（mismatches 至少一条 differ；也可能同时有 missing / unreadable） */
  | ({ status: 'unapplied'; before: S; after: S; mismatches: EchoMismatch[] } & Base)
  /** 无法核对：Reply success=true，没有不一致的，但有字段设备没回报或回读接口读不到（mismatches 全是 missing / unreadable） */
  | ({ status: 'unverifiable'; before: S; after: S; mismatches: EchoMismatch[] } & Base)
  | ({ status: 'failure'; outcome: FailureOutcome; error: string; before?: S; after?: S | null; afterError?: string } & Base)
  /**
   * 结果未知：应答结果未知且回读没核对一致（replied=false，「已下发，结果未知，请刷新查看」），
   * 或 Reply success=true 但下发后回读失败（replied=true，「已下发，结果未知」）。不重试
   */
  | ({ status: 'unknown'; replied: boolean; error: string; cause: string; before: S; after: S | null; afterError?: string; mismatches: EchoMismatch[] } & Base)

export type UnifiedEvent<S = unknown> =
  | { type: 'REJECT'; errors: string[] }
  | { type: 'REQUEST'; target: UnifiedTarget; draft: UnifiedDraft; query: WriteQuery<203> }
  | { type: 'CANCEL' }
  | { type: 'CONFIRM' }
  /** 页面卸载、切换项目或发送前复核不过：confirming / 发送前的 sending → idle */
  | { type: 'ABORT'; errors: string[] }
  | { type: 'STEP'; step: SendingStep; before?: S }
  | { type: 'SUCCEED'; via: 'reply' | 'readback'; before: S; after: S }
  | { type: 'UNAPPLIED'; before: S; after: S; mismatches: EchoMismatch[] }
  | { type: 'UNVERIFIABLE'; before: S; after: S; mismatches: EchoMismatch[] }
  | { type: 'FAIL'; outcome: FailureOutcome; error: string; before?: S; after?: S | null; afterError?: string }
  | { type: 'UNKNOWN'; replied: boolean; cause: string; before: S; after: S | null; afterError?: string; mismatches: EchoMismatch[] }
  | { type: 'RESET' }

export const INITIAL: UnifiedState<never> = Object.freeze({ status: 'idle', errors: [] as string[] }) as UnifiedState<never>

/** 结束状态（success / unapplied / unverifiable / failure / unknown） */
export const isDone = (s: UnifiedState<unknown>): boolean =>
  s.status === 'success' || s.status === 'unapplied' || s.status === 'unverifiable' || s.status === 'failure' || s.status === 'unknown'

/** 纯状态转移；不合法的事件返回原状态（同一引用） */
export function transition<S>(s: UnifiedState<S>, e: UnifiedEvent<S>): UnifiedState<S> {
  switch (e.type) {
    case 'REJECT':
      return s.status === 'idle' ? { status: 'idle', errors: e.errors } : s
    case 'REQUEST':
      return s.status === 'idle' ? { status: 'confirming', target: e.target, draft: e.draft, query: e.query, items: describeQuery(e.query) } : s
    case 'CANCEL':
      return s.status === 'confirming' ? { status: 'idle', errors: [] } : s
    case 'CONFIRM':
      return s.status === 'confirming' ? { status: 'sending', target: s.target, query: s.query, step: 'read-before' } : s
    case 'ABORT':
      // 发出之后不能回 idle：下发可能已生效，必须走完回读
      return s.status === 'confirming' || (s.status === 'sending' && s.step === 'read-before') ? { status: 'idle', errors: e.errors } : s
    case 'STEP':
      return s.status === 'sending' ? { ...s, step: e.step, before: e.before ?? s.before } : s
    case 'SUCCEED':
      return s.status === 'sending'
        ? { status: 'success', target: s.target, query: s.query, via: e.via, before: e.before, after: e.after }
        : s
    case 'UNAPPLIED':
      return s.status === 'sending' ? { status: 'unapplied', target: s.target, query: s.query, before: e.before, after: e.after, mismatches: e.mismatches } : s
    case 'UNVERIFIABLE':
      return s.status === 'sending' ? { status: 'unverifiable', target: s.target, query: s.query, before: e.before, after: e.after, mismatches: e.mismatches } : s
    case 'FAIL':
      return s.status === 'sending'
        ? { status: 'failure', target: s.target, query: s.query, outcome: e.outcome, error: e.error, before: e.before, after: e.after, afterError: e.afterError }
        : s
    case 'UNKNOWN':
      return s.status === 'sending'
        ? { status: 'unknown', target: s.target, query: s.query, replied: e.replied, error: e.replied ? TEXT.sentUnknown : TEXT.unconfirmed, cause: e.cause, before: e.before, after: e.after, afterError: e.afterError, mismatches: e.mismatches }
        : s
    case 'RESET':
      return isDone(s) ? { status: 'idle', errors: [] } : s
  }
}

/** 下发函数：默认走 S4 统一写入口 writeCtrl(203)（内部 requestWrite() 过写防护、不重试）。不传取消信号：发出后不中止 */
export type UnifiedSender = (project: WriteProject, query: WriteQuery<203>) => Promise<CtrlReply<203>>
export const defaultSender: UnifiedSender = (project, query) => writeCtrl(203, project, query)

export interface UnifiedDeps<S> {
  /** 取当前项目信息（S6a 合并前由页面注入）；确认时和发送前都会再取一次复核 */
  getContext: () => UnifiedContext | null | undefined
  /** 回读当前状态，下发前后各调一次。signal 在 abort() 时取消。测试里注入假数据 */
  readBack: (projectId: string, signal: AbortSignal) => Promise<S>
  /** 把回读结果整理成逐字段核对用的形状（必填：回读就是为了核对） */
  toEcho: (snapshot: S) => UnifiedEcho
  send?: UnifiedSender
  log?: UnifiedLogger
}

export interface UnifiedController<S> {
  getState: () => UnifiedState<S>
  subscribe: (fn: () => void) => () => void
  /** 校验通过 → confirming（二次确认）；不通过 → idle 并带 errors */
  request: (draft: UnifiedDraft) => UnifiedState<S>
  cancel: () => void
  /** 确认下发；sending 期间重复调用返回同一个 Promise；其他状态下调用无效 */
  confirm: () => Promise<UnifiedState<S>>
  /** 结束状态 → idle。不自动重试，要重新下发须再 request + confirm */
  reset: () => void
  /** 页面卸载或切换项目：终止还没发出的流程（回 idle）；已发出的照常走完 */
  abort: () => void
}

/**
 * 前端自己在发请求之前抛的（没有 HTTP 状态）：写防护拦截、写消息校验不过 → 肯定没发出。
 * aborted 不算：fetch 发出后被取消也是无状态的 aborted，可能已经到了控制屏
 */
const LOCAL_NOT_SENT = new Set<ApiErrorKind>(['write_blocked', 'bad_request'])
/** 后端或网关明确拒绝、不会转给控制屏执行的 */
const REJECTED = new Set<ApiErrorKind>(['ctrl', 'forbidden', 'unauthenticated', 'bad_request'])
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 只有能确定的才算 not-sent / rejected，其余一律结果未知：请求可能已经到达控制屏并执行 */
export function outcomeOf(e: unknown): Outcome {
  if (!isApiError(e)) return 'unknown'
  // 未认证（401 / 网关 token err）：网关在转给控制屏之前就拒了，确定没执行。写入口不重放，按「未执行」结束
  if (e.kind === 'unauthenticated') return 'not-sent'
  // 控制屏未连接（503 + gRPC code 14）：后端没有可用的连接，没转给控制屏（第二道防线）
  if (e.kind === 'unavailable' && e.code === 14) return 'not-sent'
  if (e.status === undefined && LOCAL_NOT_SENT.has(e.kind)) return 'not-sent'
  if (e.kind === 'ctrl' || (e.status !== undefined && REJECTED.has(e.kind))) return 'rejected'
  return 'unknown'
}

const sameQuery = (a: WriteQuery<203>, b: WriteQuery<203>) =>
  a.systemSwitch === b.systemSwitch && a.systemMode === b.systemMode && a.roomSwitch === b.roomSwitch && a.roomTemp === b.roomTemp

const PROJECT_CHANGED: Issue = { code: 'NO_PROJECT', message: TEXT.projectChanged }

/** 复核：项目 id 与 code 都没变，且按最新上下文（在线、app_code、温度范围）重新校验仍通过、组装结果不变 */
function recheck(ctx: UnifiedContext | null | undefined, target: UnifiedTarget, draft: UnifiedDraft, query: WriteQuery<203>): { changed: boolean; issues: Issue[] } | null {
  if (!ctx || ctx.projectId !== target.projectId || ctx.projectCode !== target.projectCode) return { changed: true, issues: [PROJECT_CHANGED] }
  const v = validateUnified(draft, ctx)
  if (!v.ok) return { changed: false, issues: v.issues }
  // 同一份草稿组装结果理应不变；万一变了按「项目已变化」处理，要求重新确认
  return sameQuery(v.query, query) ? null : { changed: true, issues: [PROJECT_CHANGED] }
}

function toTarget(ctx: UnifiedContext): UnifiedTarget {
  return { projectId: ctx.projectId, projectCode: ctx.projectCode, projectName: ctx.projectName || ctx.projectCode }
}

export function createUnifiedController<S>(deps: UnifiedDeps<S>): UnifiedController<S> {
  const send = deps.send ?? defaultSender
  const log = deps.log ?? consoleLogger
  let state: UnifiedState<S> = INITIAL
  let inflight: Promise<UnifiedState<S>> | null = null
  /** 世代号：abort() 加一；进行中的流程发现世代变了就终止 */
  let gen = 0
  let ac: AbortController | null = null
  /** 已调用 send 的那一轮的世代号；-1 表示本轮还没调用 send */
  let sentGen = -1
  const subs = new Set<() => void>()

  const dispatch = (e: UnifiedEvent<S>) => {
    const next = transition(state, e)
    if (next === state) return
    state = next
    for (const fn of subs) fn()
  }
  const write = (event: UnifiedLogEvent, t: UnifiedTarget | undefined, p: Omit<EntryInput, 'projectCode'> = {}) => {
    try { log(makeEntry(event, { projectCode: t?.projectCode, ...p })) } catch { /* 日志失败不影响下发 */ }
  }

  /** 回读 → 核对用的形状；toEcho 抛错算全部字段没读到（null） */
  const echoOf = (after: S | null): UnifiedEcho | null => {
    if (after === null) return null
    try { return deps.toEcho(after) } catch { return null }
  }

  async function run(target: UnifiedTarget, draft: UnifiedDraft, query: WriteQuery<203>, myGen: number, signal: AbortSignal): Promise<UnifiedState<S>> {
    const fields = changedFields(query)
    const stopped = () => signal.aborted || myGen !== gen
    const abortRun = (code: 'ABORTED' | 'PROJECT_CHANGED', errors: string[]) => {
      // 先更新状态、后写日志。abort() 已经把状态放回 idle（之后可能又开始了新一轮）：被作废的这一轮不再碰状态
      if (myGen === gen) dispatch({ type: 'ABORT', errors })
      write('aborted', target, { codes: [code], fields })
      return state
    }

    // 1. 下发前读一次；读不到就不下发（无法核对）
    let before: S
    try {
      before = await deps.readBack(target.projectId, signal)
    } catch (e) {
      if (stopped()) return abortRun('ABORTED', [TEXT.aborted])
      write('read-before', target, { codes: ['READ_FAILED'], error: e })
      dispatch({ type: 'FAIL', outcome: 'not-sent', error: `${TEXT.readBeforeFailed}：${errText(e)}` })
      return state
    }

    // 2. 真正发送前的最后核对：没取消、世代没变、项目 id/code 没变、按最新上下文校验仍通过。不符就终止回 idle。
    //    「最后核对 → 调用 send」是紧挨着的同步代码，中间不调日志、不通知订阅者；这些一律放到 send 调用之后
    if (stopped()) return abortRun('ABORTED', [TEXT.aborted])
    const stale = recheck(deps.getContext(), target, draft, query)
    if (stale) return abortRun('PROJECT_CHANGED', stale.changed ? [TEXT.projectChanged] : stale.issues.map((i) => i.message))
    // 3. 下发一次，不重试。sentGen 在调用 send 的同一刻记下：从这里起 abort() 视为已发出
    let pending: Promise<unknown>
    sentGen = myGen
    try { pending = send({ id: target.projectId, code: target.projectCode }, query) } catch (e) { pending = Promise.reject(e) }

    write('read-before', target, { codes: ['OK'] })
    dispatch({ type: 'STEP', step: 'send', before })
    write('send', target, { fields })
    let sendError: unknown = null
    try {
      const reply = (await pending) as { success?: unknown; msg?: unknown } | null | undefined
      // 注入的下发函数可能正常返回 success=false（默认的 writeCtrl 会抛错）：同样按控制屏明确拒绝处理
      if (!reply || reply.success !== true) {
        sendError = new ApiError('ctrl', (typeof reply?.msg === 'string' && reply.msg) || '下发失败')
      }
    } catch (e) {
      sendError = e
    }
    const outcome: Outcome | null = sendError === null ? null : outcomeOf(sendError)

    if (outcome === 'not-sent') {
      write('failure', target, { codes: ['NOT_SENT'], error: sendError, fields })
      dispatch({ type: 'FAIL', outcome: 'not-sent', error: `${TEXT.failure}：${errText(sendError)}`, before })
      return state
    }

    // 4. 下发后读一次（已发出就读，不受 abort 影响：下发可能已生效）
    dispatch({ type: 'STEP', step: 'read-after' })
    let after: S | null = null
    let readErr: unknown = null
    try {
      after = await deps.readBack(target.projectId, new AbortController().signal)
      write('read-after', target, { codes: ['OK'] })
    } catch (e) {
      readErr = e
      write('read-after', target, { codes: ['READ_FAILED'], error: e })
    }
    const echo = echoOf(after)
    const mismatches = echoMismatches(query, echo)
    const verdict = after === null ? null : echoVerdict(mismatches, echo)
    const byKind = (...kinds: EchoMismatch['kind'][]) => [...new Set(mismatches.filter((m) => kinds.includes(m.kind)).map((m) => m.field))]

    if (outcome === null) {
      // Reply success=true 只算「已下发」，以回读为准
      if (after === null) {
        // 回读失败：结果未知（不算成功）
        write('unknown', target, { codes: ['REPLY_OK', 'READ_FAILED'], error: readErr, fields })
        dispatch({ type: 'UNKNOWN', replied: true, cause: '', before, after: null, afterError: `${TEXT.readAfterFailedUnknown}：${errText(readErr)}`, mismatches })
        return state
      }
      if (verdict === 'applied') {
        write('success', target, { codes: ['REPLY_OK', 'VERIFIED'], fields })
        dispatch({ type: 'SUCCEED', via: 'reply', before, after })
      } else if (verdict === 'unknown') {
        // 有房间离线：读数不可信，结果未知
        write('unknown', target, { codes: ['REPLY_OK', 'OFFLINE'], fields })
        dispatch({ type: 'UNKNOWN', replied: true, cause: '', before, after, afterError: TEXT.roomsOffline, mismatches })
      } else if (verdict === 'unchanged') {
        write('unapplied', target, { codes: ['REPLY_OK', 'ECHO_MISMATCH'], fields: byKind('differ', 'missing', 'unreadable') })
        dispatch({ type: 'UNAPPLIED', before, after, mismatches })
      } else {
        write('unverifiable', target, { codes: ['REPLY_OK', 'NOT_VERIFIED'], fields: byKind('missing', 'unreadable') })
        dispatch({ type: 'UNVERIFIABLE', before, after, mismatches })
      }
      return state
    }
    if (outcome === 'rejected') {
      const afterError = readErr === null ? undefined : `${TEXT.readAfterFailedUnknown}：${errText(readErr)}`
      write('failure', target, { codes: ['REJECTED'], error: sendError, fields })
      dispatch({ type: 'FAIL', outcome: 'rejected', error: `${TEXT.failure}：${errText(sendError)}`, before, after, afterError })
      return state
    }
    // 应答结果未知：回读逐字段一致就算成功（已核对），否则停在 unknown，不重试
    if (after !== null && verdict === 'applied') {
      write('success', target, { codes: ['UNKNOWN', 'VERIFIED'], error: sendError, fields })
      dispatch({ type: 'SUCCEED', via: 'readback', before, after })
      return state
    }
    const afterError = readErr === null ? undefined : `${TEXT.readAfterFailedUnknown}：${errText(readErr)}`
    write('unknown', target, { codes: ['UNKNOWN', readErr ? 'READ_FAILED' : verdict === 'unchanged' ? 'ECHO_MISMATCH' : 'NOT_VERIFIED'], error: sendError, fields: byKind('missing', 'unreadable', 'differ') })
    dispatch({ type: 'UNKNOWN', replied: false, cause: errText(sendError), before, after, afterError, mismatches })
    return state
  }

  return {
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } },
    request(draft) {
      if (state.status !== 'idle') return state
      const ctx = deps.getContext()
      const v = validateUnified(draft, ctx)
      if (!v.ok) {
        write('blocked', ctx ? toTarget(ctx) : undefined, { codes: v.issues.map((i) => i.code) })
        dispatch({ type: 'REJECT', errors: v.errors })
      } else {
        dispatch({ type: 'REQUEST', target: toTarget(ctx!), draft, query: v.query })
      }
      return state
    },
    cancel() {
      if (state.status !== 'confirming') return
      const t = state.target
      // 先更新状态、后写日志
      dispatch({ type: 'CANCEL' })
      write('cancel', t)
    },
    confirm() {
      if (inflight) return inflight
      if (state.status !== 'confirming') return Promise.resolve(state)
      const { target, draft, query } = state
      // 复核：确认弹窗打开期间项目可能离线、被切换或 app_code 变了
      const stale = recheck(deps.getContext(), target, draft, query)
      if (stale) {
        dispatch({ type: 'ABORT', errors: stale.changed ? [TEXT.projectChanged] : stale.issues.map((i) => i.message) })
        write('blocked', target, { codes: stale.changed ? ['PROJECT_CHANGED'] : stale.issues.map((i) => i.code) })
        return Promise.resolve(state)
      }
      // 先建好信号、记下世代号，再通知订阅者 / 写日志：回调里调 abort() 能作废本轮
      const myAc = new AbortController()
      ac = myAc
      const myGen = gen
      sentGen = -1
      dispatch({ type: 'CONFIRM' })
      write('confirm', target, { fields: changedFields(query) })
      if (myGen !== gen || myAc.signal.aborted) return Promise.resolve(state)
      const p: Promise<UnifiedState<S>> = run(target, draft, query, myGen, myAc.signal).finally(() => {
        if (inflight === p) inflight = null
        if (ac === myAc) ac = null
      })
      inflight = p
      return p
    },
    reset() { dispatch({ type: 'RESET' }) },
    abort() {
      // send 已经调用过的不作废：下发可能已生效，必须走完回读
      const s = state
      if (!(s.status === 'confirming' || (s.status === 'sending' && s.step === 'read-before' && sentGen !== gen))) return
      gen++
      ac?.abort()
      ac = null
      inflight = null
      // 先更新状态、后写日志
      dispatch({ type: 'ABORT', errors: [TEXT.aborted] })
      write('aborted', s.target, { codes: ['ABORTED'] })
    },
  }
}
