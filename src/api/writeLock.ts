// 下发写锁（统一控制 S12、温控 S9、新风 S10 三处共用）。模块级，离开页面再回来锁仍在。
//
// 口径（11/24 Chitu 定）：
// 1. 按控制屏加锁：project.controlScreenId；没有屏号退回 dtuId；都没有退回 project.id。两个测试项目共用一块屏，按屏锁才拦得住。
// 2. 原写的 Promise 没结算，锁就不放（不管期限）。
// 3. 结果未知：锁到「回读核对一致」为止（调用方提供核对函数：新读成功且目标值一致），或用户刷新页面。
// 4. 截止时间只决定界面标「未下发」还是「结果未确认」，不放锁（markOverdue 只改标记）。
// 5. 锁在 src/api 层模块级；subscribe / lockOf 给页面显示常驻锁提示。
// 6. 回读绑定账号：记下发起时的账号（/me 的用户 id + 会话代次）；账号变了，核对按失败处理、不用新凭据读、不解锁。
//
// 状态图（一把锁的一生）：
//
//   acquire(project) ──► held ──（beforeSend 里 isHolder(token) 同步复核）──► markSent(token, promise) ──► sending
//      │ 同一块屏已被锁 → busy             │ 没发出去就放弃：release(token) ──► 释放
//      ▼                                    ▼
//    （不变）                     sending：原 Promise 结算前一直持锁（settled=false）
//                                   │ settle(token, 'ok')   ── 且原 Promise 已结算 ──► 释放
//                                   │ settle(token, 'fail') ── 且原 Promise 已结算 ──► 释放（确定没生效）
//                                   │ settle(token, 'unknown') ──► unknown
//                                   │   （settle 早于原 Promise 结算：等结算时再按 settle 的结果处理）
//                                   ▼
//                                 unknown ── requireVerify(token, fn) 登记核对函数
//                                   │ verify(key)：账号未变 → 调 fn（新读成功且目标值一致 → true）
//                                   │   true 且原 Promise 已结算 ──► 释放
//                                   │   true 但原 Promise 未结算 ──► 保持（'send-pending'）
//                                   │   false / 抛错 ──► 保持（'mismatch' / 'failed'）
//                                   │   账号变了（调用前或读取途中）──► 保持（'account-changed'），不调 fn / 结果作废
//                                   ▼
//                                 （只有释放才离开；页面刷新时模块内存清空 —— 已知限制）
//
// 已知限制：锁只在本标签页内存里，刷新或另开标签页后没有。201 / 206 / 204 / 203 都是设置绝对值，重复下发幂等；刷新后页面重新
// 读取展示真实状态；跨标签页的原子互斥需要额外基础设施，超出 v1。
//
// 与 S4 写入口对接：本模块不改 http.ts。调用方在 requestWrite 的 beforeSend 里同步调用 isHolder(token)（当前持锁的是我、
// 还没发、账号没变），不是就不发。
import { getSession, subscribeSession } from './session'

export type LockPhase = 'held' | 'sending' | 'unknown'
export type WriteOutcome = 'ok' | 'fail' | 'unknown'
export type VerifyResult = 'released' | 'send-pending' | 'mismatch' | 'failed' | 'account-changed' | 'none'

/** 加锁目标：S6a 的 Project 可以直接传 */
export interface LockTarget { id: string; controlScreenId?: string; dtuId?: string }

export interface LockInfo {
  /** 锁键：screen:… / dtu:… / project:… */
  key: string
  /** 发起时的项目 id（同屏的其他项目也被这把锁拦住） */
  projectId: string
  /** 调用方给的说明（如「客厅 设定温度」），用于提示 */
  label: string
  phase: LockPhase
  /** 原写 Promise 已结算（markSent 之前为 false） */
  sendSettled: boolean
  outcome?: WriteOutcome
  /** 截止时间已过：界面据此标「结果未确认」（不影响锁） */
  overdue: boolean
  /** 发起时的账号是否就是当前账号 */
  mine: boolean
  /** 有没有登记核对函数 */
  verifiable: boolean
  verifying: boolean
}

export interface LockToken { readonly id: number; readonly key: string }

interface Entry {
  token: LockToken
  projectId: string
  label: string
  account: string
  phase: LockPhase
  sendSettled: boolean
  outcome?: WriteOutcome
  overdue: boolean
  verifyFn?: (signal: AbortSignal) => Promise<boolean>
  verifying: boolean
}

// ---------------------------------------------------------------------------
// 账号：/me 的用户 id + 会话代次（退出、换号、同号重登都换代）

let gen = 0
let lastUser: string | null | undefined
let unsub: (() => void) | null = null
const userNow = () => getSession().info?.user.id ?? null
function syncAccount(): boolean {
  const u = userNow()
  if (u === lastUser) return false
  lastUser = u
  gen += 1
  return true
}
function watchAccount() {
  if (!unsub) unsub = subscribeSession(() => { if (syncAccount()) emit() })
}
let accountSource: () => string = () => {
  watchAccount()
  syncAccount()
  return `${lastUser ?? 'anon'}#${gen}`
}
/** 当前账号标识（只读，可在渲染期间调用） */
export const currentAccount = () => accountSource()

// ---------------------------------------------------------------------------

let seq = 0
let locks = new Map<string, Entry>()
let version = 0
const subs = new Set<() => void>()
function emit() { version += 1; for (const fn of subs) { try { fn() } catch { /* 订阅者出错不影响锁 */ } } }

/** 锁键：控制屏 → DTU → 项目 id */
export function lockKeyOf(t: LockTarget): string {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  if (s(t.controlScreenId)) return `screen:${s(t.controlScreenId)}`
  if (s(t.dtuId)) return `dtu:${s(t.dtuId)}`
  return `project:${t.id}`
}

const view = (e: Entry): LockInfo => ({
  key: e.token.key, projectId: e.projectId, label: e.label, phase: e.phase, sendSettled: e.sendSettled, outcome: e.outcome,
  overdue: e.overdue, mine: e.account === currentAccount(), verifiable: !!e.verifyFn, verifying: e.verifying,
})
const entryOf = (token: LockToken) => {
  const e = locks.get(token.key)
  return e && e.token === token ? e : null
}

/** 取锁：同一块屏已被锁则返回 busy（附当前锁的信息） */
export function acquire(target: LockTarget, label = ''): { ok: true; token: LockToken } | { ok: false; busy: LockInfo } {
  const key = lockKeyOf(target)
  const cur = locks.get(key)
  if (cur) return { ok: false, busy: view(cur) }
  const token: LockToken = Object.freeze({ id: ++seq, key })
  locks.set(key, { token, projectId: target.id, label, account: currentAccount(), phase: 'held', sendSettled: false, overdue: false, verifying: false })
  emit()
  return { ok: true, token }
}

/**
 * 同步复核（给 requestWrite 的 beforeSend 用）：这把锁仍由该 token 持有、还没发出、账号没变。
 * 不是就返回 false（调用方不发）
 */
export function isHolder(token: LockToken): boolean {
  const e = entryOf(token)
  return !!e && e.phase === 'held' && e.account === currentAccount()
}

function maybeRelease(e: Entry) {
  if (!e.sendSettled) return
  if (e.outcome === 'ok' || e.outcome === 'fail') { locks.delete(e.token.key); emit() }
}

/** 登记已发出的写请求：原 Promise 结算前一直持锁 */
export function markSent(token: LockToken, sent: Promise<unknown>): void {
  const e = entryOf(token)
  if (!e || e.phase !== 'held') return
  e.phase = 'sending'
  emit()
  void sent.then(() => {}, () => {}).then(() => {
    e.sendSettled = true
    if (locks.get(e.token.key) === e) { emit(); maybeRelease(e) }
  })
}

/**
 * 记下这次写的结论：ok（success=true）/ fail（确定没生效）在原 Promise 结算后释放；unknown 进入待核对。
 * 还没 markSent 就 settle（没发出去）：按 fail 处理、直接释放
 */
export function settle(token: LockToken, outcome: WriteOutcome): void {
  const e = entryOf(token)
  if (!e) return
  if (e.phase === 'held') { locks.delete(e.token.key); emit(); return }
  e.outcome = outcome
  if (outcome === 'unknown') e.phase = 'unknown'
  emit()
  maybeRelease(e)
}

/** 截止时间已过：只改标记（界面显示「结果未确认」），不放锁 */
export function markOverdue(token: LockToken): void {
  const e = entryOf(token)
  if (!e || e.overdue) return
  e.overdue = true
  emit()
}

/** 登记核对函数：新读成功且目标值与这次下发一致时返回 true */
export function requireVerify(token: LockToken, fn: (signal: AbortSignal) => Promise<boolean>): void {
  const e = entryOf(token)
  if (!e) return
  e.verifyFn = fn
  emit()
}

/**
 * 核对（页面「核对」按钮、或写后自动核对）。账号与发起时不同 → 不读、不解锁；读取途中账号变化 → 结果作废。
 * 一致且原 Promise 已结算才释放
 */
export async function verify(key: string, signal?: AbortSignal): Promise<VerifyResult> {
  const e = locks.get(key)
  if (!e || e.phase !== 'unknown' || !e.verifyFn || e.verifying) return 'none'
  if (e.account !== currentAccount()) return 'account-changed'
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  e.verifying = true
  emit()
  let same: boolean
  try {
    same = await e.verifyFn(ac.signal)
  } catch {
    return e.account !== currentAccount() ? 'account-changed' : 'failed'
  } finally {
    e.verifying = false
    signal?.removeEventListener('abort', onAbort)
    if (locks.get(key) === e) emit()
  }
  if (e.account !== currentAccount()) return 'account-changed'
  if (signal?.aborted) return 'failed'
  if (!same) return 'mismatch'
  if (!e.sendSettled) return 'send-pending'
  if (locks.get(key) === e) { locks.delete(key); emit() }
  return 'released'
}

/**
 * 主动放弃：只允许在还没发出（held）时，或原 Promise 已结算且结论不是 unknown 时。其余情况不放，返回 false
 */
export function release(token: LockToken): boolean {
  const e = entryOf(token)
  if (!e) return false
  const ok = e.phase === 'held' || (e.sendSettled && e.outcome !== undefined && e.outcome !== 'unknown')
  if (!ok) return false
  locks.delete(token.key)
  emit()
  return true
}

/** 某个锁键 / 某个项目（按它的控制屏）的当前锁 */
export const lockOf = (keyOrTarget: string | LockTarget): LockInfo | null => {
  const e = locks.get(typeof keyOrTarget === 'string' ? keyOrTarget : lockKeyOf(keyOrTarget))
  return e ? view(e) : null
}

/** 订阅锁的变化（含账号变化，mine 可能随之改变）；返回取消订阅 */
export function subscribe(fn: () => void): () => void {
  watchAccount()
  subs.add(fn)
  return () => { subs.delete(fn) }
}
/** 版本号：useSyncExternalStore 的快照用 */
export const lockVersion = () => version

/** 仅供测试：清空锁、换账号来源（不传则恢复默认的 api/session） */
export function __resetWriteLockForTests(account?: () => string) {
  locks = new Map()
  unsub = null
  lastUser = undefined
  accountSource = account ?? (() => { watchAccount(); syncAccount(); return `${lastUser ?? 'anon'}#${gen}` })
  emit()
}
