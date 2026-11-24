// 统一控制页面（S12b）：对同一集成项目里选中的多个项目，逐个走 S12a 的单项目状态机（ctrl 203）。
//
// - prepare(ids, draft)：为每个项目建一个控制器并 request(draft)（逐个校验：离线、app_code、温度范围、无改动…）。
//   任一项目校验不过就整体不下发，全部 cancel，返回错误；全部通过则停在 confirming，等页面的二次确认。
// - start()：二次确认通过后按顺序逐个 confirm()（下发前读 → 203 → 下发后读），一个结束再下一个；不重试。
// - cancel()：确认弹窗取消或失效 → 全部 cancel。
// - abort()：页面卸载 → 还没发出的全部终止（S12a abort 语义：已发出的照常走完回读），不再开始后面的项目。
// - 写入口：控制器给出的 {id, code} 先在最新项目列表里找回整个 Project，id 与 code 都对得上才把 Project 交给写入口；
//   对不上（项目被移除或 code 变了）按本地拦截处理（write_blocked，肯定没发出）。
import { callCtrl, writeCtrl, type CtrlReply, type WriteQuery } from '@/api/ctrl'
import { ApiError } from '@/api/errors'
import type { WriteProject } from '@/api/guard'
import { TEXT } from './constants'
import { consoleLogger, type UnifiedLogger } from './log'
import { createUnifiedController, outcomeOf, type UnifiedController, type UnifiedState } from './machine'
import { describeQuery, type UnifiedContext, type UnifiedDraft, type UnifiedEcho } from './rules'

/** 页面传进来的项目（S6a 的 Project 直接可用） */
export interface BatchProject {
  id: string
  code: string
  name: string
  /** app_code */
  programCode: number
  online: boolean
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

const INVALID = 65536
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v !== INVALID && v !== -1 ? v : null)
const same = (xs: Array<number | null>): number | null => (xs.length && xs.every((x) => x !== null && x === xs[0]) ? xs[0] : null)

/** 200 的房间列表 → 快照。全部房间一致才给值，不一致或没读到为 null（核对时算「未回读到」）；系统开关 / 运行模式没有读接口 */
export function summarizeRooms(rooms: ReadonlyArray<{ switch?: number; setTemp?: number }>): UnifiedSnapshot {
  const sw = same(rooms.map((r) => num(r.switch)))
  const t = same(rooms.map((r) => { const v = num(r.setTemp); return v === null ? null : Math.round(v * 100) / 100 }))
  return { rooms: rooms.length, roomSwitch: sw, roomTemp: t }
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
export type BatchSender = (project: BatchProject, query: WriteQuery<203>, opts: { beforeSend: () => boolean }) => Promise<CtrlReply<203>>
export const defaultBatchSender: BatchSender = (project, query, opts) => writeCtrl(203, project, query, { beforeSend: opts.beforeSend })

export type RowStatus = 'waiting' | 'sending' | 'success' | 'failure' | 'unknown' | 'not-sent'
export interface BatchRow {
  id: string
  code: string
  name: string
  status: RowStatus
  /** 结束时刻（YYYY-MM-DD HH:MM:SS） */
  at?: string
  /** 批次层面的说明（截止时间到了等）。有它时 status 以批次判定为准 */
  note?: string
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
}

/**
 * 批次截止：从开始下发起 35 秒（方案 S12 验收「35 秒内给出最终结果」）。到截止时：
 * - 还没发出的项目（含正在下发前读取、正在等令牌续期的）→ 未下发（超时），之后 beforeSend 一律拒绝，绝不再发写请求；
 * - 已经发出、还没回应的 → 立即标「结果未确认」，不再等它
 */
export const BATCH_DEADLINE_MS = 35_000
export const DEADLINE_NOT_SENT = '超过 35 秒截止时间，未下发（超时）'
export const DEADLINE_UNKNOWN = '超过 35 秒截止时间仍未收到应答，结果未确认，请刷新查看；未自动重试'
export const DEADLINE_REPLIED_OK = '控制屏已确认生效；下发后回读在 35 秒截止前未完成，未核对'
export const DEADLINE_REPLIED_FAIL = '控制屏明确拒绝（未自动重试）；下发后回读在 35 秒截止前未完成'
/** 下发前读到房间全部关着，这次又要设温度（且没同时开房间）：不发（后端答复⑦） */
export const ROOMS_OFF_TEXT = '下发前读到房间都关着，不能设定温度，未下发'

export function rowStatus(s: UnifiedState<unknown>, started: boolean): RowStatus {
  switch (s.status) {
    case 'confirming': return 'waiting'
    case 'sending': return 'sending'
    case 'success': return 'success'
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
  type Entry = {
    p: BatchProject; ctl: UnifiedController<UnifiedSnapshot>; started: boolean; at?: string; unsub: () => void
    /** beforeSend 放行过（写请求确实发出了） */
    sent: boolean
    /** 写请求的应答（截止时据此区分「等应答」和「等回读」） */
    reply?: 'ok' | 'rejected' | 'error'
    /** 下发前读到的快照 */
    before?: UnifiedSnapshot
    /** 所属批次序号：旧批次里没结束的写请求不能借新批次的截止时间放行 */
    batch: number
    /** 截止时冻结的结果 */
    final?: { status: 'not-sent' | 'unknown' | 'success' | 'failure'; note: string }
  }
  let entries: Entry[] = []
  let state: BatchState = { phase: 'idle', rows: [], errors: [], items: [] }
  let stopped = false
  /** 截止时间（毫秒时间戳）；到点后置 expired */
  let deadlineAt = Infinity
  let expired = false
  /** 批次序号：每次 prepare 加一 */
  let batchSeq = 0
  let running: Promise<BatchState> | null = null
  const subs = new Set<() => void>()

  const emit = (patch: Partial<BatchState>) => {
    const rows = entries.map((e): BatchRow => ({
      id: e.p.id, code: e.p.code, name: e.p.name, at: e.at, state: e.ctl.getState(),
      status: e.final?.status ?? rowStatus(e.ctl.getState(), e.started), note: e.final?.note,
    }))
    state = { ...state, rows, ...patch }
    for (const fn of subs) fn()
  }
  const find = (id: string) => deps.getProjects().find((p) => p.id === id)

  /**
   * 发送前复核（同步）：批次没被终止（页面卸载）、没过截止时间、项目仍在列表里、code 没变、仍在线。
   * 通过就记下「已发出」
   */
  const recheck = (e: Entry, wp: WriteProject) => () => {
    // 这一项已有定论（截止时冻结）、或已不属于当前批次：一律不发
    if (e.final || e.batch !== batchSeq || !entries.includes(e)) return false
    if (stopped || expired || now().getTime() >= deadlineAt) return false
    const cur = find(wp.id)
    if (!cur || cur.code !== wp.code || cur.online !== true) return false
    e.sent = true
    return true
  }
  /** 控制器给的 {id, code} → 最新列表里的整个 Project；对不上就本地拦截（没发出） */
  const sendWhole = (e: Entry) => (wp: WriteProject, q: WriteQuery<203>) => {
    const p = find(wp.id)
    if (!p || p.code !== wp.code) return Promise.reject(new ApiError('write_blocked', TEXT.projectChanged))
    // 房间都关着又要设温度（没同时开房间）：不发
    if (q.roomTemp !== -1 && q.roomSwitch !== 1 && e.before && e.before.rooms > 0 && e.before.roomSwitch === 0) {
      return Promise.reject(new ApiError('write_blocked', ROOMS_OFF_TEXT))
    }
    const out = send(p, q, { beforeSend: recheck(e, wp) })
    out.then((r) => { if (e.sent) e.reply = r?.success === true ? 'ok' : 'rejected' },
      (err) => { if (e.sent) e.reply = outcomeOf(err) === 'unknown' ? 'error' : 'rejected' })
    return out
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
      batchSeq++
      const uniq = [...new Set(ids)]
      if (!uniq.length) { emit({ phase: 'idle', errors: [TEXT.noProject], items: [] }); return state }
      const errs: Array<{ name: string; msg: string }> = []
      for (const id of uniq) {
        const p = find(id)
        if (!p) { errs.push({ name: id, msg: TEXT.noProject }); continue }
        const entry = { p, started: false, sent: false, batch: batchSeq, unsub: () => {} } as Entry
        const ctl = createUnifiedController<UnifiedSnapshot>({
          getContext: () => contextOf(find(id), mock),
          // 记下第一次（下发前）读到的快照，供发送前判断房间是否都关着
          readBack: async (pid, sig) => { const snap = await readBack(pid, sig); if (!entry.before) entry.before = snap; return snap },
          toEcho: (s) => s,
          send: sendWhole(entry),
          log: deps.log ?? consoleLogger,
        })
        entry.ctl = ctl
        const s = ctl.request(draft)
        if (s.status === 'idle') for (const m of s.errors) errs.push({ name: p.name, msg: m })
        entry.unsub = ctl.subscribe(() => {
          const st = ctl.getState()
          if (entry.started && !entry.at && (st.status === 'success' || st.status === 'failure' || st.status === 'unknown' || st.status === 'idle')) entry.at = stamp(now())
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
          const st = e.ctl.getState().status
          if (st === 'success' || st === 'failure' || st === 'unknown') continue
          if (st === 'idle' && e.started) continue
          // 已发出：有应答的按应答（只是回读没做完），没应答的结果未确认；没发出：未下发（超时）
          e.final = !e.sent ? { status: 'not-sent', note: DEADLINE_NOT_SENT }
            : e.reply === 'ok' ? { status: 'success', note: DEADLINE_REPLIED_OK }
            : e.reply === 'rejected' ? { status: 'failure', note: DEADLINE_REPLIED_FAIL }
            : { status: 'unknown', note: DEADLINE_UNKNOWN }
          e.started = true
          e.at ??= stamp(now())
          e.ctl.abort()
        }
        onDeadline()
      }, Math.max(0, deadlineAt - now().getTime()))
      emit({ phase: 'running' })
      const run = async () => {
        for (const e of entries) {
          if (stopped || expired) break
          e.started = true
          emit({})
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
