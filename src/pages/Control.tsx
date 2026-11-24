// 统一控制（S12b）：对同一集成项目里选中的在线项目批量下发 ctrl 203。
// 逐个项目走 S12a 的状态机（src/features/unified）：二次确认 → 下发前读 → 203 → 下发后读 → 成功 / 失败 / 结果未确认；不重试。
// 确认弹窗在本组件里用 useConfirm() 取（分工第 7 条）；写入口拿到的是整个 Project（见 batch.ts）。
// 改动文档：app_code 为 8、12 时房间温度设定不可用（房间开关仍可用）；最近一次执行结果只显示 项目、项目 ID、状态、操作时间。
import { useState, type ReactNode } from 'react'
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
import { isMockMode } from '../api/config'
import { getCurrentUserId } from '../api/auth'
import { ApiError } from '../api/errors'
import { WRITE_RECHECK_TEXT } from '../api/http'
import { jwtSub, readTokens } from '../api/tokens'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '../api/gen/ctrl200_pb.js'
import * as api from '../api'
import {
  clampTemp, MODE_OPTIONS, readUnifiedSnapshot, resolveTempRange, TEXT, tempAvailability, unifiedAppCode, useUnifiedBatch,
  type BatchRow, type RowStatus, type UnifiedDraft, type UnifiedSnapshot,
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
const MODES: Array<{ value: Mode; label: string }> = [...MODE_OPTIONS, { value: Mode.OPERATION_MODE_NONE, label: TEXT.unchanged }]

/** 结果表的一行（演示数据与本次下发结果同一形状） */
export interface ResultRow {
  name: string; code: string; status: Exclude<RowStatus, 'waiting' | 'sending'>; at: string
  /** 失败但确定没执行（发送前复核不过、登录状态失效等） */
  notExecuted?: boolean
  /** 原因与前后回读（只在「下发核对」区显示，不进结果卡片） */
  detail?: string
}

const STATUS: Record<ResultRow['status'], { label: string; variant: 'green' | 'red' | 'orange' | 'gray' }> = {
  success: { label: '成功', variant: 'green' },
  failure: { label: '失败', variant: 'red' },
  unknown: { label: '结果未确认', variant: 'orange' },
  'not-sent': { label: '未下发', variant: 'gray' },
}

const fmtSnap = (s: UnifiedSnapshot | null | undefined) => {
  if (!s) return '未读到'
  if (!s.rooms) return '无房间'
  const sw = s.roomSwitch === 1 ? '开' : s.roomSwitch === 0 ? '关' : '不一致'
  return `房间${sw} · ${s.roomTemp == null ? '温度不一致' : s.roomTemp.toFixed(1) + '°C'}`
}

/** 每行的说明：结果原因 + 下发前后回读的回显 */
function rowDetail(r: BatchRow): string {
  const s = r.state
  // 截止时间到了：以批次判定为准，附上当时已有的回读
  if (r.note) return [r.note, 'before' in s && s.before ? `回读：下发前 ${fmtSnap(s.before as UnifiedSnapshot)}` : ''].filter(Boolean).join('；')
  const echo = (before?: UnifiedSnapshot, after?: UnifiedSnapshot | null) => `回读：下发前 ${fmtSnap(before)}，下发后 ${fmtSnap(after)}`
  switch (s.status) {
    case 'success': {
      const head = s.via === 'reply' ? TEXT.success : `${TEXT.success}（${TEXT.verified}）`
      const notes = [s.afterError, ...s.mismatches.map((m) => m.message)].filter(Boolean)
      return [head, ...notes, echo(s.before, s.after)].join('；')
    }
    case 'failure':
      return [s.error, s.afterError, TEXT.retryHint, s.before ? echo(s.before, s.after) : ''].filter(Boolean).join('；')
    case 'unknown':
      return [s.error, s.cause, s.afterError, ...s.mismatches.map((m) => m.message), TEXT.retryHint, echo(s.before, s.after)].filter(Boolean).join('；')
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
function readLast(key: string | null): ResultRow[] | null {
  if (!key) return null
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(LAST_KEY + key) ?? 'null')
    return Array.isArray(v) ? v.filter(isRow) : null
  } catch { return null }
}
function writeLast(key: string | null, rows: ResultRow[]) {
  if (!key) return
  try { sessionStorage.setItem(LAST_KEY + key, JSON.stringify(rows)) } catch { /* 存不下不影响显示 */ }
}

const toResult = (r: BatchRow): ResultRow => ({
  name: r.name, code: r.code, at: r.at ?? '—', detail: rowDetail(r),
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
  const ps = inGroup.filter((p) => !pq.trim() || (p.name + p.code).toLowerCase().includes(pq.trim().toLowerCase()))
  const [pickedRaw, setPicked] = useState<string[]>(() => (__HJC_MOCK__ && mock ? ['PRJ-10241', 'PRJ-10242', 'PRJ-10243', 'PRJ-10245'] : []))
  const picked = pickedRaw.filter((id) => inGroup.some((p) => p.id === id))
  const [expand, setExpand] = useState(false)
  const [power, setPower] = useState<Tri>('不变')
  const [mode, setMode] = useState<Mode>(Mode.OPERATION_MODE_NONE)
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
    readBack: readSnap,
    // 演示下发同写入口一样，先过 beforeSend
    send: mock ? (p, q, o) => (o.beforeSend() ? api.mockUnifiedSend(p, q) : Promise.reject(new ApiError('write_blocked', WRITE_RECHECK_TEXT))) : undefined,
    // 确认后、整批开始前强制重新拉一次项目列表（每批一次，直接调数据源，不经 S6a 的 hooks 缓存）
    refreshProjects: (signal) => orgSource().projects({ user: session.user, dealerAccount: session.dealerAccount }, {}, signal),
    // 账号绑定：确认时记下，发送前核对
    // 真实模式以存储里令牌的 sub 为准（就是实际要用的令牌的账号），没有 sub 才用 /me 的 user id
    // 真实模式只认存储里令牌的 sub（就是实际要用的令牌的账号）；解析不出 sub 一律不发（登录状态异常）
    getAccount: () => (mock ? user.username || null : jwtSub(readTokens()?.accessToken) || null),
  })
  const busy = run.phase === 'confirming' || run.phase === 'running'

  const online = inGroup.filter((p) => p.online)
  const pickedP = picked.map((id) => projects.find((p) => p.id === id)!).filter(Boolean)
  const shownP = expand ? ps : ps.slice(0, 7)

  // 温度设定：按 app_code（同组相同；已选项目优先，没选时看组内项目）。8、12 及未知类型不可用
  const range = resolveTempRange(null)
  const appBlock = (pickedP.length ? pickedP : inGroup).map((p) => tempAvailability(unifiedAppCode(p.programCode, mock))).find((a) => !a.enabled)
    ?? (inGroup.length ? undefined : tempAvailability(undefined))
  const roomOff = roomSw === '全部关闭'
  // 房间都关着（后端答复⑦：房间关闭时界面不允许设温度）：读已选在线项目的 200，某个项目的房间全部关着就禁用温度，
  // 除非这次同时选了「全部开启」。还在读的时候先禁用；读失败不在这里拦（下发前读取失败本来就不会下发）
  const snaps = useQueries({
    queries: pickedP.filter((p) => p.online).map((p) => ({
      queryKey: ['unified-snap', mock, p.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => readSnap(p.id, signal),
      staleTime: 15_000, retry: false,
    })),
  })
  const onlinePicked = pickedP.filter((p) => p.online)
  const roomsOffP = onlinePicked.filter((_, i) => { const d = snaps[i]?.data; return !!d && d.rooms > 0 && d.roomSwitch === 0 })
  const snapsLoading = snaps.some((q) => q.isPending)
  const roomsLock = roomSw === '全部开启' ? null
    : roomsOffP.length ? `房间都关着（${roomsOffP.map((p) => p.name).join('、')}），不能设定温度；需要时同时选「全部开启」`
    : snapsLoading ? '正在读取房间状态…' : null
  const tempLock: string | null = appBlock && !appBlock.enabled ? appBlock.reason : roomOff ? TEXT.tempWhileRoomOff : roomsLock
  const tempOff = keep || tempLock !== null
  const tempDisabled = tempOff || busy
  const setT = (v: number) => setTemp(clampTemp(v, range))

  const draft: UnifiedDraft = {
    systemSwitch: power === '开启' ? 1 : power === '关闭' ? 0 : undefined,
    systemMode: mode === Mode.OPERATION_MODE_NONE ? undefined : mode,
    roomSwitch: roomSw === '全部开启' ? 1 : roomSw === '全部关闭' ? 0 : undefined,
    roomTemp: tempOff ? undefined : temp,
  }
  const modeLabel = MODES.find((m) => m.value === mode)!.label

  const send = async () => {
    if (busy) return
    if (!picked.length) return toast('请至少选择一个项目', true)
    const s = batch.prepare(picked, draft)
    if (s.phase !== 'confirming') return toast(s.errors[0] ?? TEXT.failure, true)
    const ok = await confirm({
      title: '确认下发统一控制指令',
      body: <>将向以下 <b>{s.rows.length}</b> 个项目逐个下发，并覆盖用户本地设置：
        <div className="kv">{s.items.map((i) => <div key={i.label}><span>{i.label}</span><b>{i.value}</b></div>)}</div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>{s.rows.map((r) => `${r.name}（${r.code}）`).join('、')}</div>
        <div className="muted" style={{ marginTop: 4, fontSize: 12.5 }}>下发前后各读一次当前状态用于核对；失败不会自动重试。</div></>,
      okText: TEXT.confirmOk, danger: true,
    })
    if (!ok) { batch.cancel(); return }
    const done = await batch.start()
    const rows = done.rows.map(toResult)
    setLastRun({ key: lastKey, rows })
    writeLast(lastKey, rows)
    setShowNotes(false)
    // 有项目真的发出过写请求才刷新房间状态
    if (rows.some((r) => r.status !== 'not-sent' && !r.notExecuted)) void queryClient.invalidateQueries({ queryKey: ['unified-snap'] })
    batch.reset()
    const n = (st: ResultRow['status']) => rows.filter((r) => r.status === st).length
    if (n('success') === rows.length) toast(`${TEXT.success}（${rows.length} 个项目）`)
    else toast([n('success') && `成功 ${n('success')} 个`, n('failure') && `失败 ${n('failure')} 个`, n('unknown') && `结果未确认 ${n('unknown')} 个，请刷新查看`, n('not-sent') && `未下发 ${n('not-sent')} 个`].filter(Boolean).join('，') + '。未自动重试', true)
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
            <span className="faint num" style={{ position: 'absolute', right: 34, top: 12, fontSize: 12, pointerEvents: 'none' }}>{groups.find((g) => g.id === gid)?.code ?? gid}</span>
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
                <div><b>{p.name}</b><small className="num">{p.online ? `${p.code} · ${p.version}${p.programCode === 12 ? ' · 新风单机版' : ''}` : '离线 · 不可下发'}</small></div>
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
            <div className="c muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 4 }}>推荐夏季 26°C</div>
            {/* 盒子同原生 range：宽 100%、左右 UA 默认外边距 2px、上边距 18px（见 slider.tsx） */}
            <Slider className="mx-[2px] mt-[18px] w-full" aria-label="房间温度设定" disabled={tempDisabled} min={range.min} max={range.max} step={range.step} value={[temp]} onValueChange={([v]) => { if (!tempDisabled) setT(v) }} />
            <div className="ticks num"><span>{range.min}°C</span><span>20°C</span><span>25°C</span><span>{range.max}°C</span></div>
          </fieldset>
          {tempLock && <div className="cap-note" role="note"><Icon icon={faCircleInfo} />{tempLock}{appBlock ? '，房间开关仍可下发。' : ''}</div>}
        </Card>

        <div className="preview">
          <div className="step-h"><span className="sn">3</span>指令预览</div>
          <div className="pv-kpi"><div><span>目标项目</span><b className="num">{picked.length}<small>个</small></b></div></div>
          <div className="pv-row"><span>系统开关</span><b className={power === '不变' ? 'w' : ''}>{power}</b></div>
          <div className="pv-row"><span>运行模式</span><b className={mode === Mode.OPERATION_MODE_NONE ? 'w' : ''}>{modeLabel}</b></div>
          <div className="pv-row"><span>房间开关</span><b className={roomSw === '不变' ? 'w' : ''}>{roomSw}</b></div>
          <div className="pv-row"><span>温度设定</span><b className={'num ' + (tempOff ? 'w' : '')}>{tempOff ? '不变' : temp.toFixed(1) + '°C'}</b></div>
          <div className="pv-row"><span>执行方式</span><b className="w">立即执行</b></div>
          <div className="pv-warn"><Icon icon={faTriangleExclamation} /> 将覆盖所选项目内用户的本地设置，请谨慎操作。</div>
          <button className="btn-send" onClick={send} disabled={busy}><Icon icon={run.phase === 'running' ? faSpinner : faPaperPlane} spin={run.phase === 'running'} />{run.phase === 'running' ? '下发中…' : TEXT.confirmOk}</button>
        </div>
      </div>

      {/* 下发进度在结果卡片外面；卡片里继续显示上一次的结果 */}
      {run.phase === 'running' && (
        <div className="muted unified-progress" role="status" style={{ margin: '0 0 12px', fontSize: 13 }}>
          <Icon icon={faSpinner} spin /> {TEXT.sending}全部完成后更新下方结果
        </div>
      )}
      {/* 改动 6：结果卡片只有 项目、项目ID、状态、操作时间 四项，不放任何说明 */}
      <Card pad={false} role="region" aria-label="最近一次执行结果">
        <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14 }}>
          <div><CardTitle>最近一次执行结果</CardTitle></div>
        </CardHeader>
        {!last || last.length === 0 ? (
          <div className="faint" style={{ padding: '18px 22px 22px', fontSize: 13, textAlign: 'center' }}>暂无执行记录</div>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>项目</TableHead><TableHead>项目ID</TableHead><TableHead>状态</TableHead><TableHead>操作时间</TableHead></TableRow></TableHeader>
            <TableBody>
              {last.map((r) => (
                <TableRow key={r.code + r.name}>
                  <TableCell style={{ fontWeight: 500 }}>{r.name}</TableCell>
                  <TableCell className="num muted">{r.code}</TableCell>
                  <TableCell><Badge variant={STATUS[r.status].variant}>{r.notExecuted ? '失败（未执行）' : STATUS[r.status].label}</Badge></TableCell>
                  <TableCell className="num muted">{r.at}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* 卡片下方单独的「下发核对」：失败原因、未重试说明、下发前后的回读。默认收起 */}
      {run.phase !== 'running' && last?.some((r) => r.detail) && (
        <Card pad={false} className="unified-check" style={{ marginTop: 16 }}>
          <button type="button" className="row" aria-expanded={showNotes} aria-controls="unified-notes" onClick={() => setShowNotes(!showNotes)}
            style={{ width: '100%', justifyContent: 'space-between', padding: '14px 22px', background: 'none', border: 0, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            <span>下发核对</span>
            <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}>{showNotes ? '收起' : '展开查看原因与前后回读'} <Icon icon={showNotes ? faChevronUp : faChevronDown} size="xs" /></span>
          </button>
          {showNotes && (
            <ul id="unified-notes" className="unified-notes" style={{ margin: 0, padding: '0 22px 18px 40px', fontSize: 12.5, lineHeight: 1.7 }}>
              {last.filter((r) => r.detail).map((r) => <li key={r.code + r.name} className="muted"><b style={{ color: 'var(--text)' }}>{r.name}（{r.code}）</b>：{r.detail}</li>)}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}
