// 统一控制页面（S12b）：对同一集成项目里选中的多个项目，逐个走 S12a 的单项目状态机（ctrl 203）。
//
// - prepare(ids, draft)：为每个项目建一个控制器并 request(draft)（逐个校验：离线、app_code、温度范围、无改动…）。
//   任一项目校验不过就整体不下发，全部 cancel，返回错误；全部通过则停在 confirming，等页面的二次确认。
// - start()：二次确认通过后按顺序逐个 confirm()（下发前读 → 203 → 下发后读），一个结束再下一个；不重试。
// - cancel()：确认弹窗取消或失效 → 全部 cancel。
// - abort()：页面卸载 → 还没发出的全部终止（S12a abort 语义：已发出的照常走完回读），不再开始后面的项目。
// - 写入口：控制器给出的 {id, code} 先在最新项目列表里找回整个 Project，id 与 code 都对得上才把 Project 交给写入口；
//   对不上（项目被移除或 code 变了）按本地拦截处理（write_blocked，肯定没发出）。
// - 写锁（src/api/writeLock.ts，接入见 lock.ts）：每个项目发送前 acquire（同一块控制屏 / DTU / 项目被占 → 不发，提示「上一条下发还在
//   处理中」）；beforeSend 链里 claim(token) 放在最后；拿到写 Promise 立刻 markSent。结算口径（Fable 11/24 裁定）：
//   明确被拒或没发出 → fail；应答 success=true 只算「已下发」，不立刻放锁。
//   放锁按字段判断，跟总结果无关（Fable 11/25）：每个下发了的字段要么回读一致、要么锁到期，才算这个字段结束；所有字段都结束才放锁。
//   下发后回读里一致的字段先记为结束（这次读数只是候选，经写锁 commitRead 提交：读取途中换号、锁换了 / 取消 / 过期就丢弃）；还有没结束的 → unknown，交给写锁核对（本次登记的核对函数，见 fieldVerifier），之后复核读到
//   一致的字段也记为结束，全部结束即放；未变化 / 无法核对 / 结果未知都不提前放锁。应答结果未知 → unknown。
//   批次截止时间只影响界面上的标注，不放锁。
// - 控制屏实时预检（赤兔 11/25，src/api/screenPreflight.ts）：开始时并行现查本批每个项目的 ctrl 205（各自 5 秒超时），轮到某个项目时看它的结果，没通过
//   （503 / 超时 / 失败）→ 这一项标「未下发（控制屏未连接），可重新勾选下发」、不取锁、不发写请求，接着下一个；在线的照常发，整批不受影响。
//   205 返回 403（无连接状态权限）同样拦下，单独标「未下发（当前账号无连接状态权限…）」
import { callCtrl, writeCtrl, type CtrlReply, type WriteQuery } from '@/api/ctrl'
import { INVALID_HOURLY, NO_DATA } from '@/api/values'
import { roomSwitchReported } from '@/api/config'
import { ApiError } from '@/api/errors'
import type { WriteProject } from '@/api/guard'
import { TEXT } from './constants'
import { consoleLogger, type UnifiedLogger } from './log'
import { createUnifiedController, isDone, outcomeOf, type UnifiedController, type UnifiedState } from './machine'
import { changedFields, describeQuery, fieldResults, type EchoField, type UnifiedContext, type UnifiedDraft, type UnifiedEcho } from './rules'
import { acquire, beginRead, checkSentRecord, claim, commitRead, currentAccount, holds, lockOf, markOverdue, markSent, OTHER_ACCOUNT_TEXT, requireVerify, sameAccount, settle, verify, type LockToken } from '@/api/writeLock'
import { LOCK_BUSY_TEXT, lockTargetOf, recordOf } from './lock'
import { preflightScreen, SCREEN_FORBIDDEN_ROW, SCREEN_OFFLINE_ROW, withNoReplyNote, type ScreenState } from '@/api/screenPreflight'

/** 页面传进来的项目（S6a 的 Project 直接可用） */
export interface BatchProject {
  id: string
  code: string
  name: string
  /** app_code */
  programCode: number
  online: boolean
  /** 写锁键：控制屏号、DTU 号（S6a 的 Project 带着） */
  controlScreenId?: string
  dtuId?: string
}

/** 回读快照：200 房间温控数据整理成的统一控制相关值（toEcho 直接用它） */
export interface UnifiedSnapshot extends UnifiedEcho {
  /** 读到的房间数 */
  rooms: number
}

/** 演示数据的程序编码（11 三恒标准版、21 办公楼宇版、31 别墅五恒版）都是有房间温控的通用版，按 app_code 1 处理 */
const DEMO_GENERAL_CODES = new Set([11, 21, 31])
export function unifiedAppCode(programCode: number, mock: boolean): number {
  return mock && DEMO_GENERAL_CODES.has(programCode) ? 1 : programCode
}

export function contextOf(p: BatchProject | undefined, mock = false): UnifiedContext | null {
  if (!p) return null
  return { projectId: p.id, projectCode: p.code, projectName: p.name, appCode: unifiedAppCode(p.programCode, mock), online: p.online }
}

// 读数无效：65536（未初始化）、-100（无效数据，后端 11/25 答复第 9 条）、-1；0 是有效读数
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v !== NO_DATA && v !== INVALID_HOURLY && v !== -1 ? v : null)
const same = (xs: Array<number | null>): number | null => (xs.length && xs.every((x) => x !== null && x === xs[0]) ? xs[0] : null)

/**
 * 200 的房间列表 → 快照。房间开关未上报（roomSwitchReported() 为 false，后端 11/25 答复第 1 条）时，逐房间开关读数一律记 null
 * （设备没回报 → 核对时无法核对），汇总的 roomSwitch 也是 null，不拿读到的 0 当「关」。汇总值：全部房间读到且一致才给值，否则为 null；perRoom 留逐房间读数，核对按房间逐个比。
 * switch / set_temp 是普通 proto3 标量：0 值服务端不编码，解码出来就是 0（关），按真实读数核对。
 * 没有房间条目（含 200 回包为空 {}）→ 无法核对。is_connected=false 的房间读数不可信：不参与核对，记 offline（结果未知）。
 * 系统开关 / 运行模式没有读接口，不给这两个键（核对时记「未核对」）
 */
export function summarizeRooms(
  rooms: ReadonlyArray<{ switch?: number; setTemp?: number; isConnected?: boolean }>, opts: { switchReported?: boolean } = {},
): UnifiedSnapshot {
  const switchReported = opts.switchReported ?? roomSwitchReported()
  const online = rooms.filter((r) => r.isConnected !== false)
  // 开关只认 0 / 1，其他值按没回报（null → 无法核对）
  const sws = online.map((r) => (switchReported && (r.switch === 0 || r.switch === 1) ? r.switch : null))
  // 逐房间温度用原始读数核对（按 0.01 容差）；汇总值四舍五入到两位，只用于显示和整体比较
  const ts = online.map((r) => num(r.setTemp))
  const shown = ts.map((v) => (v === null ? null : Math.round(v * 100) / 100))
  const snap: UnifiedSnapshot = { rooms: rooms.length, roomSwitch: same(sws), roomTemp: same(shown), perRoom: { roomSwitch: sws, roomTemp: ts } }
  if (online.length < rooms.length) snap.offline = rooms.length - online.length
  if (!switchReported) snap.switchUnreported = true
  return snap
}

/** 真实回读：ctrl 200（只读） */
export async function readUnifiedSnapshot(projectId: string, signal: AbortSignal): Promise<UnifiedSnapshot> {
  const r = await callCtrl(200, projectId, {}, { signal })
  return summarizeRooms(r.data ?? [])
}

/** 写入口：S4 的 writeCtrl(203)，传整个 Project（写防护按 code 比对白名单，请求体用 id） */
/**
 * beforeSend：写入口在令牌就绪后、真正 fetch 前同步调用，返回 false 就不发（见 http.ts requestWrite）。
 * 自己实现的下发函数（演示数据、测试）也必须在「发出」前调用它
 */
export type BatchSender = (project: BatchProject, query: WriteQuery<203>, opts: { beforeSend: () => boolean; signal: AbortSignal }) => Promise<CtrlReply<203>>
// 批次的取消信号不交给 writeCtrl 去中止 fetch：已经发出的写请求要照常走完、拿到应答（S12a abort 语义）。
// 取消在发出前由 beforeSend 最先检查（recheck 第一行），效果等同 http 层的信号检查
export const defaultBatchSender: BatchSender = (project, query, opts) => writeCtrl(203, project, query, { beforeSend: opts.beforeSend })

/** success 已生效、unapplied 未变化、unverifiable 无法核对、unknown 结果未知 */
export type RowStatus = 'waiting' | 'sending' | 'success' | 'unapplied' | 'unverifiable' | 'failure' | 'unknown' | 'not-sent'
export interface BatchRow {
  id: string
  code: string
  name: string
  status: RowStatus
  /** 结束时刻（YYYY-MM-DD HH:MM:SS） */
  at?: string
  /** 批次层面的说明（截止时间到了等）。有它时 status 以批次判定为准 */
  note?: string
  /** 批次层面判定的失败且确定没执行（如登录状态异常） */
  notExecuted?: boolean
  /** 控制屏已应答 success=true（进度里据此显示「已下发，正在核对…」） */
  replyOk?: boolean
  /** 控制屏实时预检（205）没通过（控制屏未连接）、未下发：可重新勾选下发。暂无界面使用（统一控制页不设重试按钮，赤兔 11/25） */
  retry?: boolean
  state: UnifiedState<UnifiedSnapshot>
}
export type BatchPhase = 'idle' | 'confirming' | 'running' | 'done'
export interface BatchState {
  phase: BatchPhase
  rows: BatchRow[]
  /** prepare 不通过时的错误（已带项目名，去重） */
  errors: string[]
  /** 确认弹窗里列出的将下发的值 */
  items: Array<{ label: string; value: string }>
}

export interface BatchDeps {
  getProjects: () => readonly BatchProject[]
  readBack?: (projectId: string, signal: AbortSignal) => Promise<UnifiedSnapshot>
  send?: BatchSender
  log?: UnifiedLogger
  mock?: boolean
  now?: () => Date
  /** 批次截止（毫秒，默认 35 秒）：见 BATCH_DEADLINE_MS */
  deadlineMs?: number
  /**
   * 确认后、整批开始前强制重新拉一次项目列表（每批一次）；beforeSend 和发送前复核都用这份最新结果。
   * 拉取失败整批不下发。不传则用 getProjects()（只用于测试）
   */
  refreshProjects?: (signal: AbortSignal) => Promise<readonly BatchProject[]>
  /** 当前登录账号（user id，没有就用令牌 sub；演示模式为演示账号名）。确认时记下，beforeSend 核对 */
  getAccount?: () => string | null
  /** 控制屏实时预检（默认现查 ctrl 205；演示数据不查）；测试注入 */
  screen?: (projectId: string, signal: AbortSignal) => Promise<ScreenState>
}

export const REFRESH_FAILED_TEXT = '确认后刷新项目在线状态失败，整批未下发'
export const ACCOUNT_CHANGED_TEXT = '登录账号已变化，未下发'
/** 确认时取不到账号（令牌解析不出 sub）：整批不下发，记失败（未执行） */
export const LOGIN_ABNORMAL_TEXT = '登录状态异常，请重新登录后下发'

/**
 * 批次截止：从开始下发起 35 秒（方案 S12 验收「35 秒内给出最终结果」）。到截止时：
 * - 还没发出的项目（含正在下发前读取、正在等令牌续期的）→ 未下发（超时），之后 beforeSend 一律拒绝，绝不再发写请求；
 * - 已经发出、还没回应的 → 立即标「已下发，结果未知」，不再等它
 * 截止只影响界面上的标注：写锁不在这里放，仍按原写结算、回读核对或锁的有效期（见 lock.ts）
 */
export const BATCH_DEADLINE_MS = 35_000
export const DEADLINE_NOT_SENT = '超过 35 秒截止时间，未下发（超时）'
export const DEADLINE_UNKNOWN = '已下发，结果未知：超过 35 秒截止时间仍未收到应答，请刷新查看；未自动重试'
export const DEADLINE_REPLIED_OK = '已下发，结果未知：下发后回读在 35 秒截止前未完成，请稍后刷新确认；未自动重试'
export const DEADLINE_REPLIED_FAIL = '控制屏明确拒绝（未自动重试）；下发后回读在 35 秒截止前未完成'
/** 下发后回读途中登录账号变了、写锁已放开或过了有效期：这次读数作废 */
export const READ_VOID_TEXT = '回读期间登录账号已切换或本次下发已超时 / 已结束，读数未采用'

export function rowStatus(s: UnifiedState<unknown>, started: boolean): RowStatus {
  switch (s.status) {
    case 'confirming': return 'waiting'
    case 'sending': return 'sending'
    case 'success': return 'success'
    case 'unapplied': return 'unapplied'
    case 'unverifiable': return 'unverifiable'
    case 'failure': return 'failure'
    case 'unknown': return 'unknown'
    case 'idle': return started ? 'not-sent' : 'waiting'
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 本地时间 YYYY-MM-DD HH:MM:SS */
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${d.toTimeString().slice(0, 8)}`

export function createUnifiedBatch(deps: BatchDeps) {
  const readBack = deps.readBack ?? readUnifiedSnapshot
  const send = deps.send ?? defaultBatchSender
  const now = deps.now ?? (() => new Date())
  const mock = deps.mock ?? false
  const screen = deps.screen ?? ((pid: string, signal: AbortSignal) => (mock ? Promise.resolve<ScreenState>('online') : preflightScreen(pid, signal)))
  type Entry = {
    p: BatchProject; ctl: UnifiedController<UnifiedSnapshot>; started: boolean; at?: string; unsub: () => void
    /** beforeSend 放行过（写请求确实发出了） */
    sent: boolean
    /** 写请求的应答（截止时据此区分「等应答」和「等回读」） */
    reply?: 'ok' | 'rejected' | 'error'
    /** 所属批次序号：旧批次里没结束的写请求不能借新批次的截止时间放行 */
    batch: number
    /** 写锁令牌（acquire 成功后才有） */
    token?: LockToken
    /** 本次下发的值，和还没结束（没回读一致过）的字段：全部结束才放锁 */
    query?: WriteQuery<203>
    open?: Set<EchoField>
    /** 正在进行的核对（锁的 verify 同一时刻只跑一个，正在跑时再调会直接返回） */
    checking?: Promise<unknown>
    /** 截止时冻结的结果（含 205 预检没通过的未下发） */
    final?: { status: 'not-sent' | 'unknown' | 'failure'; note: string; notExecuted?: boolean; retry?: boolean }
  }
  let entries: Entry[] = []
  let state: BatchState = { phase: 'idle', rows: [], errors: [], items: [] }
  let stopped = false
  /** 截止时间（毫秒时间戳）；到点后置 expired */
  let deadlineAt = Infinity
  let expired = false
  /** 批次序号：每次 prepare 加一 */
  let batchSeq = 0
  /** 本批确认后拉到的最新项目列表 */
  let fresh: readonly BatchProject[] | null = null
  /** 本批确认时的账号 */
  let account: string | null = null
  /** 本批的取消信号：abort()（页面卸载）时中止 */
  let ac = new AbortController()
  let running: Promise<BatchState> | null = null
  const subs = new Set<() => void>()

  const emit = (patch: Partial<BatchState>) => {
    const rows = entries.map((e): BatchRow => ({
      id: e.p.id, code: e.p.code, name: e.p.name, at: e.at, state: e.ctl.getState(),
      status: e.final?.status ?? rowStatus(e.ctl.getState(), e.started), note: e.final?.note, notExecuted: e.final?.notExecuted, replyOk: e.reply === 'ok',
      ...(e.final?.retry ? { retry: true } : {}),
    }))
    state = { ...state, rows, ...patch }
    for (const fn of subs) fn()
  }
  const find = (id: string) => (fresh ?? deps.getProjects()).find((p) => p.id === id)

  /**
   * 发送前复核（同步）：批次没被终止（页面卸载）、没过截止时间、项目仍在列表里、code 没变、仍在线。
   * 只做检查，不改状态（「已发出」在 claim 认领成功后才记）
   */
  const recheck = (e: Entry, wp: WriteProject) => {
    // 最先看取消信号
    if (ac.signal.aborted) return false
    // 这一项已有定论（截止时冻结）、或已不属于当前批次：一律不发
    if (e.final || e.batch !== batchSeq || !entries.includes(e)) return false
    if (stopped || expired || now().getTime() >= deadlineAt) return false
    // 账号绑定：确认时的账号与当前存储里的账号一致才发
    if (deps.getAccount && (account === null || deps.getAccount() !== account)) return false
    const cur = find(wp.id)
    if (!cur || cur.code !== wp.code || cur.online !== true) return false
    return true
  }
  /** 控制器给的 {id, code} → 最新列表里的整个 Project；对不上就本地拦截（没发出） */
  const sendWhole = (e: Entry) => (wp: WriteProject, q: WriteQuery<203>) => {
    const p = find(wp.id)
    if (!p || p.code !== wp.code) return Promise.reject(new ApiError('write_blocked', TEXT.projectChanged))
    // 写锁：同一块屏（或 DTU、项目）上一条还没有结论 → 不发
    const got = acquire(lockTargetOf(p), p.name)
    if (!got.ok) return Promise.reject(new ApiError('write_blocked', got.busy.owner === 'other-account' ? OTHER_ACCOUNT_TEXT : LOCK_BUSY_TEXT))
    const token = got.token
    e.token = token
    // 核对数据发送前先查（203 运行模式为 -1 等枚举外的值）：不合规就不发，放锁
    const record = recordOf(q)
    const bad = checkSentRecord(record)
    if (bad) { settle(token, 'fail'); return Promise.reject(new ApiError('write_blocked', bad)) }
    // beforeSend 链：批次复核在前，claim(token) 必须放在最后（认领成功即视为已发出）
    const beforeSend = () => {
      const ok = recheck(e, wp) && claim(token)
      if (ok) e.sent = true
      return ok
    }
    let out: Promise<CtrlReply<203>>
    try { out = send(p, q, { beforeSend, signal: ac.signal }) } catch (x) { settle(token, 'fail'); return Promise.reject(x) }
    // 网关纯文本 504：错误说明补「控制屏 10 秒内没有应答，可能离线」（kind / status 不变，分类照旧）
    out = out.catch((x) => { throw withNoReplyNote(x) })
    markSent(token, out, record)
    e.query = q
    e.open = new Set(changedFields(q))
    // 本次的核对函数：只看还没结束的字段，读到一致的作为候选；写锁确认这次核对仍有效（锁没换、没超时、没取消、账号没变）
    // 才提交（commit）为结束。候选提交后全部结束才算一致（放锁）。迟到或失效的核对不改字段状态
    requireVerify(token, (signal) => {
      const run = (async () => {
        if (!e.open!.size) return true
        const snap = await readBack(p.id, signal)
        const done = closableFields(e, snap)
        return { same: [...e.open!].every((f) => done.includes(f)), commit: () => { for (const f of done) e.open!.delete(f) } }
      })()
      e.checking = run
      return run
    })
    out.then((r) => {
      const ok = r?.success === true
      if (e.sent) e.reply = ok ? 'ok' : 'rejected'
      // success=true 只算「已下发」：已认领的不在这里放锁，等下发后回读的结论（见 settleByReadback）。
      // 截止后才到的成功应答（这一项已冻结、页面可能已 reset 取消订阅）：按结果未知结算，交给锁核对或到期
      if (!ok || !e.sent) settle(token, ok ? 'ok' : 'fail')
      else if (e.final) settle(token, 'unknown')
    }, (err) => {
      const o = outcomeOf(err)
      if (e.sent) e.reply = o === 'unknown' ? 'error' : 'rejected'
      // 没认领的（beforeSend 没过）settle 直接放锁；认领过的：没发出 / 明确被拒 → fail，其余结果未知 → unknown
      settle(token, o === 'unknown' ? 'unknown' : 'fail')
    })
    return out
  }

  /** 这次读数里回读一致的字段记为结束（逐字段口径与结果卡片同一套：rules.ts fieldResults；有房间离线的不算一致） */
  const closableFields = (e: Entry, snap: UnifiedSnapshot | null | undefined): EchoField[] =>
    !e.query || !e.open || !snap ? [] : fieldResults(e.query, snap).filter((r) => r.status === 'applied' && e.open!.has(r.field)).map((r) => r.field)
  const closeFields = (e: Entry, snap: UnifiedSnapshot) => {
    for (const f of closableFields(e, snap)) e.open?.delete(f)
  }

  /**
   * 状态机结束后按字段结算写锁（不看总结果）：下发后回读一致的字段记为结束；全部结束 → ok（放锁），并让锁再核对一次
   * （应答未知、锁已是 unknown 的：没有未结束的字段，核对直接放开）。还有没结束的字段、且应答 success=true → unknown
   * （锁等之后的核对把剩下的字段都读到一致，或到期）。被拒、没发出的已在写 Promise 上结算过
   */
  const settleByReadback = (e: Entry, st: UnifiedState<UnifiedSnapshot>) => {
    if (!e.token || !e.sent || e.reply === 'rejected') return
    // 第一次回读的候选字段已在读完时经写锁 commitRead 提交（与之后的复核同一条路径，见 prepare 里的 readBack 包装）；
    // 提交被拒的读数已作废，这里不再碰字段
    if (e.open && e.open.size === 0) {
      // 锁已不归这个 token（到期、被核对放开后同屏又被新的下发占用）：不按锁键去碰别人的锁
      if (!holds(e.token)) return
      settle(e.token, 'ok')
      const key = e.token.key
      void verify(key)
      // 有核对正在跑（它读之前这些字段还没结束）：这次 verify 会被跳过，等它跑完再核对一次（没有未结束的字段，直接放开）
      // 延迟回调真正执行时再确认一次 token 仍持锁：等待期间锁可能已放开、同屏又被新的下发占用，不按锁键去碰新锁
      const token = e.token
      void e.checking?.catch(() => false).then(() => setTimeout(() => { if (holds(token)) void verify(key) }, 0))
      return
    }
    if (e.reply === 'ok') settle(e.token, 'unknown')
  }

  function clear() {
    for (const e of entries) { e.unsub(); e.ctl.abort() }
    entries = []
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } },

    prepare(ids: readonly string[], draft: UnifiedDraft): BatchState {
      if (state.phase === 'running' || state.phase === 'confirming') return state
      clear()
      stopped = false
      fresh = null
      ac = new AbortController()
      batchSeq++
      const uniq = [...new Set(ids)]
      if (!uniq.length) { emit({ phase: 'idle', errors: [TEXT.noProject], items: [] }); return state }
      const errs: Array<{ name: string; msg: string }> = []
      for (const id of uniq) {
        const p = find(id)
        if (!p) { errs.push({ name: id, msg: TEXT.noProject }); continue }
        // 同一块屏上一条下发还没有结论：整体不下发
        const held = lockOf(lockTargetOf(p))
        if (held) { errs.push({ name: p.name, msg: held.owner === 'other-account' ? OTHER_ACCOUNT_TEXT : LOCK_BUSY_TEXT }); continue }
        const entry = { p, started: false, sent: false, batch: batchSeq, unsub: () => {} } as Entry
        const ctl = createUnifiedController<UnifiedSnapshot>({
          getContext: () => contextOf(find(id), mock),
          // 已发出后的那次（下发后回读）：读之前向写锁取凭据（记下读取开始时的账号与锁 token），读数只作为候选
          readBack: async (pid, sig) => {
            if (!entry.sent || !entry.token) {
              return await readBack(pid, sig)
            }
            // 明确被拒：锁已按 fail 放开，没有凭据；单独记下读取开始时的账号，读的过程中换了号这次读数作废（after 置空），
            // 被拒的结论由状态机保留
            if (entry.reply === 'rejected') {
              const acct = currentAccount()
              const snap = await readBack(pid, sig)
              if (!sameAccount(acct, currentAccount())) throw new Error(READ_VOID_TEXT)
              return snap
            }
            const ticket = beginRead(entry.token)
            // 读开始时锁已不归这次下发（到期、被放开后又被新的下发占用）：这次读取直接作废
            if (!ticket) throw new Error(READ_VOID_TEXT)
            const snap = await readBack(pid, sig)
            // 先提交、再判定：读完立刻（同一同步段）经写锁 commitRead 提交候选字段，被拒（读取途中换号、锁已放开或换了、过了有效期）
            // 就作废这次读数，按回读失败交给状态机（结果未知），绝不进结果判定；提交成功的读数才交给状态机判定
            if (!commitRead(ticket, () => closeFields(entry, snap))) throw new Error(READ_VOID_TEXT)
            return snap
          },
          toEcho: (s) => s,
          send: sendWhole(entry),
          log: deps.log ?? consoleLogger,
        })
        entry.ctl = ctl
        const s = ctl.request(draft)
        if (s.status === 'idle') for (const m of s.errors) errs.push({ name: p.name, msg: m })
        entry.unsub = ctl.subscribe(() => {
          const st = ctl.getState()
          if (entry.started && !entry.at && (isDone(st) || st.status === 'idle')) entry.at = stamp(now())
          if (isDone(st)) settleByReadback(entry, st)
          if (state.phase === 'running') emit({})
        })
        entries.push(entry)
      }
      if (errs.length) {
        for (const e of entries) e.ctl.cancel()
        clear()
        // 全部项目同一条错误（如「没有要下发的设置」）只显示一次
        const msgs = new Set(errs.map((e) => e.msg))
        const errors = msgs.size === 1 && errs.length === uniq.length ? [...msgs] : [...new Set(errs.map((e) => `${e.name}：${e.msg}`))]
        emit({ phase: 'idle', errors, items: [] })
        return state
      }
      const first = entries[0].ctl.getState()
      emit({ phase: 'confirming', errors: [], items: first.status === 'confirming' ? describeQuery(first.query) : [] })
      return state
    },

    cancel() {
      if (state.phase !== 'confirming') return
      for (const e of entries) e.ctl.cancel()
      clear()
      emit({ phase: 'idle', errors: [], items: [] })
    },

    /** 逐个下发；重复调用返回同一个 Promise。不重试 */
    start(): Promise<BatchState> {
      if (running) return running
      if (state.phase !== 'confirming') return Promise.resolve(state)
      deadlineAt = now().getTime() + (deps.deadlineMs ?? BATCH_DEADLINE_MS)
      expired = false
      let onDeadline!: () => void
      const deadline = new Promise<'deadline'>((r) => { onDeadline = () => r('deadline') })
      const timer = setTimeout(() => {
        // 截止：先置 expired（之后 beforeSend 一律拒绝），再冻结每个项目的结果
        expired = true
        for (const e of entries) {
          const cur = e.ctl.getState()
          if (isDone(cur)) continue
          if (cur.status === 'idle' && e.started) continue
          // 已发出：被拒的按应答；success=true 但回读没做完、或没应答的 → 结果未知；没发出：未下发（超时）
          e.final = !e.sent ? { status: 'not-sent', note: DEADLINE_NOT_SENT }
            : e.reply === 'ok' ? { status: 'unknown', note: DEADLINE_REPLIED_OK }
            : e.reply === 'rejected' ? { status: 'failure', note: DEADLINE_REPLIED_FAIL }
            : { status: 'unknown', note: DEADLINE_UNKNOWN }
          e.started = true
          e.at ??= stamp(now())
          e.ctl.abort()
          // 写锁只改标记（已过截止），不放锁；success=true 还没回读完的按结果未知结算（回读之后一致再由 settleByReadback 核对放开）
          if (e.token) { markOverdue(e.token); if (e.reply === 'ok') settle(e.token, 'unknown') }
        }
        onDeadline()
      }, Math.max(0, deadlineAt - now().getTime()))
      emit({ phase: 'running' })
      account = deps.getAccount ? deps.getAccount() : null
      const run = async () => {
        // 确认时取不到账号：整批不下发（不刷新、不回读），记失败（未执行）
        if (deps.getAccount && account === null) {
          for (const e of entries) { e.final = { status: 'failure', note: LOGIN_ABNORMAL_TEXT, notExecuted: true }; e.started = true; e.at ??= stamp(now()); e.ctl.abort() }
          clearTimeout(timer)
          emit({ phase: 'done' })
          return state
        }
        // 控制屏实时预检（205）：开始时并行查本批所有项目（每个单独 5 秒超时、不缓存、只在本批用），避免串行时几个不应答的
        // 项目各吃 5 秒、把后面在线的挤过 35 秒截止
        const screens = new Map(entries.map((e) => [e, screen(e.p.id, ac.signal).catch((): ScreenState => 'offline')] as const))
        // 确认后、整批开始前强制刷新一次在线状态（每批一次）
        if (deps.refreshProjects) {
          try {
            const list = await Promise.race([deps.refreshProjects(ac.signal), deadline.then(() => { throw new Error('deadline') })])
            fresh = list
          } catch {
            if (!expired) for (const e of entries) { e.final = { status: 'not-sent', note: stopped ? TEXT.aborted : REFRESH_FAILED_TEXT }; e.started = true; e.at ??= stamp(now()); e.ctl.abort() }
            clearTimeout(timer)
            emit({ phase: 'done' })
            return state
          }
        }
        for (const e of entries) {
          if (stopped || expired) break
          e.started = true
          emit({})
          // 控制屏实时预检（205，开始时已并行发出）：没通过 → 这一项未下发（不取锁、不发），接着下一个
          const scr = await Promise.race([screens.get(e)!, deadline])
          if (scr === 'deadline') break
          if (scr !== 'online' || stopped || expired) {
            if (!e.final && !stopped && !expired) {
              // 403（无连接状态权限）单独文案、不标可重试；其余按控制屏未连接，可重新勾选下发
              e.final = scr === 'forbidden' ? { status: 'not-sent', note: SCREEN_FORBIDDEN_ROW } : { status: 'not-sent', note: SCREEN_OFFLINE_ROW, retry: true }
              e.at ??= stamp(now())
              e.ctl.abort()
              emit({})
            }
            continue
          }
          // 截止时不再等在途的项目
          if (await Promise.race([e.ctl.confirm().then(() => 'done' as const), deadline]) === 'deadline') break
          if (!e.at) e.at = stamp(now())
          emit({})
        }
        clearTimeout(timer)
        // 没轮到的（页面卸载后）也标成已开始，显示为「未下发」
        for (const e of entries) if (!e.started) { e.started = true; e.ctl.abort(); e.at ??= stamp(now()) }
        emit({ phase: 'done' })
        return state
      }
      running = run().finally(() => { running = null })
      return running
    },

    /** 页面卸载：还没发出的终止，后面的不再开始 */
    abort() {
      stopped = true
      ac.abort()
      for (const e of entries) e.ctl.abort()
    },

    /** 结束后清空，回到可再次下发 */
    reset() {
      if (state.phase === 'running') return
      clear()
      emit({ phase: 'idle', errors: [], items: [], rows: [] })
    },
  }
}

export type UnifiedBatch = ReturnType<typeof createUnifiedBatch>
