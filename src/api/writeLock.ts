// 下发写锁（统一控制 S12、温控 S9、新风 S10 三处共用）。模块级，离开页面再回来锁仍在；已发出的锁另存 localStorage。
//
// 这把锁只防误操作（重复点、同屏并发、结果未知时再下发），不防越权；越权靠后端拦。
// 后续跨标签一致性类问题一律按「非目标，后端兜底，写幂等」处理。
//
// 口径（11/24 Chitu 定，#28 评审后由 Fable 复核定稿）：
// 1. 按控制屏加锁，并且原子锁住项目所有可用的键：控制屏号、DTU 号、项目 id。任一键已被占即 busy；lockOf 任一键命中即返回。
// 2. 发送前绑定账号：isHolder / claim 要求持锁、还没发出、账号与会话代次未变（登录、恢复、同号重登、退出换代；令牌续期不换代）。
// 3. 原写的 Promise 没结算，锁就不放（有效期到了除外，见 6）。
// 4. 下发结果口径（11/24 测试服实测后修订，Fable 裁定）：success 只表示已下发，生效只认回读一致（实测 203 返回 success=true，
//    23 秒、90 秒两次回读房间仍是关）。settle('ok') 与 settle('unknown') 一样进入待核对（outcome 记 ok 表示「已下发」），
//    原写 Promise 迟到 resolve 也只标记已结算并触发一次自动核对，不再直接放锁。结果四态（比对口径见 writeLockVerify.ts）：
//      已生效 / 未变化（指令已下发、设备状态暂未变化，不等于失败）/ 无法核对（目标房间条目缺失、回包为空、写入目标在回读里
//      没有对应字段、读数无效）/ 结果未知（回读失败：网络错误、超时、非 2xx、屏离线；或目标房间面板离线、读数不可信）。
//      逐字段判四态，整体按「结果未知 > 未变化 > 无法核对 > 已生效」（Fable 裁定 B，writeLockVerify.ts 的 verdictOf）；
//      锁上 lastVerify 记整体、lastFields 记逐字段（界面逐项列出）。只有所有目标字段都一致才放锁；其余三种都锁到核对一致
//      或有效期到期，到期走强制重读，不提前放、不续期。200 的 proto3 标量缺省 = 0 是真实读数，直接比对。
//      settle('fail')（确定没生效）不变：原写结算后放锁。只认第一次 settle。
// 5. 核对不绑定账号：谁能读谁核对，只要求读取途中账号没变（变了结果作废）。读之前先确认能读：用 resolveProject（S6a 组织范围的
//    同步查询，由应用注入）查存下的 projectId 是否在当前账号可见范围里，并用当前项目对象重算主锁键、与锁的键对上；不在或对不上
//    → 不发读请求、锁保持（not-visible）。不看 ctrl 响应判断能不能读（屏离线和 id 非法都是 503）。读到 503 → offline（屏离线，
//    可重试，锁保持）。核对晚于原写结算：原写未结算时直接 send-pending；结算后若有核对方式，自动核对一次。
//    传入已中止的 signal 直接返回；核对有超时（VERIFY_TIMEOUT_MS），超时后 verifying 复位、锁保留。
//    读到的结果只是候选：经 commitRead 统一提交（校验读取开始时的账号、锁 token、有效期，任一项对不上就丢弃）。页面自己的回读
//    （统一控制下发后的第一次回读）也先 beginRead 取凭据、读完走 commitRead，和 verify 同一条提交路径。
// 6. 有效期：从登记（markSent）起算，含写入口等待令牌续期的时间；默认 2 分钟，可配置、最短 30 秒（不宜配到 60 秒以下：
//    写 12 秒 + 续期 12 秒 + 回读核对都要在有效期内完成）；刷新和核对失败都不续期。到期放锁、通知订阅者，并发出
//    「强制重读」事件（onForceReread），让页面重读设备状态。截止时间（markOverdue）只改标记，不放锁。
//    自动重新核对：原写结算后的首次自动核对若不是一致（未变化、无法核对、读取失败、屏离线、不可见），按 RETRY_DELAYS_MS（5 秒、
//    20 秒、60 秒）退避再核对，不超过有效期（到期前来不及的不排）。退避到点遇到手动核对进行中：等那次的结果，仍不一致就继续剩余
//    退避；手动核对一致照旧放锁并取消定时器。延迟执行可能越过有效期：退避回调执行时、核对发起前与接受结果前都用当前时间对绝对
//    到期时间再检查，已到期一律走 expire()（只放一次锁、只发一次强制重读），不发起也不接受核对。
//    界面口径（11/25 赤兔定）：锁视图的 settling（只读派生，不影响放锁与退避）= 原写已结算、结论尚非已生效、自动退避还有剩余
//    次数且来得及（或正在核对、退避定时器在等），并且没到期；一致但被否决（lastVetoed）也算。settling 期间界面只显示「正在核对…」，
//    不报未变化 / 无法核对 / 结果未知；退避都用完（或来不及再排）、到期时才按最近一次结论显示四态。锁怎么结束的（一致放开 / 到期）
//    另记在 endOf(主锁键)（带到期时间认是哪一把，以及结束时最近一次核对的结论），供一次性结果卡片（统一控制）在锁放开后改显示。
//    核对证据（evidence，#66 赤兔定）：核对函数在读取时可用 attachEvidence(signal, 读数) 给这次核对挂一份不透明的读数，写锁不解读它。
//    只有这次核对被写锁收下（commitRead 通过、记入 lastVerify / lastFields，或一致放锁）时才随结论一起存到锁上（lastEvidence），
//    放锁时随 endOf 一并记下；迟到、超时、换账号、读失败的核对不留证据，读到一致但在提交时被否决（lastVetoed，按未变化记）的
//    也不留；中止不改上次的结论与证据。页面按它重算展示，保证与 lastVerify 对得上。只有当前账号（mine）的锁视图 / 结束记录带证据；
//    会话代次一变（换账号、登出、重登），所有锁上和结束记录里的证据一律清空；结束记录本身（怎么结束、到期时间、最后结论）保留，
//    同一用户重登后结果卡片仍能按它定结论。
// 7. 持久化：markSent 时就写 localStorage（键 = STORAGE_PREFIX + 主锁键），放锁时删（核对一致、确定失败、未认领、到期）；刷新后读到的记录一律按「结果未知」
//    恢复（原 Promise 已不存在，视为已结算），靠 registerVerifier(消息号, fn) 注册的核对器重建核对，注册时若已有该消息号的锁就立刻
//    核对一次。记录只存：锁键、projectId、消息号、设备 id、目标字段与值、206 的目标房间 id 集合、userId、sentAt（不存 label、项目名、
//    令牌或任何凭据）；
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
//    held（还没发出）── 接入方异常路径 release(token)；漏调时 HELD_TTL_MS（30 秒）到期自动释放（#29）
//      │ beforeSend 里同步 claim(token)：持锁、held、账号与代次未变 → 进入 sent，返回 true
//      │ 没认领就结束（beforeSend 没调 / 返回 false / 抛错 / 发送前失败）：settle 或登记的 Promise 结算 → 释放、删记录
//      ▼
//    sent ── markSent(token, promise, 记录) 登记原写 Promise、写 localStorage、开始计有效期
//      │ settle(fail)：等原 Promise 结算后释放、删记录（确定没生效）
//      │ settle(ok | unknown) ──► unknown（待核对；ok 记为「已下发」；只认第一次 settle）
//      ▼
//    unknown（待核对）── 原 Promise 结算（不论 resolve / reject）：只标记已结算，自动核对一次
//      │ verify：原写未结算 → send-pending；能读（可见 + 键对上）才读；
//      │   一致 → 已生效，释放 / 不一致（mismatch）、无法核对（unverifiable）、失败、503、超时 → 保持
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
import { isSendableMode } from './values'
import { isNoChange } from './writeLockVerify'

/** 一次核对的最长时间 */
export const VERIFY_TIMEOUT_MS = 15_000
/** 有效期：默认 2 分钟，最短 30 秒 */
export const DEFAULT_TTL_MS = 2 * 60_000
export const MIN_TTL_MS = 30_000
/** 取锁后还没认领、也没登记发出（held）时的有效期：接入方在 acquire 之后出错又没 release，最多卡这么久（#29） */
export const HELD_TTL_MS = 30_000
/** 自动核对未变化 / 无法核对时的退避再核对间隔 */
export const RETRY_DELAYS_MS = [5_000, 20_000, 60_000] as const
export const STORAGE_PREFIX = 'hjc-write-lock:'
/** 206 目标房间集合的上限（超过的在发送前由 checkSentRecord 拒绝，不会发出后才降级为内存锁） */
export const ROOM_IDS_MAX = 512
/** 一条持久化记录的最大长度（ROOM_IDS_MAX 个安全整数也放得下） */
const STORED_MAX_CHARS = 16_000
/** 别的账号发起、本账号核对不了（或不该看到细节）时的提示 */
export const OTHER_ACCOUNT_TEXT = '上一账号的下发结果未知，请稍后再试或联系有权限的账号'

export type LockPhase = 'held' | 'sent' | 'unknown'
export type LockOrigin = 'local' | 'restored' | 'synced'
export type WriteOutcome = 'ok' | 'fail' | 'unknown'
export type VerifyResult = 'released' | 'send-pending' | 'mismatch' | 'unverifiable' | 'failed' | 'offline' | 'not-visible' | 'account-changed' | 'aborted' | 'expired' | 'none'
/** 核对函数的返回：一致 true / 不一致 false / 无法核对 'unverifiable'（目标房间缺失、回包为空、写入目标没有回读字段）；回读失败请抛错 */
export type MatchResult = boolean | 'unverifiable' | MatchDetail
/** 逐字段四态：已生效 / 未变化 / 无法核对 / 结果未知 */
export type FieldResult = 'applied' | 'unchanged' | 'unverifiable' | 'unknown'
/** 带逐字段结果的核对结论（writeLockVerify.ts 的比对函数返回它）；verdict 为整体结论，只有 applied 才放锁 */
export interface MatchDetail { verdict: FieldResult; fields: Record<string, FieldResult> }
/**
 * 核对函数的返回：MatchResult，或带「提交」的候选结果（#33）。commit 返回 false 表示在提交这一刻否决（Fable 裁定）：一致也不放锁，
 * 记为未变化、走退避重核。commit 只在写锁确认这次核对仍然有效（锁没换、没超时、没取消、
 * 账号没变）之后才调，调用方据此提交逐字段的结束状态；无效的核对（迟到、超时、换账号）不提交
 */
export type VerifyOutcome = MatchResult | { same: boolean; commit: () => void | false }
export type VerifyFn = (signal: AbortSignal) => Promise<VerifyOutcome>
export type LockOwner = 'current' | 'previous-session' | 'other-account'

/** 加锁目标：S6a 的 Project 可以直接传 */
export interface LockTarget { id: string; controlScreenId?: string; dtuId?: string }

export type Scalar = string | number | boolean | null
/**
 * markSent 时要持久化的核对数据：消息号、设备 id、目标字段与值；roomIds 为 206（全部房间开关）确认后预检读到的目标房间 id 集合，
 * 核对时逐个检查这些房间（回包里缺了的按无法核对）。206 必须给（最多 ROOM_IDS_MAX 个），发送前用 checkSentRecord 检查
 */
export interface SentRecord { msg: number; deviceId: number | null; target: { [field: string]: Scalar }; roomIds?: number[] }
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
  /** 写的结论：ok = 已下发（仍待核对）；unknown = 结果未知 */
  outcome?: WriteOutcome
  /** 最近一次核对的结果（界面据此显示：未变化 / 结果未知 / 无法核对） */
  lastVerify?: VerifyResult
  /** 最近一次核对的逐字段结果（界面逐项列出；整体结论只作标题）。回读失败时每个目标字段都是 unknown */
  lastFields?: Record<string, FieldResult>
  /** 最近一次核对读到一致、但在提交这一刻被核对方否决（Fable 裁定；lastVerify 记 mismatch）：界面仍按「正在核对」显示。下一次核对开始时清掉 */
  lastVetoed?: boolean
  /**
   * 还在自动核对中（只读派生，见文件头口径 6）：原写已结算、结论尚非已生效、自动退避还有剩余次数且来得及（或正在核对 / 退避在等）、
   * 没到期；lastVetoed 也算。为 true 时界面只显示「正在核对…」，不报四态结论
   */
  settling: boolean
  overdue: boolean
  owner: LockOwner
  mine: boolean
  verifiable: boolean
  verifying: boolean
  /** 有效期到期时间（已发出才有） */
  expiresAt?: number
  /** 写锁最后收下的那次核对挂的读数（attachEvidence，不透明）；只有当前账号的视图带，会话代次变了即清空 */
  lastEvidence?: unknown
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
  /** held 阶段的有效期定时器（claim 或 markSent 时清掉） */
  heldTimer?: ReturnType<typeof setTimeout>
  /** 自动再核对的定时器与已排次数 */
  retryTimer?: ReturnType<typeof setTimeout>
  retries: number
  /** 进行中的那次核对（自动退避遇到手动核对进行中时等它的结果） */
  inflight?: Promise<VerifyResult>
  verifyFn?: VerifyFn
  verifying: boolean
  lastVerify?: VerifyResult
  lastFields?: Record<string, FieldResult>
  lastVetoed?: boolean
  /** 随 lastVerify 一起收下的核对证据（见文件头口径 6） */
  evidence?: unknown
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
  if (!unsub) unsub = subscribeSession(() => { if (syncAccount()) { sweepSession(); emit() } })
}
const defaultAccount = (): Account => {
  watchAccount()
  syncAccount()
  return { user: getSession().info?.user.id ?? null, gen }
}
let accountSource: () => Account = defaultAccount
/** 当前账号（只读，可在渲染期间调用） */
export const currentAccount = (): Account => accountSource()
export const sameAccount = (a: Account, b: Account) => a.user === b.user && a.gen === b.gen

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
const verifiers = new Map<number, (record: StoredLock, signal: AbortSignal) => Promise<VerifyOutcome>>()
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
  ? { v: 1, op: e.op, keys: e.keys, projectId: e.projectId, userId: e.account.user, sentAt: e.sentAt, msg: e.record.msg, deviceId: e.record.deviceId, target: e.record.target, ...(e.record.roomIds ? { roomIds: e.record.roomIds } : {}) }
  : null)
const verifierOf = (e: Entry): VerifyFn | undefined => {
  if (e.verifyFn) return e.verifyFn
  const rec = storedOf(e)
  const fn = rec ? verifiers.get(rec.msg) : undefined
  return fn && rec ? (signal) => fn(rec, signal) : undefined
}
/** 见 LockInfo.settling。退避的「来得及」与 autoVerify 排下一次的条件相同（Date.now() + 间隔 < 到期时间） */
function settlingOf(e: Entry): boolean {
  if (e.phase !== 'unknown' || !e.sendSettled || e.origin === 'synced' || !verifierOf(e) || isExpired(e)) return false
  if (e.lastVetoed || e.verifying || e.retryTimer) return true
  const delay = RETRY_DELAYS_MS[e.retries]
  return delay !== undefined && (e.sentAt === undefined || Date.now() + delay < e.sentAt + ttlMs)
}
const view = (e: Entry): LockInfo => {
  sweepSession()
  const owner = ownerOf(e)
  const hide = owner === 'other-account'
  return {
    key: e.token.key, keys: e.keys, projectId: hide ? '' : e.projectId, label: hide ? '' : e.label, phase: e.phase, origin: e.origin,
    sendSettled: e.sendSettled, outcome: e.outcome, lastVerify: e.lastVerify, lastFields: hide ? undefined : e.lastFields, lastVetoed: e.lastVetoed === true, settling: settlingOf(e), overdue: e.overdue, owner, mine: owner === 'current', verifiable: !!verifierOf(e),
    verifying: e.verifying, expiresAt: e.sentAt !== undefined ? e.sentAt + ttlMs : undefined,
    ...(owner === 'current' && e.evidence !== undefined ? { lastEvidence: e.evidence } : {}),
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
const validRoomIds = (v: unknown) => v === undefined || (Array.isArray(v) && v.length > 0 && v.length <= ROOM_IDS_MAX && v.every((n) => Number.isSafeInteger(n)))
const validRecord = (r: SentRecord) => Number.isInteger(r.msg) && r.msg > 0 && r.msg < 100_000 && (r.deviceId === null || Number.isSafeInteger(r.deviceId)) && validTarget(r.target) && validRoomIds(r.roomIds)
const copyRecord = (r: SentRecord): SentRecord => ({ msg: r.msg, deviceId: r.deviceId, target: { ...r.target }, ...(r.roomIds ? { roomIds: [...r.roomIds] } : {}) })

/**
 * 204 的核对目标（只放用户改了的字段，其余 -1）：只认 5 个字段名，每个值都是有限数；至少改一项；枚举字段只能是合法取值。
 * 核对数据里的 -1 表示「没改」（204 全是数值字段，不变传 -1）；210 读到 -1 的那一项不能设置，由 writeLockVerify.ts 的 settable204 / blocked204 判断
 */
/** 正整数设备 id（204 的下发、核对、读数检查共用这一个判断） */
export const isDeviceId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const FIELDS_204 = new Set(['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch'])
/**
 * 204 设定值的合法范围（docs/plan-s10-s7.md A3：露点 8–16°C、湿度 35–70%，后端给范围前按这个）。
 * 65536（未初始化）、-100（无效数据）以及范围外的值一律拒绝；-1 是「不变」，不在这里检查
 */
export const SETPOINT_RANGE_204: Readonly<Record<string, { min: number; max: number }>> = Object.freeze({ dewPoint: { min: 8, max: 16 }, humiditySet: { min: 35, max: 70 } })
function check204Target(t: SentRecord['target']): string | null {
  const ENUM: Record<string, readonly number[]> = { controlType: [0, 1], windSpeed: [0, 1, 2], switch: [0, 1] }
  const entries = Object.entries(t)
  // 只认 204 的五个字段：拼错的键既不能算改动，也不能绕过取值检查
  if (entries.some(([k]) => !FIELDS_204.has(k))) return '核对数据不合规，未下发'
  const changed = entries.filter(([, v]) => v !== -1)
  if (!changed.length) return '没有要下发的改动，未下发'
  // 每个值都必须是数字：-1（没改）或合法取值
  if (entries.some(([, v]) => typeof v !== 'number' || !Number.isFinite(v))) return '核对数据不合规，未下发'
  for (const [k, v] of changed) {
    if (ENUM[k] && !ENUM[k].includes(v as number)) return '核对数据不合规，未下发'
    const r = SETPOINT_RANGE_204[k]
    if (r && ((v as number) < r.min || (v as number) > r.max)) return '设定值不在合法范围内，未下发'
  }
  return null
}

/**
 * 发送前检查核对数据（在 requestWrite 之前调用）：返回 null = 可以登记；否则返回给用户看的原因，调用方应 release(token)、
 * 提示该原因、不发送。204 设备 id 必须是正整数、核对目标见 check204Target；206 必须带非空的目标房间集合，且不超过 ROOM_IDS_MAX 个；其余按落盘的结构校验
 */
export function checkSentRecord(r: SentRecord): string | null {
  if (r.msg === 204) {
    // 204 按设备下发、按设备回读 210：没有可信的设备 id 就无法核对，也不该发
    if (!isDeviceId(r.deviceId)) return '没有读到新风设备 id，无法核对下发结果，未下发'
    const bad = check204Target(r.target)
    if (bad) return bad
  }
  // 203 运行模式是枚举 OperatingMode：不变是 0（OPERATION_MODE_NONE），枚举里没有 -1（11/25 传 -1：后端报 unknown enum、504、没执行）→ -1 拒发
  if (r.msg === 203 && r.target.systemMode === -1) return '运行模式为 -1（枚举里没有 -1，不变应传 0），未下发'
  // 其他枚举外的值（1、7、-2 等）同样不发：只有 0（不变）和界面可选的模式（values.ts OPERATING_MODES）
  if (r.msg === 203 && !isSendableMode(r.target.systemMode)) return `运行模式 ${String(r.target.systemMode)} 不是可选的模式，未下发`
  if (r.msg === 206) {
    if (!Array.isArray(r.roomIds) || !r.roomIds.length) return '没有读到目标房间，无法核对下发结果，未下发'
    if (r.roomIds.length > ROOM_IDS_MAX) return `目标房间超过 ${ROOM_IDS_MAX} 个，无法记录核对数据，未下发`
  }
  return validRecord(r) ? null : '核对数据不合规，未下发'
}

/** 结构校验（含时间合理性）：不合规、到期、sentAt 晚于现在返回 null */
export function parseStored(raw: string | null, now = Date.now()): StoredLock | null {
  if (!raw || raw.length > STORED_MAX_CHARS) return null
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const allowed = new Set(['v', 'op', 'keys', 'projectId', 'userId', 'sentAt', 'msg', 'deviceId', 'target', 'roomIds'])
  if (Object.keys(r).some((k) => !allowed.has(k))) return null
  const str = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 200
  if (r.v !== 1 || !str(r.op) || !str(r.projectId) || !(r.userId === null || str(r.userId))) return null
  if (!Array.isArray(r.keys) || !r.keys.length || r.keys.length > 3 || !r.keys.every((k) => typeof k === 'string' && KEY_RE.test(k))) return null
  if (typeof r.sentAt !== 'number' || !Number.isFinite(r.sentAt)) return null
  if (r.sentAt > now) return null // 到期时间晚于「现在 + 有效期」：时钟异常或被改过
  if (r.sentAt + ttlMs <= now) return null // 已到期
  const rec = { msg: r.msg, deviceId: r.deviceId, target: r.target, ...(r.roomIds !== undefined ? { roomIds: r.roomIds } : {}) } as SentRecord
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

/** 锁怎么结束的：applied = 核对一致放开；expired = 到期；other = 确定失败、没认领、主动放弃等。按主锁键只留最近一条 */
export type LockEnd = 'applied' | 'expired' | 'other'
/**
 * 结束记录：到期时间（发出时间 + 有效期，用来认是哪一把）、结束方式、结束时最近一次核对的结论；
 * lastEvidence = 结束时锁上最后收下的核对证据（只给这把锁所属的当前账号）
 */
export interface LockEndInfo { expiresAt: number; how: LockEnd; lastVerify?: VerifyResult; lastFields?: Record<string, FieldResult>; lastEvidence?: unknown }
interface EndRecord { info: LockEndInfo; account: Account; evidence?: unknown }
let ends = new Map<string, EndRecord>()

// 会话代次变化（换账号、登出、重登）：清空结束记录里与所有锁上的核对证据（结束记录本身保留）。读取方（view / endOf）和写入方
// （drop、收下核对）先调它，所以不依赖订阅回调的时机；默认账号来源的 session 订阅里也调一次
let sweptFor: Account | null = null
function sweepSession() {
  const cur = currentAccount()
  if (sweptFor && sameAccount(sweptFor, cur)) return
  if (sweptFor) {
    for (const r of ends.values()) r.evidence = undefined
    for (const e of byKey.values()) e.evidence = undefined
  }
  sweptFor = cur
}

/** 主锁键上最近结束的那把锁；没有返回 null */
export function endOf(key: string): LockEndInfo | null {
  sweepSession()
  const r = ends.get(key)
  if (!r) return null
  return sameAccount(r.account, currentAccount()) && r.evidence !== undefined ? { ...r.info, lastEvidence: r.evidence } : { ...r.info }
}

/** 核对进行中、可以挂证据的信号（runVerify 交给核对函数的那个）→ 这次核对挂上的证据 */
const pendingEvidence = new WeakMap<AbortSignal, { value?: unknown }>()
/**
 * 核对函数读到数据时调用：把读数作为这次核对的证据挂上（后挂的覆盖先挂的）。signal 必须是写锁交给核对函数的那个；
 * 别的信号（页面自己的回读等）、这次核对已经结束（迟到、超时）一律忽略。证据只在写锁收下这次核对时才保存
 */
export function attachEvidence(signal: AbortSignal | undefined, evidence: unknown): void {
  const slot = signal ? pendingEvidence.get(signal) : undefined
  if (slot) slot.value = evidence
}

function drop(e: Entry, how: LockEnd = 'other') {
  if (!isLive(e)) return
  sweepSession()
  if (e.sentAt !== undefined) {
    ends.set(e.token.key, { info: { expiresAt: e.sentAt + ttlMs, how, lastVerify: e.lastVerify, lastFields: e.lastFields }, account: e.account, ...(e.evidence !== undefined ? { evidence: e.evidence } : {}) })
  }
  for (const k of e.keys) if (byKey.get(k) === e) byKey.delete(k)
  if (e.expiryTimer) clearTimeout(e.expiryTimer)
  if (e.heldTimer) clearTimeout(e.heldTimer)
  if (e.retryTimer) clearTimeout(e.retryTimer)
  removeStored(e)
  emit()
}

/** 回读失败时的逐字段结果：核对数据里每个改了的字段都是结果未知（没有核对数据时为空） */
function unknownFields(e: Entry): Record<string, FieldResult> | undefined {
  if (!e.record) return undefined
  const out: Record<string, FieldResult> = {}
  for (const [k, v] of Object.entries(e.record.target)) if (!isNoChange(e.record.msg, k, v)) out[k] = 'unknown'
  return out
}

/** 按当前时间判断是否已过有效期（不依赖到期定时器是否已执行） */
const isExpired = (e: Entry) => e.sentAt !== undefined && Date.now() >= e.sentAt + ttlMs

/** 到有效期：放锁、通知订阅者、发强制重读事件 */
function expire(e: Entry) {
  if (!isLive(e)) return
  drop(e, 'expired')
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
    record: copyRecord(rec), sentAt: rec.sentAt, verifying: false, retries: 0,
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
  const e: Entry = { token, op: newOp(), keys, projectId: target.id, label, account: currentAccount(), origin: 'local', phase: 'held', sendSettled: false, overdue: false, verifying: false, retries: 0 }
  for (const k of keys) byKey.set(k, e)
  // held 有效期：到期仍未认领、未登记发出 → 自动释放并通知订阅者（必未发出，不发强制重读）
  e.heldTimer = setTimeout(() => { if (e.phase === 'held' && !e.sent) drop(e) }, HELD_TTL_MS)
  emit()
  return { ok: true, token }
}
const stopHeldTimer = (e: Entry) => { if (e.heldTimer) { clearTimeout(e.heldTimer); e.heldTimer = undefined } }

/** 只读复核：持锁、还没认领、账号与代次未变 */
export function isHolder(token: LockToken): boolean {
  const e = entryOf(token)
  return !!e && e.phase === 'held' && sameAccount(e.account, currentAccount())
}

/** 给 requestWrite 的 beforeSend 同步调用：复核通过就认领（进入 sent，视为已发出）并返回 true；只能认领一次 */
export function claim(token: LockToken): boolean {
  const e = entryOf(token)
  if (!e || !isHolder(token)) return false
  stopHeldTimer(e)
  e.phase = 'sent'
  emit()
  return true
}

/** 自动退避再核对的结果：这些都还不是一致，按节奏继续 */
const RETRYABLE = new Set<VerifyResult>(['mismatch', 'unverifiable', 'failed', 'offline', 'not-visible', 'aborted', 'account-changed'])

/**
 * 自动核对：原写结算后（或注册核对器时）核对一次；不一致按 RETRY_DELAYS_MS 退避再核对，不超过有效期。
 * 到点遇到手动核对进行中：等它的结果再决定是否继续
 */
function autoVerify(e: Entry) {
  if (!isLive(e)) return
  if (isExpired(e)) { expire(e); return }
  const running = e.inflight
  void (running ?? verify(e.token.key)).then((r) => {
    if (!isLive(e)) return
    if (isExpired(e)) { expire(e); return }
    if (!RETRYABLE.has(r)) return
    const delay = RETRY_DELAYS_MS[e.retries]
    if (e.retryTimer) return
    // 退避用完 / 到期前来不及（交给到期）：不再排，通知订阅者（settling 结束，界面改显示最近一次结论）
    if (delay === undefined || (e.sentAt !== undefined && Date.now() + delay >= e.sentAt + ttlMs)) { emit(); return }
    e.retries += 1
    e.retryTimer = setTimeout(() => { e.retryTimer = undefined; autoVerify(e) }, delay)
  })
}

function afterSettled(e: Entry) {
  e.sendSettled = true
  if (!isLive(e)) return
  emit()
  if (e.phase === 'held') { drop(e); return } // 没认领：必未发出
  // 待核对（含已下发）：原写结算（resolve 也只算已下发）后自动核对一次
  if (e.phase === 'unknown') { if (verifierOf(e)) autoVerify(e); return }
  if (e.outcome === 'fail') drop(e)
}

/**
 * 登记原写 Promise 与核对数据（held 或已认领都可调，只认第一次）：写 localStorage、开始计有效期。
 * 写入口只在 success=true 时 resolve
 */
export function markSent(token: LockToken, sent: Promise<unknown>, record?: SentRecord): void {
  const e = entryOf(token)
  if (!e || e.sent) return
  stopHeldTimer(e)
  e.sent = sent
  e.sentAt = Date.now()
  // 指令已发出：空的目标房间集合规范成"缺失"，照常落盘（核对按无法核对），不能因此只剩内存锁
  if (record && Array.isArray(record.roomIds) && record.roomIds.length === 0) {
    const { roomIds: _empty, ...rest } = record
    record = rest
  }
  if (record && validRecord(record)) {
    e.record = copyRecord(record)
    // 206 漏传目标房间集合（接入应先用 checkSentRecord 拒绝）：照常落盘与锁住，核对一律按无法核对，锁到有效期
    if (record.msg === 206 && !record.roomIds?.length) console.warn('[writeLock] 206 缺少目标房间集合，核对将按无法核对处理')
  } else if (record) console.warn('[writeLock] 核对数据不合规，不落盘')
  writeStored(e)
  startExpiry(e)
  sent.then(() => afterSettled(e), () => afterSettled(e))
}

/**
 * 记下这次写的结论（只认第一次）。未认领 → 必未发出，直接释放；已认领：fail（确定没生效）等原写结算后释放；
 * ok（success，只算已下发）与 unknown 一样进入待核对，核对一致才放锁
 */
export function settle(token: LockToken, outcome: WriteOutcome): void {
  const e = entryOf(token)
  if (!e) return
  if (e.phase === 'held') { drop(e); return }
  if (e.outcome !== undefined) return
  e.outcome = outcome
  if (outcome === 'ok' || outcome === 'unknown') {
    e.phase = 'unknown'
    if (!e.sent) e.sendSettled = true // 没登记原写：没有要等的
    emit()
    // 原写已先结算（调用方 await 之后再 settle）：afterSettled 当时还不是待核对，这里补一次自动核对
    if (e.sendSettled && verifierOf(e)) autoVerify(e)
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

/**
 * 登记本次的核对函数（新读成功且目标值一致返回 true，不一致 false，无法核对返回 'unverifiable'，读取失败抛错；
 * 不登记则用 registerVerifier 按消息号注册的核对器）
 */
export function requireVerify(token: LockToken, fn: VerifyFn): void {
  const e = entryOf(token)
  if (!e) return
  e.verifyFn = fn
  emit()
}

/**
 * 读取凭据：读之前取，记下锁 token 与读取开始时的账号。读完只产出候选结果，交给 commitRead 统一提交。
 * 锁的 verify 与页面自己的回读（如统一控制下发后的第一次回读）走同一条提交路径
 */
export interface ReadTicket { readonly token: LockToken; readonly account: Account }

/** 开始一次读取：锁仍由这个 token 持有、且已发出（sent / unknown）才给凭据，否则返回 null（读到什么都不提交） */
export function beginRead(token: LockToken): ReadTicket | null {
  const e = entryOf(token)
  if (!e || (e.phase !== 'sent' && e.phase !== 'unknown')) return null
  return Object.freeze({ token, account: currentAccount() })
}

/** 这次读取还有效：锁没换（token 仍持有）、没取消、没过有效期、读取途中账号没变（Fable：读取途中账号变了，这次读取作废） */
function readValid(ticket: ReadTicket, signal?: AbortSignal): boolean {
  const e = entryOf(ticket.token)
  if (!e || signal?.aborted) return false
  if (e.sentAt !== undefined && Date.now() >= e.sentAt + ttlMs) return false
  return sameAccount(currentAccount(), ticket.account)
}

/** token 仍持有这把锁（没放、没被换成别的锁） */
export function holds(token: LockToken): boolean { return !!entryOf(token) }

/** 提交一次读取的候选结果：凭据仍有效才调 commit 并返回 true；任何一项对不上就丢弃（不调 commit），返回 false */
export function commitRead(ticket: ReadTicket | null | undefined, commit: () => void, signal?: AbortSignal): boolean {
  if (!ticket || !readValid(ticket, signal)) return false
  try { commit() } catch { /* 提交失败不影响锁 */ }
  return true
}

/** 按消息号注册核对器（刷新恢复的锁用它重建核对）。注册时若已有该消息号、结果未知且原写已结算的锁，立刻核对一次 */
export function registerVerifier(msg: number, fn: (record: StoredLock, signal: AbortSignal) => Promise<VerifyOutcome>): () => void {
  verifiers.set(msg, fn)
  for (const e of new Set(byKey.values())) {
    if (e.phase === 'unknown' && e.sendSettled && !e.verifyFn && e.record?.msg === msg && e.origin !== 'synced') autoVerify(e)
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
  if (isExpired(e)) { expire(e); return 'expired' } // 已过有效期：不发起核对
  if (signal?.aborted) return 'aborted'
  if (!e.sendSettled) return 'send-pending'
  // 能不能读：当前账号可见范围里有这个项目，且用当前项目对象算出的主锁键与锁的一致
  const p = resolveProject?.(e.projectId) ?? null
  if (!p || lockKeyOf(p) !== e.token.key) return 'not-visible'
  const run = runVerify(e, fn, signal)
  e.inflight = run
  try { return await run } finally { if (e.inflight === run) e.inflight = undefined }
}

async function runVerify(e: Entry, fn: VerifyFn, signal?: AbortSignal): Promise<VerifyResult> {
  // 读取凭据（与页面回读同一套，见 beginRead / commitRead）：记下锁 token 与读取开始时的账号
  const ticket: ReadTicket = { token: e.token, account: currentAccount() }
  const ac = new AbortController()
  const slot: { value?: unknown } = {}
  pendingEvidence.set(ac.signal, slot)
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error('核对超时')) }, VERIFY_TIMEOUT_MS) })
  e.verifying = true
  e.lastVetoed = false
  emit()
  let same: FieldResult = 'unchanged'
  let fields: Record<string, FieldResult> | undefined
  let commit: (() => void | false) | undefined
  let err: unknown = null
  try {
    const r = await Promise.race([fn(ac.signal), timeout])
    if (r && typeof r === 'object' && 'commit' in r) { same = r.same ? 'applied' : 'unchanged'; commit = r.commit }
    else if (r && typeof r === 'object') { same = r.verdict; fields = { ...r.fields } }
    else same = r === 'unverifiable' ? 'unverifiable' : r === true ? 'applied' : 'unchanged'
  } catch (x) {
    err = x ?? new Error('核对失败')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // 这次核对结束：之后（迟到）挂的证据一律不收
    pendingEvidence.delete(ac.signal)
    e.verifying = false
    if (isLive(e)) emit()
  }
  // 只有整体为已生效（所有目标字段都一致）才放锁
  const result: VerifyResult = !sameAccount(currentAccount(), ticket.account) ? 'account-changed'
    : signal?.aborted ? 'aborted'
    // 超时会先中止内部信号再报错：核对函数若一收到中止就同步返回结果，可能先于超时错误胜出。中止过的一律作废（#33）
    : ac.signal.aborted && !err ? 'failed'
    : err ? (isApiError(err) && err.kind === 'unavailable' ? 'offline' : 'failed')
    : same === 'unknown' ? 'failed'
    : same === 'unchanged' ? 'mismatch'
    : same === 'unverifiable' ? 'unverifiable'
    : 'released'
  if (!isLive(e)) return result === 'released' ? 'none' : result
  if (isExpired(e)) { expire(e); return 'expired' } // 读取期间过了有效期：不接受核对结果
  // 这次核对没出错、没中止：候选结果经 commitRead 提交（与页面回读同一条路径：锁没换、没过有效期、账号没变才提交），再按结论放锁
  // commit 返回 false = 核对方在提交这一刻否决（Fable 裁定：如读数已被更新的读取取代）：不放锁，按未变化记下，走原有退避重核
  let vetoed = false
  const valid = result !== 'account-changed' && result !== 'aborted' && !err && !ac.signal.aborted
    && commitRead(ticket, () => { if (commit?.() === false) vetoed = true }, signal)
  // 证据随结论一起收下（见文件头口径 6）：只有这次核对被收下才保存；被否决的按未变化记、不留证据
  sweepSession()
  if (result === 'released' && valid && vetoed) {
    e.lastVerify = 'mismatch'
    e.lastFields = unknownFields(e)
    e.lastVetoed = true
    e.evidence = undefined
    emit()
    return 'mismatch'
  }
  if (result === 'released') { if (!valid) return 'none'; e.evidence = slot.value; drop(e, 'applied'); return result }
  // 未变化 / 无法核对 / 结果未知：锁保持到核对一致或有效期到期（不续期）
  if (result !== 'aborted') {
    e.lastVerify = result
    // 回读失败或读取途中换号：核对器返回的逐字段结果作废，每个改了的目标字段都记为结果未知（中止不更新上次结论）
    e.lastFields = valid ? fields : unknownFields(e)
    e.evidence = valid ? slot.value : undefined
    emit()
  }
  return result
}

/**
 * 主动放弃：只在还没认领（held）时，或结论是 fail（确定没生效）且原写已结算时生效；已下发 / 结果未知都要核对一致或到期。
 * 接入方的异常路径必须 release：acquire 之后、claim / markSent 之前出错（组装失败、确认被取消、预检不通过等）要调
 * release(token)；漏调时 held 锁最多占 HELD_TTL_MS（30 秒）后自动释放（#29）
 */
export function release(token: LockToken): boolean {
  const e = entryOf(token)
  if (!e) return false
  const ok = e.phase === 'held' || (e.outcome === 'fail' && (!e.sent || e.sendSettled))
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
  for (const e of new Set(byKey.values())) { if (e.expiryTimer) clearTimeout(e.expiryTimer); if (e.heldTimer) clearTimeout(e.heldTimer); if (e.retryTimer) clearTimeout(e.retryTimer) }
  byKey = new Map()
  ends = new Map()
  sweptFor = null
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
