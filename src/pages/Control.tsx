// 统一控制（S12b）：对同一集成项目里选中的在线项目批量下发 ctrl 203。
// 逐个项目走 S12a 的状态机（src/features/unified）：二次确认 → 下发前读 → 203 → 下发后读 → 已生效 / 未变化 / 结果未知 / 无法核对 / 失败；不重试。
// 确认弹窗在本组件里用 useConfirm() 取（分工第 7 条）；写入口拿到的是整个 Project（见 batch.ts）。
// 改动文档：app_code 为 8、12 时房间温度设定不可用（房间开关仍可用）；最近一次执行结果只显示 项目、项目 ID、状态、操作时间。
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { faMagnifyingGlass, faCircleInfo, faLayerGroup, faChevronDown, faChevronUp, faPowerOff, faWandMagicSparkles, faSnowflake, faSun, faDropletSlash, faDroplet, faWind, faRobot, faMinus, faArrowsRotate, faDoorOpen, faTemperatureHalf, faPaperPlane, faTriangleExclamation, faSpinner } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { Icon } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Checkbox } from '@/components/ui/checkbox'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import { useConfirm } from '../app/feedback'
import { orgSource, projectsInGroup, useDealerPick, useDealers } from '../data/org'
import { useSession } from '../data/session'
import { DealersError } from '../components/DealersError'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { isMockMode, roomSwitchReported } from '../api/config'
import { getCurrentUserId } from '../api/auth'
import { ApiError } from '../api/errors'
import { MODE_UNCHANGED, type WriteQuery } from '../api/ctrl'
import { WRITE_RECHECK_TEXT } from '../api/http'
import { jwtSub, readTokens } from '../api/tokens'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '../api/gen/ctrl200_pb.js'
import * as api from '../api'
import { attachEvidence, endOf, lockKeysOf, lockOf, writeLockTtl, type VerifyResult, lockVersion, onForceReread, OTHER_ACCOUNT_TEXT, subscribe as subscribeLock } from '../api/writeLock'
import { seqNames } from '@/lib/seqNames'
import {
  clampTemp, LOCK_BUSY_TEXT, lockTargetOf, rereadHits, MODE_OPTIONS, readUnifiedSnapshot, resolveTempRange, TEXT, tempAvailability, unifiedAppCode, useUnifiedBatch,
  fieldResults, isStoredQuery203, overallOf, resultTitle,
  type BatchRow, type FieldStatus, type RowStatus, type UnifiedDraft, type UnifiedSnapshot,
} from '../features/unified'

type Tri = '开启' | '关闭' | '不变'
type RoomTri = '全部开启' | '全部关闭' | '不变'

const MODE_ICON: Partial<Record<Mode, [IconDefinition, string]>> = {
  [Mode.OPERATION_MODE_SUMMER]: [faSnowflake, '#0891b2'],
  [Mode.OPERATION_MODE_WINTER]: [faSun, '#f97316'],
  [Mode.OPERATION_MODE_VENTILATION]: [faWind, '#0ea5e9'],
  [Mode.OPERATION_MODE_DEHUMIDIFY]: [faDropletSlash, '#10b981'],
  [Mode.OPERATION_MODE_FREE_COOLING]: [faSnowflake, '#0891b2'],
  [Mode.OPERATION_MODE_HEATING_DEHUMIDIFY]: [faSun, '#f97316'],
  [Mode.OPERATION_MODE_HEATING]: [faSun, '#f97316'],
  [Mode.OPERATION_MODE_HEATING_HUMIDIFY]: [faSun, '#f97316'],
  [Mode.OPERATION_MODE_HUMIDIFY]: [faDroplet, '#0ea5e9'],
  [Mode.OPERATION_MODE_REFRIGERATION]: [faSnowflake, '#0891b2'],
  [Mode.OPERATION_MODE_REFRIGERATION_HUMIDIFY]: [faSnowflake, '#0891b2'],
  [Mode.OPERATION_MODE_REFRIGERATION_DEHUMIDIFY]: [faSnowflake, '#0891b2'],
  [Mode.OPERATION_MODE_REFRIGERATION_HEATING]: [faArrowsRotate, '#8b5cf6'],
  [Mode.OPERATION_MODE_AUTO]: [faRobot, '#8b5cf6'],
}
const MODES: Array<{ value: Mode; label: string }> = [...MODE_OPTIONS, { value: MODE_UNCHANGED, label: TEXT.unchanged }]

/** 结果表的一行（演示数据与本次下发结果同一形状） */
export interface ResultRow {
  name: string; code: string; status: Exclude<RowStatus, 'waiting' | 'sending'>; at: string
  /** 失败但确定没执行（发送前复核不过、登录状态失效等） */
  notExecuted?: boolean
  /** 原因与前后回读（只在「下发核对」区显示，不进结果卡片） */
  detail?: string
  /** 逐字段结果（Fable 11/25）：标题（单一结果是那个词，混合是计数）+ 每个字段各自的状态。只在「下发核对」区显示 */
  title?: string
  fields?: Array<{ label: string; status: FieldStatus; messages: string[] }>
  /**
   * 批次结束时这一行还没核对一致、写锁仍在自动再核对：记下那把锁（主锁键 + 到期时间，不是凭据）和这次下发的内容（项目 id、
   * 下发的四个值、应答是否 success）。最终结论以写锁最后一次核对为准（赤兔 11/25），批次回读的结论只作过程：
   * 锁还在自动核对（settling）→ 只显示「已下发，正在核对…」；锁核对一致放开 → 已生效；退避用完 / 到期 → 按锁最后一次核对的读数逐字段重算
   */
  lock?: { key: string; exp: number; projectId: string; query: WriteQuery<203>; replied: boolean }
}

/** 批次里没核对一致、写锁会接着自动再核对的结论 */
const SETTLE_STATUSES: ReadonlySet<ResultRow['status']> = new Set(['unapplied', 'unverifiable', 'unknown'])

/**
 * 写锁最后收下的那次核对的读数：readBack 读到就作为证据挂到这次核对上（attachEvidence 只认写锁交给核对函数的信号，
 * 批次自己的下发前后读不算）。写锁只在收下这次核对（记入 lastVerify）时才一起保存，从锁视图 / endOf 取回（lastEvidence），
 * 所以读数与 lastVerify 一定是同一次；换账号、登出后写锁清空，刷新后也没有（退回批次结论）
 */
const snapOf = (v: unknown): UnifiedSnapshot | undefined => (v && typeof v === 'object' ? v as UnifiedSnapshot : undefined)

/** 这一行此刻怎么显示：正在核对 / 已生效 / 按锁最后一次核对的结论（lastVerify 与同一次的读数）/ 按批次结论（null） */
type Live = { kind: 'settling' } | { kind: 'applied' } | { kind: 'final'; lastVerify?: VerifyResult; snap?: UnifiedSnapshot; ended: boolean } | null
function liveOf(r: ResultRow): Live {
  if (!r.lock) return null
  const l = lockOf(r.lock.key)
  if (l) return l.expiresAt !== r.lock.exp ? null : l.settling ? { kind: 'settling' } : { kind: 'final', lastVerify: l.lastVerify, snap: snapOf(l.lastEvidence), ended: false }
  const end = endOf(r.lock.key)
  if (!end || end.expiresAt !== r.lock.exp) return null
  return end.how === 'applied' ? { kind: 'applied' } : end.how === 'expired' ? { kind: 'final', lastVerify: end.lastVerify, snap: snapOf(end.lastEvidence), ended: true } : null
}
/** 写锁自动再核对一致、已放开：这一行定为已生效 */
const appliedRow = (r: ResultRow): ResultRow => ({ ...r, lock: undefined, status: 'success', title: undefined, fields: undefined, detail: `${TEXT.success}（自动再核对一致）` })
const FINAL_STATUS: Record<FieldStatus, ResultRow['status'] | null> = { applied: null, unchanged: 'unapplied', unverifiable: 'unverifiable', unknown: 'unknown' }
const FINAL_TEXT: Record<FieldStatus, string> = { applied: TEXT.success, unchanged: TEXT.unapplied, unverifiable: TEXT.unverifiable, unknown: TEXT.sentUnknown }
/**
 * 退避用完 / 到期：按写锁最后一次核对重算这一行。回读失败（failed、offline 等）→ 每个下发了的字段结果未知；
 * 读到了但不一致 → 用那次读数逐字段算（与批次同一套 fieldResults）。没有可用的读数（刷新过）或锁还没核对过 → 按批次结论
 */
function finalRow(r: ResultRow, lastVerify: VerifyResult | undefined, evidence: UnifiedSnapshot | undefined): ResultRow {
  const lk = r.lock
  if (!lk || !lastVerify) return r
  const snap = lastVerify === 'mismatch' || lastVerify === 'unverifiable' ? evidence : null
  if (snap === undefined) return r
  const fs = fieldResults(lk.query, snap, { replied: lk.replied })
  const status = FINAL_STATUS[overallOf(fs)]
  if (!status) return r // 读数一致但锁没放（被否决等）：不在这里判已生效，按批次结论
  return {
    ...r, status, title: resultTitle(fs), fields: fs.map(({ label, status: st, messages }) => ({ label, status: st, messages })),
    // 结论按最后一次核对；批次那次的说明与前后回读留作过程
    detail: [FINAL_TEXT[overallOf(fs)], snap ? `回读（最后一次自动再核对）：${fmtSnap(snap)}` : '最后一次自动再核对回读失败', r.detail ? `过程（下发后第一次回读）：${r.detail}` : TEXT.retryHint].join('；'),
  }
}
interface ShownRow extends ResultRow { badge: { label: string; variant: 'green' | 'red' | 'orange' | 'amber' | 'gray' } }
function shown(r: ResultRow): ShownRow {
  const live = liveOf(r)
  if (live?.kind === 'settling') return { ...r, title: undefined, fields: undefined, detail: TEXT.verifying, badge: { label: TEXT.verifying, variant: 'gray' } }
  if (live?.kind === 'applied') return { ...appliedRow(r), badge: STATUS.success }
  const x = live?.kind === 'final' ? finalRow(r, live.lastVerify, live.snap) : r
  return { ...x, badge: { label: x.notExecuted ? '失败（未执行）' : x.title ?? STATUS[x.status].label, variant: STATUS[x.status].variant } }
}
/** 锁已结束：定下这一行（已生效，或按锁最后一次核对），去掉锁引用，存进本标签页 */
function settledRow(r: ResultRow): ResultRow | null {
  const live = liveOf(r)
  if (live?.kind === 'applied') return appliedRow(r)
  if (live?.kind === 'final' && live.ended) return { ...finalRow(r, live.lastVerify, live.snap), lock: undefined }
  return null
}

const FIELD_BADGE: Record<FieldStatus, 'green' | 'orange' | 'amber'> = { applied: 'green', unchanged: 'orange', unverifiable: 'amber', unknown: 'orange' }

/** 逐字段结果：下发后有结论的四种（已生效 / 未变化 / 无法核对 / 结果未知）才列；截止时冻结的以批次判定为准，不列 */
function rowFields(r: BatchRow): Pick<ResultRow, 'title' | 'fields'> {
  const s = r.state
  if (r.note || (s.status !== 'success' && s.status !== 'unapplied' && s.status !== 'unverifiable' && s.status !== 'unknown')) return {}
  const fs = fieldResults(s.query, s.after, { replied: s.status !== 'unknown' || s.replied })
  return { title: resultTitle(fs), fields: fs.map(({ label, status, messages }) => ({ label, status, messages })) }
}

const STATUS: Record<ResultRow['status'], { label: string; variant: 'green' | 'red' | 'orange' | 'amber' | 'gray' }> = {
  // 下发结果口径（Fable 11/24 裁定）：控制屏 success=true 只算「已下发」，以回读为准，分已生效 / 未变化 / 结果未知 / 无法核对
  success: { label: '已生效', variant: 'green' },
  unapplied: { label: '未变化', variant: 'orange' },
  unverifiable: { label: '无法核对', variant: 'amber' },
  failure: { label: '失败', variant: 'red' },
  unknown: { label: '结果未知', variant: 'orange' },
  'not-sent': { label: '未下发', variant: 'gray' },
}

/** 汇总值为 null 时：有房间没回报 → 未知（不能显示成「关」）；都回报了但不一样 → 不一致 */
const unreported = (vals: ReadonlyArray<number | null> | undefined) => !vals || vals.some((v) => v === null)
const fmtSnap = (s: UnifiedSnapshot | null | undefined) => {
  if (!s) return '未读到'
  if (!s.rooms) return '无房间'
  const sw = s.roomSwitch === 1 ? '开' : s.roomSwitch === 0 ? '关' : unreported(s.perRoom?.roomSwitch) ? '开关未知' : '开关不一致'
  const t = s.roomTemp != null ? s.roomTemp.toFixed(1) + '°C' : unreported(s.perRoom?.roomTemp) ? '温度未知' : '温度不一致'
  return `房间${sw} · ${t}`
}

/** 每行的说明：结果原因 + 下发前后回读的回显 */
function rowDetail(r: BatchRow): string {
  const s = r.state
  // 截止时间到了：以批次判定为准，附上当时已有的回读
  if (r.note) return [r.note, 'before' in s && s.before ? `回读：下发前 ${fmtSnap(s.before as UnifiedSnapshot)}` : ''].filter(Boolean).join('；')
  const echo = (before?: UnifiedSnapshot, after?: UnifiedSnapshot | null) => `回读：下发前 ${fmtSnap(before)}，下发后 ${fmtSnap(after)}`
  switch (s.status) {
    case 'success':
      return [s.via === 'reply' ? TEXT.success : `${TEXT.success}（${TEXT.verified}）`, echo(s.before, s.after)].join('；')
    // 逐字段的不一致 / 没回报放在字段明细里（rowFields），这里只留结论、未重试说明和前后回读
    case 'unapplied':
      return [TEXT.unapplied, TEXT.retryHint, echo(s.before, s.after)].join('；')
    case 'unverifiable':
      return [TEXT.unverifiable, TEXT.retryHint, echo(s.before, s.after)].join('；')
    case 'failure':
      return [s.error, s.afterError, TEXT.retryHint, s.before ? echo(s.before, s.after) : ''].filter(Boolean).join('；')
    case 'unknown':
      // 回读请求本身失败（after=null）：只提示回读失败，不列逐字段的「设备未回报」（那是回读成功但没读数，不是一回事）
      return [s.error, s.cause, s.afterError, TEXT.retryHint, echo(s.before, s.after)].filter(Boolean).join('；')
    case 'idle':
      return s.errors.join('；') || TEXT.aborted
    default:
      return ''
  }
}

// 最近一次结果：203 下发不会出现在 unified-ctrls-records 里，没有可查的历史，只存在本标签页（sessionStorage）。
// 键 = 数据源 + 稳定的账号标识（/me 的 user id，没有就用令牌的 sub；演示模式用演示账号名），
// 换账号或换数据源都看不到别的结果
const LAST_KEY = 'hjc-unified-last:'
export function lastResultKey(mock: boolean, username: string): string | null {
  if (mock) return username ? `mock:${username}` : null
  const id = getCurrentUserId() || jwtSub(readTokens()?.accessToken)
  return id ? `real:${id}` : null
}
const isRow = (r: unknown): r is ResultRow => {
  const x = r as Partial<ResultRow> | null
  return !!x && typeof x.name === 'string' && typeof x.code === 'string' && typeof x.at === 'string' && typeof x.status === 'string' && Object.hasOwn(STATUS, x.status)
}
const isLockRef = (l: unknown): l is ResultRow['lock'] => {
  const x = l as { key?: unknown; exp?: unknown; projectId?: unknown; query?: Record<string, unknown> | null; replied?: unknown } | null
  return !!x && typeof x.key === 'string' && Number.isFinite(x.exp) && typeof x.projectId === 'string' && typeof x.replied === 'boolean'
    // 运行模式只认 0（不变）和可选模式：旧版本（#60）存下的 -1 丢掉锁引用，不按它显示「运行模式：-1」
    && isStoredQuery203(x.query)
}
function readLast(key: string | null): ResultRow[] | null {
  if (!key) return null
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(LAST_KEY + key) ?? 'null')
    // 逐字段明细不合规（旧版本存的、被改过的）就丢掉明细，只按原来的说明显示
    const okFields = (f: unknown) => Array.isArray(f) && f.every((x) => x && typeof x.label === 'string' && Object.hasOwn(FIELD_BADGE, x.status) && Array.isArray(x.messages))
    return Array.isArray(v) ? v.filter(isRow).map((r) => (typeof r.title === 'string' && okFields(r.fields) ? r : { ...r, title: undefined, fields: undefined }))
      .map((r) => (r.lock === undefined || isLockRef(r.lock) ? r : { ...r, lock: undefined })) : null
  } catch { return null }
}
function writeLast(key: string | null, rows: ResultRow[]) {
  if (!key) return
  try { sessionStorage.setItem(LAST_KEY + key, JSON.stringify(rows)) } catch { /* 存不下不影响显示 */ }
}

const toResult = (r: BatchRow): ResultRow => ({
  name: r.name, code: r.code, at: r.at ?? '—', detail: rowDetail(r), ...rowFields(r),
  notExecuted: r.notExecuted === true || (r.status === 'failure' && r.state.status === 'failure' && r.state.outcome === 'not-sent'),
  status: r.status === 'waiting' || r.status === 'sending' ? 'not-sent' : r.status,
})

export default function Control() {
  const { toast, scope, user } = useApp()
  // 在真正发起下发的组件里取 confirm（分工第 7 条）：本组件卸载、换路由、换项目时确认自动失效
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const session = useSession()
  const isAdmin = user.role === 'admin'
  const { projects } = scope
  const mock = isMockMode()
  const [dealerId, setDealerId] = useDealerPick(scope.dealers)
  const dealersQ = useDealers()
  const groups = isAdmin ? scope.groups.filter((g) => g.dealerId === dealerId) : scope.groups
  const [gidRaw, setGid] = useState('')
  const gid = groups.some((g) => g.id === gidRaw) ? gidRaw : groups[0]?.id ?? ''
  const [pq, setPq] = useState('')
  // 按 Group.projectIds 判断归属：一个项目可能属于多个集成项目
  const inGroup = projectsInGroup(groups.find((g) => g.id === gid), projects)
  const pickNames = seqNames(inGroup, (p) => p.name, (p) => p.id)
  const ps = inGroup.filter((p) => !pq.trim() || (p.name + p.code).toLowerCase().includes(pq.trim().toLowerCase()))
  const [pickedRaw, setPicked] = useState<string[]>(() => (__HJC_MOCK__ && mock ? ['PRJ-10241', 'PRJ-10242', 'PRJ-10243', 'PRJ-10245'] : []))
  const picked = pickedRaw.filter((id) => inGroup.some((p) => p.id === id))
  const [expand, setExpand] = useState(false)
  const [power, setPower] = useState<Tri>('不变')
  const [mode, setMode] = useState<Mode>(MODE_UNCHANGED)
  const [roomSw, setRoomSw] = useState<RoomTri>('不变')
  const [temp, setTemp] = useState(26)
  const [keep, setKeep] = useState(true)
  const lastKey = lastResultKey(mock, user.username)
  const [lastRun, setLastRun] = useState<{ key: string | null; rows: ResultRow[] } | null>(null)
  const last: ResultRow[] | null = (lastRun && lastRun.key === lastKey ? lastRun.rows : readLast(lastKey))
  const [showNotes, setShowNotes] = useState(false)

  const readSnap = mock ? (id: string) => api.mockUnifiedRead(id) : readUnifiedSnapshot
  const { batch, state: run } = useUnifiedBatch({
    getProjects: () => projects,
    mock,
    // 写锁的自动再核对也走这里：读数挂到这次核对上，写锁收下这次核对才保存，退避用完后按它定最终结论
    readBack: (id, signal) => readSnap(id, signal).then((s) => { attachEvidence(signal, s); return s }),
    // 演示下发同写入口一样，先过 beforeSend
    send: mock ? (p, q, o) => (o.beforeSend() ? api.mockUnifiedSend(p, q) : Promise.reject(new ApiError('write_blocked', WRITE_RECHECK_TEXT))) : undefined,
    // 确认后、整批开始前强制重新拉一次项目列表（每批一次，直接调数据源，不经 S6a 的 hooks 缓存）
    refreshProjects: (signal) => orgSource().projects({ user: session.user, dealerAccount: session.dealerAccount }, {}, signal),
    // 账号绑定：确认时记下，发送前核对
    // 真实模式只认存储里令牌的 sub（就是实际要用的令牌的账号）；解析不出 sub 一律不发（登录状态异常）
    getAccount: () => (mock ? user.username || null : jwtSub(readTokens()?.accessToken) || null),
  })
  const busy = run.phase === 'confirming' || run.phase === 'running'
  // 写锁：订阅锁的变化；不在下发中时，已选项目里有被占的（同一块屏上一条还没有结论）就提示并置灰下发按钮
  const lockV = useSyncExternalStore(subscribeLock, lockVersion, lockVersion)
  const shownLast = last?.map(shown) ?? null
  // 界面不显示项目 id（S13 走查）：同名项目用序号区分
  const lastNames = seqNames(shownLast ?? [], (r) => r.name, (r) => r.code)
  // 写锁结束了（核对一致放开 / 到期）：把这一行定下来并存进本标签页（刷新后也是最终结论）
  useEffect(() => {
    if (!last?.some((r) => settledRow(r))) return
    const rows = last.map((r) => settledRow(r) ?? r)
    setLastRun({ key: lastKey, rows })
    writeLast(lastKey, rows)
  }, [lockV, last, lastKey])
  // 锁到期放开时发出「强制重读」：与本页项目有关就重读一次房间状态
  useEffect(() => onForceReread((ev) => {
    if (rereadHits(ev, projects)) void queryClient.invalidateQueries({ queryKey: ['unified-snap'] })
  }), [projects, queryClient])

  const online = inGroup.filter((p) => p.online)
  const pickedP = picked.map((id) => projects.find((p) => p.id === id)!).filter(Boolean)
  const shownP = expand ? ps : ps.slice(0, 7)
  const locks = busy ? [] : pickedP.map((p) => ({ p, l: lockOf(lockTargetOf(p)) })).filter((x) => x.l)
  // 别的账号占着的锁：只用 OTHER_ACCOUNT_TEXT，不带锁里的任何信息
  const lockNote = !locks.length ? null
    : locks.some((x) => x.l!.owner === 'other-account') ? OTHER_ACCOUNT_TEXT
    : `${LOCK_BUSY_TEXT}（${locks.map((x) => x.p.name).join('、')}），请等结果确认后再下发`

  // 温度设定：按 app_code（同组相同；已选项目优先，没选时看组内项目）。8、12 及未知类型不可用
  const range = resolveTempRange(null)
  const appBlock = (pickedP.length ? pickedP : inGroup).map((p) => tempAvailability(unifiedAppCode(p.programCode, mock))).find((a) => !a.enabled)
    ?? (inGroup.length ? undefined : tempAvailability(undefined))
  const roomOff = roomSw === '全部关闭'
  // 房间关着（后端 11/25 答复第 16 条）：温度设定照样生效，不会把房间打开，开启后按此温度运行——不再禁用温度，只给提示。
  // 房间开关未上报（roomSwitchReported() 为 false，11/25 第 1 条）时 200 的开关读数不可信，不读、不据此提示
  const switchReported = roomSwitchReported()
  const snaps = useQueries({
    queries: (switchReported ? pickedP.filter((p) => p.online) : []).map((p) => ({
      queryKey: ['unified-snap', mock, p.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => readSnap(p.id, signal),
      staleTime: 15_000, retry: false,
    })),
  })
  const onlinePicked = switchReported ? pickedP.filter((p) => p.online) : []
  const roomsOffP = onlinePicked.filter((_, i) => { const d = snaps[i]?.data; return !!d && d.rooms > 0 && d.roomSwitch === 0 })
  const tempLock: string | null = appBlock && !appBlock.enabled ? appBlock.reason : null
  const roomsNote = keep || tempLock !== null || roomSw === '全部开启' ? null
    : roomOff ? `房间将被关闭，设定的温度${TEXT.tempWhenRoomOn}`
    : roomsOffP.length ? `房间都关着（${roomsOffP.map((p) => p.name).join('、')}），设定的温度${TEXT.tempWhenRoomOn}`
    : null
  const tempOff = keep || tempLock !== null
  const tempDisabled = tempOff || busy
  const setT = (v: number) => setTemp(clampTemp(v, range))

  const draft: UnifiedDraft = {
    systemSwitch: power === '开启' ? 1 : power === '关闭' ? 0 : undefined,
    systemMode: mode === MODE_UNCHANGED ? undefined : mode,
    roomSwitch: roomSw === '全部开启' ? 1 : roomSw === '全部关闭' ? 0 : undefined,
    roomTemp: tempOff ? undefined : temp,
  }
  const modeLabel = MODES.find((m) => m.value === mode)!.label

  const send = async () => {
    if (busy || lockNote) return
    if (!picked.length) return toast('请至少选择一个项目', true)
    const s = batch.prepare(picked, draft)
    if (s.phase !== 'confirming') return toast(s.errors[0] ?? TEXT.failure, true)
    const ok = await confirm({
      title: '确认下发统一控制指令',
      body: <>将向以下 <b>{s.rows.length}</b> 个项目逐个下发，并覆盖用户本地设置：
        <div className="kv">{s.items.map((i) => <div key={i.label}><span>{i.label}</span><b>{i.value}</b></div>)}</div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>{[...seqNames(s.rows, (r) => r.name, (r) => r.code).values()].join('、')}</div>
        {s.items.some((i) => i.label === TEXT.roomTemp) && <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>{TEXT.tempOffNote}。</div>}
        <div className="muted" style={{ marginTop: 4, fontSize: 12.5 }}>下发前后各读一次当前状态用于核对；失败不会自动重试。</div></>,
      okText: TEXT.confirmOk, danger: true,
    })
    if (!ok) { batch.cancel(); return }
    const startedAt = Date.now()
    const done = await batch.start()
    // 没核对一致的行：记下写锁（它会接着自动再核对），结果卡片据此显示「正在核对」直到退避用完或核对一致。
    // 批次还没结束、写锁的自动核对就已一致放开的（这块屏上本批次发出的那把锁）：直接定为已生效
    const rows = done.rows.map((br): ResultRow => {
      const row = toResult(br)
      const p = projects.find((x) => x.id === br.id)
      if (!p || !SETTLE_STATUSES.has(row.status) || row.notExecuted) return row
      const target = lockTargetOf(p)
      const l = lockOf(target)
      const s = br.state
      // 应答是否 success：结果未知的看状态机；截止时还在下发中（没收到应答）的看批次记的 replyOk
      const replied = s.status === 'unknown' ? s.replied : s.status === 'sending' ? br.replyOk === true : true
      const ref = 'query' in s && s.query ? { projectId: p.id, query: s.query, replied } : null
      // 待核对（unknown），以及截止时还没收到应答、锁仍在 sent 的：都记锁引用，应答到达后按写锁的最终结论显示
      if (l) return ref && l.mine && (l.phase === 'unknown' || l.phase === 'sent') && l.expiresAt !== undefined ? { ...row, lock: { key: l.key, exp: l.expiresAt, ...ref } } : row
      const end = lockKeysOf(target).map(endOf).find(Boolean)
      return end && end.how === 'applied' && end.expiresAt - writeLockTtl() >= startedAt ? appliedRow(row) : row
    })
    setLastRun({ key: lastKey, rows })
    writeLast(lastKey, rows)
    setShowNotes(false)
    // 有项目真的发出过写请求才刷新房间状态
    if (rows.some((r) => r.status !== 'not-sent' && !r.notExecuted)) void queryClient.invalidateQueries({ queryKey: ['unified-snap'] })
    batch.reset()
    // 还在自动核对的行不报结论，单独计「正在核对」
    const isSettling = (r: ResultRow) => liveOf(r)?.kind === 'settling'
    const settlingN = rows.filter(isSettling).length
    const n = (st: ResultRow['status']) => rows.map(shown).filter((r, i) => r.status === st && !isSettling(rows[i])).length
    // 只有全部回读一致（已生效）才弹成功提示
    if (n('success') === rows.length) toast(`${TEXT.success}（${rows.length} 个项目）`)
    else if (n('success') + settlingN === rows.length) toast([n('success') && `已生效 ${n('success')} 个`, `正在核对 ${settlingN} 个`].filter(Boolean).join('，') + '。已下发，正在自动核对')
    else toast([
      n('success') && `已生效 ${n('success')} 个`, settlingN && `正在核对 ${settlingN} 个`, n('unapplied') && `未变化 ${n('unapplied')} 个`, n('unverifiable') && `无法核对 ${n('unverifiable')} 个`,
      n('unknown') && `结果未知 ${n('unknown')} 个`, n('failure') && `失败 ${n('failure')} 个`, n('not-sent') && `未下发 ${n('not-sent')} 个`,
    ].filter(Boolean).join('，') + '。请稍后刷新确认，未自动重试', true)
  }

  const opt = <T,>(cur: T, v: T, set: (v: T) => void, label: ReactNode, key: string) =>
    <button key={key} type="button" className={'opt-btn' + (cur === v ? ' on' : '')} aria-pressed={cur === v} disabled={busy} onClick={() => set(v)}>{label}</button>

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>统一控制</h1><div className="sub">对同一项目组内的多个项目批量设置开关、运行模式、房间开关及温度</div></div>
      </div>
      <div className="ctrl">
        <Card>
          <div className="step-h"><span className="sn">1</span>选择项目</div>
          {isAdmin && (
            <Select value={dealerId} disabled={busy} onValueChange={(v) => { setDealerId(v); setGid(''); setPicked([]) }}>
              <SelectTrigger aria-label="经销商" className="mb-2.5 h-10 w-full text-foreground" />
              <SelectContent>{scope.dealers.map((d) => <SelectItem key={d.id} value={d.id}>经销商：{d.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
          {isAdmin && <DealersError dealers={dealersQ} />}
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <Icon icon={faLayerGroup} style={{ position: 'absolute', left: 14, top: 12, color: 'var(--primary)' }} />
            <Select value={gid} disabled={busy} onValueChange={(v) => { setGid(v); setPicked([]) }}>
              <SelectTrigger aria-label="集成项目" className="h-10 w-full pl-[38px] font-medium text-foreground" />
              <SelectContent>{groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <InputGroup className="mb-[14px] h-10"><Icon icon={faMagnifyingGlass} /><InputGroupInput className="min-w-0" placeholder="按项目名称检索" value={pq} onChange={(e) => setPq(e.target.value)} /></InputGroup>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10, fontSize: 13 }}>
            <label className="row" style={{ cursor: 'pointer' }}><Checkbox disabled={busy} checked={picked.length === online.length && online.length > 0} onCheckedChange={(v) => setPicked(v === true ? online.map((p) => p.id) : [])} />全选在线项目</label>
            <span className="muted">已选 <b className="num" style={{ color: 'var(--text)' }}>{picked.length}</b> / {inGroup.length}</span>
          </div>
          {shownP.map((p) => {
            const on = picked.includes(p.id)
            // 离线项目不能选；已选的项目后来离线了仍可取消勾选（下发时会被拦下并提示）
            const can = !busy && (p.online || on)
            return (
              <div key={p.id} className={'pick' + (on ? ' on' : '') + (!p.online ? ' dis' : '')} onClick={() => can && setPicked(on ? picked.filter((x) => x !== p.id) : [...picked, p.id])}>
                <Checkbox checked={on} disabled={!can} aria-label={p.name} />
                <div><b>{pickNames.get(p.id) ?? p.name}</b><small>{p.online ? (p.programCode === 12 ? '新风单机版' : '在线') : '离线 · 不可下发'}</small></div>
                <span className="dot" />
              </div>
            )
          })}
          {ps.length === 0 && <div className="faint" style={{ textAlign: 'center', padding: 20, fontSize: 13 }}>没有匹配的项目</div>}
          {ps.length > 7 && <div className="c muted" style={{ fontSize: 12.5, marginTop: 10, cursor: 'pointer', textAlign: 'center' }} onClick={() => setExpand(!expand)}>{expand ? '收起' : `展开其余 ${ps.length - 7} 个项目`} <Icon icon={expand ? faChevronUp : faChevronDown} size="xs" /></div>}
        </Card>

        <Card>
          <div className="step-h"><span className="sn">2</span>设置控制指令<small>选择「不变」的项不会下发</small></div>
          <div className="sec-h"><span><Icon icon={faPowerOff} className="muted" />系统开关</span></div>
          <div className="opt3" role="group" aria-label="系统开关">{(['开启', '关闭', '不变'] as const).map((x) => opt(power, x, setPower, x, x))}</div>
          <div className="sec-h"><span><Icon icon={faWandMagicSparkles} className="muted" />运行模式</span></div>
          <div className="modes" role="group" aria-label="运行模式" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            {MODES.map((m) => {
              const [ic, c] = MODE_ICON[m.value] ?? [faMinus, '#94a3b8']
              return <button key={m.value} type="button" className={'mode' + (mode === m.value ? ' on' : '')} aria-pressed={mode === m.value} disabled={busy} onClick={() => setMode(m.value)}><Icon icon={ic} style={{ color: c }} />{m.label}</button>
            })}
          </div>
          <div className="sec-h"><span><Icon icon={faDoorOpen} className="muted" />房间开关</span></div>
          <div className="opt3" role="group" aria-label="房间开关">{(['全部开启', '全部关闭', '不变'] as const).map((x) => opt(roomSw, x, setRoomSw, x, x))}</div>
          <div className="sec-h">
            <span><Icon icon={faTemperatureHalf} className="muted" />房间温度设定</span>
            <label className="row muted" style={{ fontWeight: 400, fontSize: 12.5, cursor: tempLock || busy ? 'not-allowed' : 'pointer' }}>
              <Checkbox checked={tempOff} disabled={tempLock !== null || busy} onCheckedChange={(v) => setKeep(v === true)} />保持不变
            </label>
          </div>
          {/* 禁用靠各控件的 disabled 属性（键盘也改不了），透明度只是视觉提示 */}
          <fieldset className="temp-box" data-testid="temp-box" disabled={tempDisabled} aria-disabled={tempDisabled} style={{ margin: 0, minWidth: 0, ...(tempDisabled ? { opacity: 0.5 } : null) }}>
            <legend className="sr-only">房间温度设定</legend>
            <div className="tv">
              <button type="button" className="round" aria-label="降低温度" disabled={tempDisabled || temp <= range.min} onClick={() => setT(temp - range.step)}>−</button>
              <b className="num" aria-live="polite">{temp.toFixed(1)}<small>°C</small></b>
              <button type="button" className="round plus" aria-label="升高温度" disabled={tempDisabled || temp >= range.max} onClick={() => setT(temp + range.step)}>+</button>
            </div>
            {/* 盒子同原生 range：宽 100%、左右 UA 默认外边距 2px、上边距 18px（见 slider.tsx） */}
            <Slider className="mx-[2px] mt-[18px] w-full" aria-label="房间温度设定" disabled={tempDisabled} min={range.min} max={range.max} step={range.step} value={[temp]} onValueChange={([v]) => { if (!tempDisabled) setT(v) }} />
            <div className="ticks num"><span>{range.min}°C</span><span>20°C</span><span>25°C</span><span>{range.max}°C</span></div>
          </fieldset>
          {tempLock && <div className="cap-note" role="note"><Icon icon={faCircleInfo} />{tempLock}{appBlock ? '，房间开关仍可下发。' : ''}</div>}
          {roomsNote && <div className="cap-note" role="note" data-testid="temp-room-note"><Icon icon={faCircleInfo} />{roomsNote}</div>}
        </Card>

        <div className="preview">
          <div className="step-h"><span className="sn">3</span>指令预览</div>
          <div className="pv-kpi"><div><span>目标项目</span><b className="num">{picked.length}<small>个</small></b></div></div>
          <div className="pv-row"><span>系统开关</span><b className={power === '不变' ? 'w' : ''}>{power}</b></div>
          <div className="pv-row"><span>运行模式</span><b className={mode === MODE_UNCHANGED ? 'w' : ''}>{modeLabel}</b></div>
          <div className="pv-row"><span>房间开关</span><b className={roomSw === '不变' ? 'w' : ''}>{roomSw}</b></div>
          <div className="pv-row"><span>温度设定</span><b className={'num ' + (tempOff ? 'w' : '')}>{tempOff ? '不变' : temp.toFixed(1) + '°C'}</b></div>
          <div className="pv-row"><span>执行方式</span><b className="w">立即执行</b></div>
          <div className="pv-warn"><Icon icon={faTriangleExclamation} /> 将覆盖所选项目内用户的本地设置，请谨慎操作。</div>
          {lockNote && <div className="cap-note" role="note"><Icon icon={faCircleInfo} />{lockNote}</div>}
          {!switchReported && roomSw !== '不变' && <div className="cap-note" role="note" data-testid="switch-unreported-note"><Icon icon={faCircleInfo} />{TEXT.switchUnreported}</div>}
          <button className="btn-send" onClick={send} disabled={busy || lockNote !== null}><Icon icon={run.phase === 'running' ? faSpinner : faPaperPlane} spin={run.phase === 'running'} />{run.phase === 'running' ? '下发中…' : TEXT.confirmOk}</button>
        </div>
      </div>

      {/* 下发进度在结果卡片外面；卡片里继续显示上一次的结果 */}
      {run.phase === 'running' && (
        <div className="muted unified-progress" role="status" style={{ margin: '0 0 12px', fontSize: 13 }}>
          <Icon icon={faSpinner} spin /> {run.rows.some((r) => r.replyOk && r.state.status === 'sending' && r.state.step === 'read-after') ? TEXT.verifying : TEXT.sending}全部完成后更新下方结果
        </div>
      )}
      {/* 改动 6：结果卡片只有 项目、项目ID、状态、操作时间 四项，不放任何说明 */}
      <Card pad={false} role="region" aria-label="最近一次执行结果">
        <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14 }}>
          <div><CardTitle>最近一次执行结果</CardTitle></div>
        </CardHeader>
        {!shownLast || shownLast.length === 0 ? (
          <div className="faint" style={{ padding: '18px 22px 22px', fontSize: 13, textAlign: 'center' }}>暂无执行记录</div>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>项目</TableHead><TableHead>状态</TableHead><TableHead>操作时间</TableHead></TableRow></TableHeader>
            <TableBody>
              {shownLast.map((r) => (
                <TableRow key={r.code + r.name}>
                  <TableCell style={{ fontWeight: 500 }}>{lastNames.get(r.code) ?? r.name}</TableCell>
                  {/* 状态列：有逐字段结果的显示标题（单一结果是那个词，混合是计数，Fable 11/25）；逐字段明细在「下发核对」 */}
                  <TableCell><Badge variant={r.badge.variant}>{r.badge.label}</Badge></TableCell>
                  <TableCell className="num muted">{r.at}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* 卡片下方单独的「下发核对」：失败原因、未重试说明、下发前后的回读。默认收起 */}
      {run.phase !== 'running' && shownLast?.some((r) => r.detail) && (
        <Card pad={false} className="unified-check" style={{ marginTop: 16 }}>
          <button type="button" className="row" aria-expanded={showNotes} aria-controls="unified-notes" onClick={() => setShowNotes(!showNotes)}
            style={{ width: '100%', justifyContent: 'space-between', padding: '14px 22px', background: 'none', border: 0, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            <span>下发核对</span>
            <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}>{showNotes ? '收起' : '展开查看原因与前后回读'} <Icon icon={showNotes ? faChevronUp : faChevronDown} size="xs" /></span>
          </button>
          {showNotes && (
            <ul id="unified-notes" className="unified-notes" style={{ margin: 0, padding: '0 22px 18px 40px', fontSize: 12.5, lineHeight: 1.7 }}>
              {shownLast.filter((r) => r.detail).map((r) => (
                <li key={r.code + r.name} className="muted">
                  <b style={{ color: 'var(--text)' }}>{lastNames.get(r.code) ?? r.name}</b>：{r.title ? <b style={{ color: 'var(--text)' }}>{r.title}</b> : r.detail}
                  {/* 逐字段明细：标题下面的紧凑列表，每个字段四种状态之一 */}
                  {r.title && r.fields && (
                    <ul className="unified-fields" aria-label="逐字段结果" style={{ margin: '2px 0 0', padding: '0 0 0 16px', listStyle: 'disc' }}>
                      {r.fields.map((f) => (
                        <li key={f.label}>{f.label}：<Badge variant={FIELD_BADGE[f.status]}>{TEXT.fieldStatus[f.status]}</Badge>{f.messages.length ? `（${f.messages.join('；')}）` : ''}</li>
                      ))}
                    </ul>
                  )}
                  {r.title && <div>{r.detail}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}
