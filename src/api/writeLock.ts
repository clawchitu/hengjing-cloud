// 下发写锁（统一控制 S12、温控 S9、新风 S10 三处共用）。模块级，离开页面再回来锁仍在；已发出的锁另存 localStorage。
//
// 这把锁只防误操作（重复点、同屏并发、结果未知时再下发），不防越权；越权靠后端拦。
// 后续跨标签一致性类问题一律按「非目标，后端兜底，写幂等」处理。
//
// 口径（11/24 Chitu 定，#28 评审后由 Fable 复核定稿）：
// 1. 按控制屏加锁，并且原子锁住项目所有可用的键：控制屏号、DTU 号、项目 id。任一键已被占即 busy；lockOf 任一键命中即返回。
// 2. 发送前绑定账号：isHolder / claim 要求持锁、还没发出、账号与会话代次未变（登录、恢复、同号重登、退出换代；令牌续期不换代）。
// 3. 原写的 Promise 没结算，锁就不放（有效期到了除外，见 6）。
// 4. 结果未知：锁到「回读核对一致」为止。unknown 不能被后续 settle 覆盖；唯一例外：经 markSent 登记的那个原写 Promise
//    迟到 resolve（写入口只在 Reply success=true 时 resolve，后端答复⑥：success 即已生效），视为生效证据放锁。
// 5. 核对不绑定账号：谁能读谁核对，只要求读取途中账号没变（变了结果作废）。读之前先确认能读：用 resolveProject（S6a 组织范围的
//    同步查询，由应用注入）查存下的 projectId 是否在当前账号可见范围里，并用当前项目对象重算主锁键、与锁的键对上；不在或对不上
//    → 不发读请求、锁保持（not-visible）。不看 ctrl 响应判断能不能读（屏离线和 id 非法都是 503）。读到 503 → offline（屏离线，
//    可重试，锁保持）。核对晚于原写结算：原写未结算时直接 send-pending；结算后若有核对方式，自动核对一次。
//    传入已中止的 signal 直接返回；核对有超时（VERIFY_TIMEOUT_MS），超时后 verifying 复位、锁保留。
// 6. 有效期：从登记（markSent）起算，含写入口等待令牌续期的时间；默认 2 分钟，可配置、最短 30 秒（不宜配到 60 秒以下：
//    写 12 秒 + 续期 12 秒 + 回读核对都要在有效期内完成）；刷新和核对失败都不续期。到期放锁、通知订阅者，并发出
//    「强制重读」事件（onForceReread），让页面重读设备状态。截止时间（markOverdue）只改标记，不放锁。
// 7. 持久化：markSent 时就写 localStorage（键 = STORAGE_PREFIX + 主锁键），结论 ok / fail 时删；刷新后读到的记录一律按「结果未知」
//    恢复（原 Promise 已不存在，视为已结算），靠 registerVerifier(消息号, fn) 注册的核对器重建核对，注册时若已有该消息号的锁就立刻
//    核对一次。记录只存：锁键、projectId、消息号、设备 id、目标字段与值、userId、sentAt（不存 label、项目名、令牌或任何凭据）；
//    读取时结构校验，JSON 损坏、sentAt 晚于现在（时钟异常 / 篡改，即到期时间晚于「现在 + 有效期」）或已到期的直接作废。
// 8. 跨标签：监听 storage 事件，别的标签页写入 / 删除的记录同步到本标签（synced）。同步锁只读：本标签不核对它（verify 返回
//    send-pending，对方的写可能还在路上），放锁时也不代删对方的记录；对方删除记录时本标签按到期处理（放锁 + 强制重读）。
//    跨标签仍非严格原子：同一毫秒两个标签同时 acquire 理论上可能都成功；storage 写入冲突、迟到的删除事件也属已知限制，
//    后端兜底，写幂等。
// 9. 防泄露：别的账号看到的锁信息不带 label、projectId（lockOf 置空）；提示只用 OTHER_ACCOUNT_TEXT。
//
// 状态图：
//
//   acquire(project) ── 任一键被占 → busy
//      ▼
//    held（还没发出）
//      │ beforeSend 里同步 claim(token)：持锁、held、账号与代次未变 → 进入 sent，返回 true
//      │ 没认领就结束（beforeSend 没调 / 返回 false / 抛错 / 发送前失败）：settle 或登记的 Promise 结算 → 释放、删记录
//      ▼
//    sent ── markSent(token, promise, 记录) 登记原写 Promise、写 localStorage、开始计有效期
//      │ settle(ok | fail)：等原 Promise 结算后释放、删记录
//      │ settle(unknown) ──► unknown（只认第一次 settle）
//      ▼
//    unknown ── 原 Promise 迟到 resolve ──► 释放（证据）
//      │ verify：原写未结算 → send-pending；能读（可见 + 键对上）才读；一致 → 释放 / 不一致、失败、503、超时 → 保持
//      ▼
//    任一状态（sent / unknown）到有效期 ──► 释放 + 强制重读事件
//    刷新 ──► restored（unknown，已结算）；别的标签页 ──► synced（unknown，已结算）
//
// 与 S4 写入口对接（不改 http.ts）：acquire → requestWrite(…, { beforeSend: () => 其他复核 && claim(token) }) → 立刻
// markSent(token, 那个 Promise, 记录) → 按结果 settle；页面另用 requireVerify 登记本次的核对函数（可选，否则用注册的核对器）。
// 接入约束：subscribe / onForceReread 的回调里不得调用 settle / release（回调在状态变化途中同步触发）。
// 初始化顺序：应用启动时先 configureWriteLock（注入 resolveProject 等），再 registerVerifier（注册时会立刻核对恢复的锁，
// 没注入 resolveProject 会按不可见跳过）。localStorage 写入失败时 console.warn，降级为只在内存里锁。
import { isApiError } from './errors'
import { getSession, subscribeSession } from './session'

/** 一次核对的最长时间 */
export const VERIFY_TIMEOUT_MS = 15_000
/** 有效期：默认 2 分钟，最短 30 秒 */
export const DEFAULT_TTL_MS = 2 * 60_000
export const MIN_TTL_MS = 30_000
export const STORAGE_PREFIX = 'hjc-write-lock:'
/** 别的账号发起、本账号核对不了（或不该看到细节）时的提示 */
export const OTHER_ACCOUNT_TEXT = '上一账号的下发结果未知，请稍后再试或联系有权限的账号'

export type LockPhase = 'held' | 'sent' | 'unknown'
export type LockOrigin = 'local' | 'restored' | 'synced'
export type WriteOutcome = 'ok' | 'fail' | 'unknown'
export type VerifyResult = 'released' | 'send-pending' | 'mismatch' | 'failed' | 'offline' | 'not-visible' | 'account-changed' | 'aborted' | 'none'
export type LockOwner = 'current' | 'previous-session' | 'other-account'

/** 加锁目标：S6a 的 Project 可以直接传 */
export interface LockTarget { id: string; controlScreenId?: string; dtuId?: string }

export type Scalar = string | number | boolean | null
/** markSent 时要持久化的核对数据：消息号、设备 id、目标字段与值 */
export interface SentRecord { msg: number; deviceId: number | null; target: { [field: string]: Scalar } }
/** localStorage 里的一条记录 */
export interface StoredLock extends SentRecord {
  v: 1
  /** 写入者的操作编号（跨标签唯一，不是凭据），删除时核对，避免删掉别人的新记录 */
  op: string
  keys: string[]
  projectId: string
  userId: string | null
  sentAt: number
}

export interface LockInfo {
  key: string
  keys: readonly string[]
  /** 别的账号看到的为空串（防泄露） */
  projectId: string
  /** 别的账号看到的为空串；恢复 / 同步来的锁本来就没有 */
  label: string
  phase: LockPhase
  origin: LockOrigin
  sendSettled: boolean
  outcome?: WriteOutcome
  overdue: boolean
  owner: LockOwner
  mine: boolean
  verifiable: boolean
  verifying: boolean
  /** 有效期到期时间（已发出才有） */
  expiresAt?: number
}

export interface LockToken { readonly id: number; readonly key: string }

interface Account { user: string | null; gen: number }

interface Entry {
  token: LockToken
  op: string
  keys: string[]
  projectId: string
  label: string
  account: Account
  origin: LockOrigin
  phase: LockPhase
  sent?: Promise<unknown>
  sendSettled: boolean
  outcome?: WriteOutcome
  overdue: boolean
  record?: SentRecord
  sentAt?: number
  expiryTimer?: ReturnType<typeof setTimeout>
  verifyFn?: (signal: AbortSignal) => Promise<boolean>
  verifying: boolean
}

// ---------------------------------------------------------------------------
// 账号与会话代次：只读订阅 session 状态。info 对象换了（登录、恢复、同号重登）或进入 / 离开未登录就换代；令牌续期不调
// set()，info 不变，不换代

let gen = 0
let lastInfo: unknown
let lastAnon: boolean | undefined
let unsub: (() => void) | null = null
function syncAccount(): boolean {
  const s = getSession()
  const anon = s.status === 'anon'
  if (s.info === lastInfo && anon === lastAnon) return false
  lastInfo = s.info
  lastAnon = anon
  gen += 1
  return true
}
function watchAccount() {
  if (!unsub) unsub = subscribeSession(() => { if (syncAccount()) emit() })
}
const defaultAccount = (): Account => {
  watchAccount()
  syncAccount()
  return { user: getSession().info?.user.id ?? null, gen }
}
let accountSource: () => Account = defaultAccount
/** 当前账号（只读，可在渲染期间调用） */
export const currentAccount = (): Account => accountSource()
const sameAccount = (a: Account, b: Account) => a.user === b.user && a.gen === b.gen

// ---------------------------------------------------------------------------
// 配置（应用初始化时注入）

let ttlMs = DEFAULT_TTL_MS
let resolveProject: ((projectId: string) => LockTarget | null) | null = null
/**
 * ttlMs：有效期（最短 30 秒）。resolveProject：当前账号可见范围里按 id 同步查项目（S6a 组织范围），核对前用它确认能读；
 * 没有注入时一律按「不可见」处理（不读）
 */
export function configureWriteLock(o: { ttlMs?: number; resolveProject?: ((projectId: string) => LockTarget | null) | null }) {
  if (o.ttlMs !== undefined) ttlMs = Number.isFinite(o.ttlMs) ? Math.max(MIN_TTL_MS, o.ttlMs) : DEFAULT_TTL_MS
  if (o.resolveProject !== undefined) resolveProject = o.resolveProject
}
export const writeLockTtl = () => ttlMs

// ---------------------------------------------------------------------------

let seq = 0
let byKey = new Map<string, Entry>()
let version = 0
const subs = new Set<() => void>()
function emit() { version += 1; for (const fn of subs) { try { fn() } catch { /* 订阅者出错不影响锁 */ } } }
const rereadSubs = new Set<(e: { keys: readonly string[]; projectId: string }) => void>()
const verifiers = new Map<number, (record: StoredLock, signal: AbortSignal) => Promise<boolean>>()
const newOp = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
/** 项目的全部可用锁键：控制屏号、DTU 号、项目 id（第一个是主键） */
export function lockKeysOf(t: LockTarget): string[] {
  const out: string[] = []
  if (clean(t.controlScreenId)) out.push(`screen:${clean(t.controlScreenId)}`)
  if (clean(t.dtuId)) out.push(`dtu:${clean(t.dtuId)}`)
  out.push(`project:${t.id}`)
  return out
}
export const lockKeyOf = (t: LockTarget) => lockKeysOf(t)[0]

function ownerOf(e: Entry): LockOwner {
  const cur = currentAccount()
  if (sameAccount(cur, e.account)) return 'current'
  return cur.user !== null && cur.user === e.account.user ? 'previous-session' : 'other-account'
}
const storedOf = (e: Entry): StoredLock | null => (e.record && e.sentAt !== undefined
  ? { v: 1, op: e.op, keys: e.keys, projectId: e.projectId, userId: e.account.user, sentAt: e.sentAt, msg: e.record.msg, deviceId: e.record.deviceId, target: e.record.target }
  : null)
const verifierOf = (e: Entry): ((signal: AbortSignal) => Promise<boolean>) | undefined => {
  if (e.verifyFn) return e.verifyFn
  const rec = storedOf(e)
  const fn = rec ? verifiers.get(rec.msg) : undefined
  return fn && rec ? (signal) => fn(rec, signal) : undefined
}
const view = (e: Entry): LockInfo => {
  const owner = ownerOf(e)
  const hide = owner === 'other-account'
  return {
    key: e.token.key, keys: e.keys, projectId: hide ? '' : e.projectId, label: hide ? '' : e.label, phase: e.phase, origin: e.origin,
    sendSettled: e.sendSettled, outcome: e.outcome, overdue: e.overdue, owner, mine: owner === 'current', verifiable: !!verifierOf(e),
    verifying: e.verifying, expiresAt: e.sentAt !== undefined ? e.sentAt + ttlMs : undefined,
  }
}
const isLive = (e: Entry) => byKey.get(e.token.key) === e
const entryOf = (token: LockToken) => {
  const e = byKey.get(token.key)
  return e && e.token === token ? e : null
}

// ---------------------------------------------------------------------------
// localStorage

const storage = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }
const KEY_RE = /^(screen|dtu|project):[^\s]{1,200}$/
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/
const CRED_RE = /token|password|passwd|secret|authorization|cookie|credential/i
const scalar = (v: unknown): v is Scalar => v === null || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v))
function validTarget(t: unknown): t is { [k: string]: Scalar } {
  if (!t || typeof t !== 'object' || Array.isArray(t) || Object.getPrototypeOf(t) !== Object.prototype) return false
  const ks = Object.keys(t)
  return ks.length > 0 && ks.length <= 16 && ks.every((k) => FIELD_RE.test(k) && !CRED_RE.test(k) && scalar((t as Record<string, unknown>)[k]))
}
const validRecord = (r: SentRecord) => Number.isInteger(r.msg) && r.msg > 0 && r.msg < 100_000 && (r.deviceId === null || Number.isSafeInteger(r.deviceId)) && validTarget(r.target)

/** 结构校验（含时间合理性）：不合规、到期、sentAt 晚于现在返回 null */
export function parseStored(raw: string | null, now = Date.now()): StoredLock | null {
  if (!raw || raw.length > 4_000) return null
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const allowed = new Set(['v', 'op', 'keys', 'projectId', 'userId', 'sentAt', 'msg', 'deviceId', 'target'])
  if (Object.keys(r).some((k) => !allowed.has(k))) return null
  const str = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 200
  if (r.v !== 1 || !str(r.op) || !str(r.projectId) || !(r.userId === null || str(r.userId))) return null
  if (!Array.isArray(r.keys) || !r.keys.length || r.keys.length > 3 || !r.keys.every((k) => typeof k === 'string' && KEY_RE.test(k))) return null
  if (typeof r.sentAt !== 'number' || !Number.isFinite(r.sentAt)) return null
  if (r.sentAt > now) return null // 到期时间晚于「现在 + 有效期」：时钟异常或被改过
  if (r.sentAt + ttlMs <= now) return null // 已到期
  const rec = { msg: r.msg, deviceId: r.deviceId, target: r.target } as SentRecord
  if (!validRecord(rec)) return null
  return r as unknown as StoredLock
}

function writeStored(e: Entry) {
  const rec = storedOf(e)
  const s = storage()
  if (!rec || !s || e.origin !== 'local') return
  try { s.setItem(STORAGE_PREFIX + e.token.key, JSON.stringify(rec)) } catch (x) { console.warn('[writeLock] 写入 localStorage 失败，降级为内存锁', x) }
}
function removeStored(e: Entry) {
  const s = storage()
  // 同步来的锁是别的标签页的：不代删对方的记录
  if (!s || e.sentAt === undefined || e.origin === 'synced') return
  const k = STORAGE_PREFIX + e.token.key
  try {
    const raw = s.getItem(k)
    let op: unknown
    try { op = raw ? (JSON.parse(raw) as { op?: unknown }).op : undefined } catch { op = undefined }
    if (op === e.op) s.removeItem(k)
  } catch { /* 忽略 */ }
}

function drop(e: Entry) {
  if (!isLive(e)) return
  for (const k of e.keys) if (byKey.get(k) === e) byKey.delete(k)
  if (e.expiryTimer) clearTimeout(e.expiryTimer)
  removeStored(e)
  emit()
}

/** 到有效期：放锁、通知订阅者、发强制重读事件 */
function expire(e: Entry) {
  if (!isLive(e)) return
  drop(e)
  const ev = { keys: [...e.keys], projectId: e.projectId }
  for (const fn of rereadSubs) { try { fn(ev) } catch { /* 忽略 */ } }
}
function startExpiry(e: Entry) {
  if (e.sentAt === undefined || e.expiryTimer) return
  e.expiryTimer = setTimeout(() => expire(e), Math.max(0, e.sentAt + ttlMs - Date.now()))
}

/** 从记录恢复 / 同步一把锁（一律按结果未知，原 Promise 视为已结算） */
function adopt(rec: StoredLock, origin: 'restored' | 'synced'): Entry | null {
  if (rec.keys.some((k) => byKey.has(k))) return null
  const e: Entry = {
    token: Object.freeze({ id: ++seq, key: rec.keys[0] }), op: rec.op, keys: [...rec.keys], projectId: rec.projectId, label: '',
    account: { user: rec.userId, gen: -1 }, origin, phase: 'unknown', sendSettled: true, outcome: 'unknown', overdue: true,
    record: { msg: rec.msg, deviceId: rec.deviceId, target: rec.target }, sentAt: rec.sentAt, verifying: false,
  }
  for (const k of e.keys) byKey.set(k, e)
  startExpiry(e)
  emit()
  return e
}

function restoreFromStorage() {
  const s = storage()
  if (!s) return
  const keys: string[] = []
  try { for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(STORAGE_PREFIX)) keys.push(k) } } catch { return }
  for (const k of keys) {
    const rec = parseStored(s.getItem(k))
    if (!rec || STORAGE_PREFIX + rec.keys[0] !== k) { try { s.removeItem(k) } catch { /* 忽略 */ } continue }
    adopt(rec, 'restored')
  }
}

function onStorage(ev: StorageEvent) {
  if (!ev.key?.startsWith(STORAGE_PREFIX)) return
  const cur = byKey.get(ev.key.slice(STORAGE_PREFIX.length))
  if (ev.newValue === null) {
    // 别的标签页删除了记录：只同步删除本标签从记录得来的锁（本标签自己发起的锁按自己的状态机走）
    // 别的标签页放锁：本标签按到期处理（放锁 + 强制重读）
    if (cur && cur.origin !== 'local') expire(cur)
    return
  }
  const rec = parseStored(ev.newValue)
  if (!rec || STORAGE_PREFIX + rec.keys[0] !== ev.key) return
  if (cur) {
    if (cur.origin === 'local' || cur.op === rec.op) return
    drop(cur)
  }
  adopt(rec, 'synced')
  // 别的标签页的写可能还在路上：同步来的锁不自动核对，等对方结论（删除）或到期；页面可手动核对
}

let wiredStorage = false
function initPersistence() {
  restoreFromStorage()
  if (!wiredStorage && typeof window !== 'undefined') { window.addEventListener('storage', onStorage); wiredStorage = true }
}
initPersistence()

// ---------------------------------------------------------------------------

/** 取锁：原子占住项目的全部可用键；任一键已被占则返回 busy */
export function acquire(target: LockTarget, label = ''): { ok: true; token: LockToken } | { ok: false; busy: LockInfo } {
  const keys = lockKeysOf(target)
  for (const k of keys) {
    const cur = byKey.get(k)
    if (cur) return { ok: false, busy: view(cur) }
  }
  const token: LockToken = Object.freeze({ id: ++seq, key: keys[0] })
  const e: Entry = { token, op: newOp(), keys, projectId: target.id, label, account: currentAccount(), origin: 'local', phase: 'held', sendSettled: false, overdue: false, verifying: false }
  for (const k of keys) byKey.set(k, e)
  emit()
  return { ok: true, token }
}

/** 只读复核：持锁、还没认领、账号与代次未变 */
export function isHolder(token: LockToken): boolean {
  const e = entryOf(token)
  return !!e && e.phase === 'held' && sameAccount(e.account, currentAccount())
}

/** 给 requestWrite 的 beforeSend 同步调用：复核通过就认领（进入 sent，视为已发出）并返回 true；只能认领一次 */
export function claim(token: LockToken): boolean {
  const e = entryOf(token)
  if (!e || !isHolder(token)) return false
  e.phase = 'sent'
  emit()
  return true
}

function afterSettled(e: Entry, resolved: boolean) {
  e.sendSettled = true
  if (!isLive(e)) return
  emit()
  if (e.phase === 'held') { drop(e); return } // 没认领：必未发出
  if (e.phase === 'unknown') {
    if (resolved) { drop(e); return } // 原写迟到 success=true：生效证据
    if (verifierOf(e)) void verify(e.token.key) // 结算之后自动核对一次
    return
  }
  if (e.outcome === 'ok' || e.outcome === 'fail') drop(e)
}

/**
 * 登记原写 Promise 与核对数据（held 或已认领都可调，只认第一次）：写 localStorage、开始计有效期。
 * 写入口只在 success=true 时 resolve
 */
export function markSent(token: LockToken, sent: Promise<unknown>, record?: SentRecord): void {
  const e = entryOf(token)
  if (!e || e.sent) return
  e.sent = sent
  e.sentAt = Date.now()
  if (record && validRecord(record)) e.record = { msg: record.msg, deviceId: record.deviceId, target: { ...record.target } }
  else if (record) console.warn('[writeLock] 核对数据不合规，不落盘')
  writeStored(e)
  startExpiry(e)
  sent.then(() => afterSettled(e, true), () => afterSettled(e, false))
}

/** 记下这次写的结论（只认第一次）。未认领 → 必未发出，直接释放；已认领：ok / fail 等原写结算后释放，unknown 待核对 */
export function settle(token: LockToken, outcome: WriteOutcome): void {
  const e = entryOf(token)
  if (!e) return
  if (e.phase === 'held') { drop(e); return }
  if (e.outcome !== undefined) return
  e.outcome = outcome
  if (outcome === 'unknown') {
    e.phase = 'unknown'
    emit()
    // 原写已先结算（调用方 await 之后在 catch 里 settle）：afterSettled 当时还不是 unknown，这里补一次自动核对
    if (e.sendSettled && verifierOf(e)) void verify(e.token.key)
    return
  }
  emit()
  if (!e.sent || e.sendSettled) drop(e)
}

/** 截止时间已过：只改标记，不放锁 */
export function markOverdue(token: LockToken): void {
  const e = entryOf(token)
  if (!e || e.overdue) return
  e.overdue = true
  emit()
}

/** 登记本次的核对函数（新读成功且目标值一致返回 true；不登记则用 registerVerifier 按消息号注册的核对器） */
export function requireVerify(token: LockToken, fn: (signal: AbortSignal) => Promise<boolean>): void {
  const e = entryOf(token)
  if (!e) return
  e.verifyFn = fn
  emit()
}

/** 按消息号注册核对器（刷新恢复的锁用它重建核对）。注册时若已有该消息号、结果未知且原写已结算的锁，立刻核对一次 */
export function registerVerifier(msg: number, fn: (record: StoredLock, signal: AbortSignal) => Promise<boolean>): () => void {
  verifiers.set(msg, fn)
  for (const e of new Set(byKey.values())) {
    if (e.phase === 'unknown' && e.sendSettled && !e.verifyFn && e.record?.msg === msg && e.origin !== 'synced') void verify(e.token.key)
  }
  emit()
  return () => { if (verifiers.get(msg) === fn) verifiers.delete(msg) }
}

/** 订阅「强制重读」事件（锁到期放开时发出）；返回取消订阅 */
export function onForceReread(fn: (e: { keys: readonly string[]; projectId: string }) => void): () => void {
  rereadSubs.add(fn)
  return () => { rereadSubs.delete(fn) }
}

/**
 * 核对（页面「核对」按钮、原写结算后自动核对、注册核对器后自动核对）。见文件头口径 5
 */
export async function verify(keyOrTarget: string | LockTarget, signal?: AbortSignal): Promise<VerifyResult> {
  const e = typeof keyOrTarget === 'string' ? byKey.get(keyOrTarget) : lockKeysOf(keyOrTarget).map((k) => byKey.get(k)).find(Boolean)
  const fn = e ? verifierOf(e) : undefined
  if (e?.origin === 'synced' && e.phase === 'unknown') return 'send-pending' // 别的标签页的锁：对方的写可能还在路上，本标签不核对
  if (!e || e.phase !== 'unknown' || !fn || e.verifying) return 'none'
  if (signal?.aborted) return 'aborted'
  if (!e.sendSettled) return 'send-pending'
  // 能不能读：当前账号可见范围里有这个项目，且用当前项目对象算出的主锁键与锁的一致
  const p = resolveProject?.(e.projectId) ?? null
  if (!p || lockKeyOf(p) !== e.token.key) return 'not-visible'
  const cur = currentAccount()
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error('核对超时')) }, VERIFY_TIMEOUT_MS) })
  e.verifying = true
  emit()
  let same = false
  let err: unknown = null
  try {
    same = (await Promise.race([fn(ac.signal), timeout])) === true
  } catch (x) {
    err = x ?? new Error('核对失败')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    e.verifying = false
    if (isLive(e)) emit()
  }
  if (!sameAccount(currentAccount(), cur)) return 'account-changed'
  if (signal?.aborted) return 'aborted'
  if (err) return isApiError(err) && err.kind === 'unavailable' ? 'offline' : 'failed'
  if (!same) return 'mismatch'
  if (!isLive(e)) return 'none'
  drop(e)
  return 'released'
}

/** 主动放弃：只在还没认领（held）时，或已有确定结论（ok / fail）且原写已结算时生效 */
export function release(token: LockToken): boolean {
  const e = entryOf(token)
  if (!e) return false
  const ok = e.phase === 'held' || ((e.outcome === 'ok' || e.outcome === 'fail') && (!e.sent || e.sendSettled))
  if (!ok) return false
  drop(e)
  return true
}

/** 按任一键 / 项目（它的任一可用键）查当前锁 */
export function lockOf(keyOrTarget: string | LockTarget): LockInfo | null {
  const keys = typeof keyOrTarget === 'string' ? [keyOrTarget] : lockKeysOf(keyOrTarget)
  for (const k of keys) {
    const e = byKey.get(k)
    if (e) return view(e)
  }
  return null
}

/** 订阅锁的变化（含账号变化）；返回取消订阅 */
export function subscribe(fn: () => void): () => void {
  watchAccount()
  subs.add(fn)
  return () => { subs.delete(fn) }
}
/** 版本号：useSyncExternalStore 的快照用（lockOf 每次返回新对象，不能直接当快照） */
export const lockVersion = () => version

/** 仅供测试：清空锁、核对器与配置；换账号来源（不传恢复默认的 api/session） */
export function __resetWriteLockForTests(account?: () => Account) {
  for (const e of new Set(byKey.values())) if (e.expiryTimer) clearTimeout(e.expiryTimer)
  byKey = new Map()
  verifiers.clear()
  rereadSubs.clear()
  unsub = null
  lastInfo = undefined
  lastAnon = undefined
  accountSource = account ?? defaultAccount
  ttlMs = DEFAULT_TTL_MS
  resolveProject = null
  emit()
}
