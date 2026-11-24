// 统一控制下发流程的显式状态机：
//
//   idle ──request(校验通过)──▶ confirming ──confirm──▶ sending ──▶ success（Reply success=true 即已生效）
//    ▲  ◀──request(校验不过，带 errors)        │                └──▶ failure（不自动重试）
//    │  ◀────────────cancel──────────────────┘
//    └────────────────reset───────────── success / failure
//
// - transition() 是纯函数：不合法的事件原样返回当前状态（比如 sending 期间再点确认）。
// - createUnifiedController() 负责副作用：确认时重新取当前项目并复核（离线、换了项目就退回 idle）、
//   下发前读一次、经 S4 的统一写入口 writeCtrl(203) 下发一次、下发后读一次核对、写脱敏日志。
// - sending 期间重复 confirm() 返回同一个 Promise，不会重复下发；失败后只能 reset() 再走一遍确认。
import { writeCtrl, type CtrlReply, type WriteQuery } from '@/api/ctrl'
import { isApiError, type ApiErrorKind } from '@/api/errors'
import { TEXT } from './constants'
import { consoleLogger, makeEntry, type UnifiedLogEvent, type UnifiedLogger } from './log'
import { describeQuery, validateUnified, type UnifiedContext, type UnifiedDraft } from './rules'

export interface UnifiedTarget { projectId: string; projectCode: string; projectName: string }
export type SendingStep = 'read-before' | 'send' | 'read-after'
/**
 * 失败时下发到了哪一步：
 * - not-sent：没发出（下发前读取失败、写防护拦截、参数错误、复核不过）
 * - rejected：控制屏明确拒绝（Reply success=false 或后端返回错误）
 * - unknown：超时或断网，请求可能已到控制屏，结果未知，须看回读
 */
export type FailureOutcome = 'not-sent' | 'rejected' | 'unknown'

export type UnifiedState<S = unknown> =
  | { status: 'idle'; errors: string[] }
  | { status: 'confirming'; target: UnifiedTarget; draft: UnifiedDraft; query: WriteQuery<203>; items: Array<{ label: string; value: string }> }
  | { status: 'sending'; target: UnifiedTarget; query: WriteQuery<203>; step: SendingStep; before?: S }
  | { status: 'success'; target: UnifiedTarget; query: WriteQuery<203>; before: S; after: S | null; afterError?: string; mismatches: string[] }
  | { status: 'failure'; target: UnifiedTarget; query: WriteQuery<203>; outcome: FailureOutcome; error: string; before?: S; after?: S | null; afterError?: string }

export type UnifiedEvent<S = unknown> =
  | { type: 'REJECT'; errors: string[] }
  | { type: 'REQUEST'; target: UnifiedTarget; draft: UnifiedDraft; query: WriteQuery<203> }
  | { type: 'CANCEL' }
  | { type: 'CONFIRM' }
  | { type: 'STEP'; step: SendingStep; before?: S }
  | { type: 'SUCCEED'; before: S; after: S | null; afterError?: string; mismatches: string[] }
  | { type: 'FAIL'; outcome: FailureOutcome; error: string; before?: S; after?: S | null; afterError?: string }
  | { type: 'RESET' }

export const INITIAL: UnifiedState<never> = Object.freeze({ status: 'idle', errors: [] as string[] }) as UnifiedState<never>

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
    case 'STEP':
      return s.status === 'sending' ? { ...s, step: e.step, before: e.before ?? s.before } : s
    case 'SUCCEED':
      return s.status === 'sending'
        ? { status: 'success', target: s.target, query: s.query, before: e.before, after: e.after, afterError: e.afterError, mismatches: e.mismatches }
        : s
    case 'FAIL':
      return s.status === 'sending'
        ? { status: 'failure', target: s.target, query: s.query, outcome: e.outcome, error: e.error, before: e.before, after: e.after, afterError: e.afterError }
        : s
    case 'RESET':
      return s.status === 'success' || s.status === 'failure' ? { status: 'idle', errors: [] } : s
  }
}

/** 下发函数：默认走 S4 统一写入口 writeCtrl(203)（内部 requestWrite() 过写防护、不重试） */
export type UnifiedSender = (projectId: string, query: WriteQuery<203>) => Promise<CtrlReply<203>>
export const defaultSender: UnifiedSender = (projectId, query) => writeCtrl(203, projectId, query)

export interface UnifiedDeps<S> {
  /** 取当前项目信息（S6a 合并前由页面注入）；确认时会再取一次复核 */
  getContext: () => UnifiedContext | null | undefined
  /** 回读当前状态，下发前后各调一次，用来回显核对。测试里注入假数据 */
  readBack: (projectId: string) => Promise<S>
  /**
   * 核对回读结果与下发值，返回不一致项的说明（必填：回读就是为了核对）。
   * 回读能整理成 UnifiedEcho 时可直接用 rules.ts 的 echoMismatches()
   */
  verify: (query: WriteQuery<203>, before: S, after: S) => string[]
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
  /** success / failure → idle。失败不自动重试，要重新下发须再 request + confirm */
  reset: () => void
  /** 页面卸载时调用：之后的结果不再更新状态（已发出的下发无法撤回） */
  dispose: () => void
}

/** 前端自己抛的（没有 HTTP 状态）：写防护拦截、写消息校验不过、发出前取消 → 肯定没发出 */
const LOCAL_NOT_SENT = new Set<ApiErrorKind>(['write_blocked', 'bad_request', 'aborted'])
/** 后端或网关明确拒绝、不会转给控制屏执行的：控制屏 success=false、无权限、令牌失效、参数错误 */
const REJECTED = new Set<ApiErrorKind>(['ctrl', 'forbidden', 'unauthenticated', 'bad_request'])
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * 只有能确定的才算 not-sent / rejected，其余（超时、断网、500、503、后端返回的取消、普通异常）
 * 一律按结果未知处理并回读核对：请求可能已经到达控制屏并执行。
 */
export function outcomeOf(e: unknown): FailureOutcome {
  if (!isApiError(e)) return 'unknown'
  if (e.status === undefined && LOCAL_NOT_SENT.has(e.kind)) return 'not-sent'
  if (e.kind === 'ctrl' || (e.status !== undefined && REJECTED.has(e.kind))) return 'rejected'
  return 'unknown'
}

/** 实际发送前的复核：项目没换、仍在线 */
function recheck(ctx: UnifiedContext | null | undefined, target: UnifiedTarget): string | null {
  if (!ctx || ctx.projectId !== target.projectId) return TEXT.projectChanged
  if (ctx.online !== true) return TEXT.offline
  return null
}

function toTarget(ctx: UnifiedContext): UnifiedTarget {
  return { projectId: ctx.projectId, projectCode: ctx.projectCode, projectName: ctx.projectName || ctx.projectCode }
}

export function createUnifiedController<S>(deps: UnifiedDeps<S>): UnifiedController<S> {
  const send = deps.send ?? defaultSender
  const log = deps.log ?? consoleLogger
  let state: UnifiedState<S> = INITIAL
  let inflight: Promise<UnifiedState<S>> | null = null
  let disposed = false
  const subs = new Set<() => void>()

  const dispatch = (e: UnifiedEvent<S>) => {
    if (disposed) return
    const next = transition(state, e)
    if (next === state) return
    state = next
    for (const fn of subs) fn()
  }
  const write = (event: UnifiedLogEvent, t: UnifiedTarget | undefined, p: { query?: object; message?: string } = {}) => {
    try { log(makeEntry(event, { projectCode: t?.projectCode, projectId: t?.projectId, ...p })) } catch { /* 日志失败不影响下发 */ }
  }

  async function run(target: UnifiedTarget, query: WriteQuery<203>): Promise<UnifiedState<S>> {
    // 1. 下发前读一次；读不到就不下发（无法核对）
    let before: S
    try {
      before = await deps.readBack(target.projectId)
    } catch (e) {
      const error = `${TEXT.readBeforeFailed}：${errText(e)}`
      write('read-before', target, { message: error })
      dispatch({ type: 'FAIL', outcome: 'not-sent', error })
      return state
    }
    write('read-before', target)

    // 读取是异步的，期间项目可能离线或被切换：发送前再复核一次
    const stale = recheck(deps.getContext(), target)
    if (stale) {
      write('blocked', target, { message: stale })
      dispatch({ type: 'FAIL', outcome: 'not-sent', error: stale, before })
      return state
    }

    // 2. 下发一次，不重试
    dispatch({ type: 'STEP', step: 'send', before })
    write('send', target, { query })
    let sendError: unknown = null
    try {
      await send(target.projectId, query)
    } catch (e) {
      sendError = e
    }
    const outcome = sendError === null ? null : outcomeOf(sendError)

    // 3. 下发后读一次（没发出去就不读）
    let after: S | null = null
    let afterError: string | undefined
    if (outcome !== 'not-sent') {
      dispatch({ type: 'STEP', step: 'read-after' })
      try {
        after = await deps.readBack(target.projectId)
        write('read-after', target)
      } catch (e) {
        afterError = `${sendError === null ? TEXT.readAfterFailed : TEXT.readAfterFailedUnknown}：${errText(e)}`
        write('read-after', target, { message: afterError })
      }
    }

    if (sendError !== null) {
      const error = `${TEXT.failure}：${errText(sendError)}`
      write('failure', target, { query, message: `${outcome}；${error}` })
      dispatch({ type: 'FAIL', outcome: outcome!, error, before, after: outcome === 'not-sent' ? undefined : after, afterError })
      return state
    }

    let mismatches: string[] = []
    if (after !== null) {
      try { mismatches = deps.verify(query, before, after) } catch (e) { mismatches = [`${TEXT.verifyFailed}：${errText(e)}`] }
    }
    write('success', target, { query, message: mismatches.length ? `${TEXT.echoMismatch}：${mismatches.join('；')}` : afterError })
    dispatch({ type: 'SUCCEED', before, after, afterError, mismatches })
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
        write('blocked', ctx ? toTarget(ctx) : undefined, { message: v.errors.join('；') })
        dispatch({ type: 'REJECT', errors: v.errors })
      } else {
        dispatch({ type: 'REQUEST', target: toTarget(ctx!), draft, query: v.query })
      }
      return state
    },
    cancel() {
      if (state.status !== 'confirming') return
      write('cancel', state.target)
      dispatch({ type: 'CANCEL' })
    },
    confirm() {
      if (inflight) return inflight
      if (state.status !== 'confirming') return Promise.resolve(state)
      const { target, draft, query: confirmed } = state
      // 复核：确认弹窗打开期间项目可能离线或被切换
      const ctx = deps.getContext()
      const errors: string[] = []
      let query: WriteQuery<203> | null = null
      if (!ctx || ctx.projectId !== target.projectId) errors.push(TEXT.projectChanged)
      else {
        const v = validateUnified(draft, ctx)
        // 同一份草稿组装结果不变；下发的就是弹窗里展示的那份
        if (v.ok) query = confirmed
        else errors.push(...v.errors)
      }
      if (!query) {
        write('blocked', target, { message: errors.join('；') })
        dispatch({ type: 'CANCEL' })
        dispatch({ type: 'REJECT', errors })
        return Promise.resolve(state)
      }
      write('confirm', target, { query })
      dispatch({ type: 'CONFIRM' })
      inflight = run(target, query).finally(() => { inflight = null })
      return inflight
    },
    reset() { dispatch({ type: 'RESET' }) },
    dispose() { disposed = true; subs.clear() },
  }
}
