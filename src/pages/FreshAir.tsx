// 新风除湿机页（S10b 只读 + S10c 下发）：ctrl 202 设备状态 + ctrl 210 运行设置，204 运行设置下发；数据层见 src/features/freshAir。
// 当前项目用 useCurrentProject()（docs/分工.md 第 3 节第 6 条）：没有项目、项目离线、没有权限时不发 ctrl 请求。
// 下发（S10c）：只在运行设置面板（SettingsPanel，真正发起下发的组件）里取 useConfirm() 确认，确认后同步复核项目、锁、草稿，
// 再交给 features/freshAir/writes.ts 的 runFreshAirSet（温控同一个 runOp 状态机：按控制屏加锁 → 新读 202 + 210 预检、用新读数
// 重新组装 204 并与确认时比对 → 统一写入口下发 → 210 回读核对，一致才提示已生效、清草稿、放锁）。
// 面板只读的情况：features.freshAirWrite = 'off'、账号没有 204 权限（保留 S10b 的只读形态）；210「不支持」、读取失败等不显示下发入口。
// 显示口径（docs/plan-s10-s7.md S10b、规则草稿 S10 节）：
// - 实时数据（改动 11）只放 202 有的字段；设备汇总（改动 12）：设备、开关、模式、运行时间、滤网运行时间、滤网寿命（%）；
// - 运行设置（改动 13）只在 app_code 12 显示；210 读到 -1 的项不能设置；control_type = -1 时控制类型、露点、湿度不能设置，
//   风速、开关照常；-100 / 65536 显示 --；0 是有效值；
// - 202 里未连接的设备不显示读数（不把旧值当当前值），也不读 210；
// - 滤网：filter_life 是天数，filter_life_p 是比例（显示乘 100）；告警颜色和「请尽快更换」受 features.freshAirFilterWarn 控制（默认关）。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { faFan, faPaperPlane, faRotate, faFilter, faLock, faGears, faPowerOff, faBuilding, faPlugCircleXmark, faTriangleExclamation, faCircleInfo, faTemperatureLow, faDroplet, faSignal, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { Icon } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getConfig } from '../api/config'
import { defaultText } from '../api/errors'
import { PLACEHOLDER } from '../api/values'
import { lockKeysOf, lockOf, onForceReread, OTHER_ACCOUNT_TEXT, verify, type FieldResult, type LockInfo } from '../api/writeLock'
import { describeFields, LABEL_204, verdictOf, type Field204 } from '../api/writeLockVerify'
import { showToast, useConfirm } from '../app/feedback'
import { useCurrentProject, type Project } from '../data/org'
import { timeLabel } from '../data/sensors'
import { clearResult as clearResultOf, isLocked, noteCurrentProject, useWrites, type Running, type WriteResult } from '../features/thermostat/writes'
import {
  build204, canStepSetpoint, CONTROL_TYPES, describeChanges, describeDraft, describeResult, draftChanges, editBlock, editDraft, faTarget, FIELD_STATE,
  fieldBlock, hasSettings, isGood, panelBlock, reconcileDraft, resultText, runFreshAirSet, shownOf, stepSetpoint, SWITCHES_210,
  TEXT_CT_LOCKED, TEXT_DEVICE_OFF, useFreshPair, writableReason, useRefetchFreshAir, useSettings, useUnits, valueText, VERDICT_TEXT, WIND_SPEEDS_210,
  type FaCtx, type FaDraft, type FreshPair, type SettingsState, type SettingsView, type UnitView,
} from '../features/freshAir'

/** 210 回「该软件类型不支持此控制」时面板的说明 */
export const TEXT_UNSUPPORTED_PANEL = '该项目的控制屏不支持运行设置，这不是故障。设备状态仍按上方实时数据显示。'

const num = (v: number | null, digits = 0, unit = '') => (v === null ? PLACEHOLDER : `${v.toFixed(digits)}${unit}`)
const unitName = (u: UnitView, i: number) => u.name || `新风设备 ${i + 1}`
/** 压缩机状态（A6）：0 停止、1 运行，其他显示原数字 */
const compressorText = (v: number | null) => (v === null ? PLACEHOLDER : v === 0 ? '停止' : v === 1 ? '运行' : String(v))
const statusOf = (u: UnitView): [string, 'green' | 'gray' | 'red'] => (!u.connected ? ['未连接', 'red'] : u.on === null ? ['开关未知', 'gray'] : u.on ? ['运行中', 'green'] : ['已关机', 'gray'])
const warnOn = () => getConfig().features.freshAirFilterWarn === true

function PageHead({ project, count, right }: { project: Project | null; count?: number; right?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>新风除湿机</h1>
        {project && <div className="sub"><span><Icon icon={faBuilding} /> {project.name}</span>{count !== undefined && <><span className="sep">·</span>{count} 台新风除湿一体机</>}{hasSettings(project) && <><span className="sep">·</span>新风单机版</>}</div>}
      </div>
      {right}
    </div>
  )
}

function Placeholder({ icon, title, text, onRetry, alert }: { icon: IconDefinition; title: string; text: string; onRetry?: () => void; alert?: boolean }) {
  return (
    <Card className="placeholder" role={alert ? 'alert' : 'status'}>
      <div className="ph-ico"><Icon icon={icon} /></div>
      <h3>{title}</h3>
      <p>{text}</p>
      {onRetry && <Button style={{ marginTop: 16 }} onClick={onRetry}>重试</Button>}
    </Card>
  )
}

function Ring({ pct, color }: { pct: number | null; color: string }) {
  const r = 52, c = 2 * Math.PI * r
  return (
    <svg width="124" height="124" viewBox="0 0 132 132" aria-hidden="true">
      <circle cx="66" cy="66" r={r} stroke="#e2f5ee" strokeWidth="11" fill="none" />
      {pct !== null && <circle cx="66" cy="66" r={r} stroke={color} strokeWidth="11" fill="none" strokeLinecap="round"
        strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 66 66)" style={{ transition: 'stroke-dasharray .6s' }} />}
      <text x="66" y="70" textAnchor="middle" fontSize="30" fontWeight="600" fontFamily="Barlow" fill="#0f172a">{pct === null ? PLACEHOLDER : `${pct}%`}</text>
      <text x="66" y="92" textAnchor="middle" fontSize="11" fill="#94a3b8">剩余</text>
    </svg>
  )
}

/** 滤网：颜色和提示只在 freshAirFilterWarn 打开时按比例给出；关着时一律中性色、只写剩余天数 */
function filterLook(u: UnitView): { color: string; bar: string | undefined; text: string; cls: string } {
  const { level, days } = u.filter
  const left = days === null ? '剩余天数暂无数据' : `剩余 ${days} 天`
  if (!warnOn() || level === null) return { color: '#10b981', bar: undefined, text: left, cls: '' }
  if (level === 'red') return { color: '#f43f5e', bar: 'var(--red)', text: `滤网寿命不足，请尽快更换（${left}）`, cls: 'red' }
  if (level === 'orange') return { color: '#f59e0b', bar: 'var(--amber)', text: `滤网已使用过半（${left}）`, cls: 'orange' }
  return { color: '#10b981', bar: undefined, text: `状态良好（${left}）`, cls: '' }
}

function LiveCard({ u, name, wide }: { u: UnitView; name: string; wide: boolean }) {
  const [st, color] = statusOf(u)
  const head = <CardHeader><CardTitle>实时数据 · <span className="num">{name}</span></CardTitle><Badge variant={color}><span className="dot" />{st}</Badge></CardHeader>
  if (!u.connected) return (
    <Card>
      {head}
      <div className="placeholder" role="status" style={{ boxShadow: 'none', border: 0 }}>
        <div className="ph-ico"><Icon icon={faPlugCircleXmark} /></div>
        <h3>设备未连接</h3>
        <p>控制屏报告这台设备未连接，暂无实时数据。</p>
      </div>
    </Card>
  )
  const f = filterLook(u)
  const tiles: [string, string, string?][] = [
    ['送风温度', num(u.supplyTemp, 1, ' °C')], ['回风温度', num(u.returnTemp, 1, ' °C')],
    ['风速档位', num(u.windLevel)], ['风机转速', num(u.fanSpeed)],
    ['压缩机状态', compressorText(u.compressorStatus), u.compressorStatus === 1 ? 'green' : u.compressorStatus === 0 ? 'faint' : undefined], ['压缩机频率', num(u.compressorFreq, 0, ' Hz')],
    ['运行时间', num(u.runningTime)], ['运行模式', u.runningMode || PLACEHOLDER],
  ]
  return (
    <Card>
      {head}
      <div className="fa-banner">
        <div className="fb-filter">
          <Ring pct={u.filter.percent} color={f.color} />
          <div style={{ flex: 1 }}>
            <b className="fb-t"><Icon icon={faFilter} />滤网寿命</b>
            <div className={'fb-s ' + f.cls} data-testid="filter-text">{f.text}</div>
            <div className="bar" style={{ height: 8, margin: '12px 0 8px' }}><i style={{ width: (u.filter.percent ?? 0) + '%', background: f.bar }} /></div>
            <small className="muted num">滤网运行时间 {num(u.filterRunning)}</small>
          </div>
        </div>
      </div>
      <div className={'fa-tiles' + (wide ? ' six' : '')}>
        {tiles.map(([l, v, c]) => <div key={l}><span>{l}</span><b className={'num ' + (c ?? '')}>{v}</b></div>)}
      </div>
    </Card>
  )
}

/** 运行设置的一项：值；不能设置时带锁和原因（Tooltip 挂在可聚焦的锁图标上） */
function SettingRow({ s, f, label, value, active }: { s: SettingsView; f: Field204; label: string; value: string; active?: boolean }) {
  const why = fieldBlock(s, f)
  return (
    <div className={'setbox' + (why ? ' dis' : active ? ' on' : '')} data-field={f}>
      <div className="sh">
        <div><b>{label}</b></div>
        {why ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} role="img" aria-label={`${label}不能设置：${why}`} className="faint" style={{ fontSize: 12 }}><Icon icon={faLock} /> 不可设置</span>
            </TooltipTrigger>
            <TooltipContent>{why}</TooltipContent>
          </Tooltip>
        ) : active ? <Badge style={{ background: 'var(--primary-2)', color: '#fff' }}>生效中</Badge> : null}
      </div>
      <div className="stepper"><span className="sv num">{value}</span></div>
    </div>
  )
}

function SettingsBody({ s }: { s: SettingsView }) {
  const fl = s.fields
  const ct = fl.controlType.value
  const ctText = ct === null ? PLACEHOLDER : CONTROL_TYPES[ct]
  return (
    <>
      <SettingRow s={s} f="switch" label="开关" value={fl.switch.value === null ? PLACEHOLDER : SWITCHES_210[fl.switch.value]} />
      <SettingRow s={s} f="controlType" label="控制类型" value={ctText} />
      {ct !== null && !s.canChange && <div className="ctl-hint"><Icon icon={faLock} />该设备的控制类型不可切换</div>}
      <SettingRow s={s} f="dewPoint" label="露点设定" value={num(fl.dewPoint.value, 1, ' °C')} active={ct === 1} />
      <SettingRow s={s} f="humiditySet" label="湿度设定" value={num(fl.humiditySet.value, 0, ' %RH')} active={ct === 0} />
      <SettingRow s={s} f="windSpeed" label="风速" value={fl.windSpeed.value === null ? PLACEHOLDER : WIND_SPEEDS_210[fl.windSpeed.value]} />
    </>
  )
}

function settingsMessage(st: SettingsState): { icon: IconDefinition; title: string; text: string; retry?: () => void; alert?: boolean } | null {
  switch (st.kind) {
    case 'no-device': return { icon: faCircleInfo, title: '无法读取运行设置', text: '这台设备没有有效的设备编号，暂时读不了运行设置。' }
    case 'device-offline': return { icon: faPlugCircleXmark, title: '设备未连接', text: '设备未连接，暂不读取运行设置。' }
    case 'forbidden': return { icon: faLock, title: '未开通运行设置', text: '当前账号没有读取运行设置的权限，请联系管理员开通。' }
    case 'loading': return { icon: faGears, title: '正在读取', text: '正在从控制屏读取运行设置…' }
    case 'unavailable': return { icon: faPlugCircleXmark, title: '控制屏未连接', text: '控制屏暂时无法连接，稍后会自动重试。', retry: st.retry }
    case 'unsupported': return { icon: faCircleInfo, title: st.message, text: TEXT_UNSUPPORTED_PANEL }
    case 'error': return { icon: faTriangleExclamation, title: '运行设置读取失败', text: st.error.message || defaultText('server'), retry: st.retry, alert: true }
    default: return null
  }
}

/** 字段名（结果条、锁提示逐项列出；同屏别的下发（201 / 203）的字段也能读） */
const FIELD_LABEL: Record<string, string> = { ...LABEL_204, temperature: '设定温度', eco: '节能模式', roomSwitch: '房间开关', roomTemp: '房间温度', systemSwitch: '系统开关', systemMode: '运行模式' }
const labelOf = (k: string) => FIELD_LABEL[k] ?? k
const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8)

/** 把值存进 ref，提交后同步更新（确认返回后读最新值用） */
function useLatest<T>(v: T) {
  const ref = useRef(v)
  useLayoutEffect(() => { ref.current = v })
  return ref
}
/** 组件是否仍挂载（预检期间离开页面就中止） */
function usePresent() {
  const ref = useRef(true)
  useLayoutEffect(() => { ref.current = true; return () => { ref.current = false } }, [])
  return ref
}

/** 写锁的标题与逐字段（同 Thermostat.tsx 的 lockTitle；还在自动核对时只显示正在核对） */
function lockTitle(lock: LockInfo): { title: string; fields: [string, FieldResult][] } {
  if (lock.lastVetoed || lock.settling) return { title: lock.outcome === 'unknown' ? '下发结果未知，正在核对…' : '已下发，正在核对…', fields: [] }
  const fields = Object.entries(lock.lastFields ?? {})
  if (!fields.length) return { title: lock.outcome === 'ok' ? '已下发，结果未知' : '结果未知', fields }
  const sum = describeFields(lock.lastFields!)
  const mixed = new Set(fields.map(([, v]) => v)).size > 1 && sum ? `（${sum}）` : ''
  return { title: `${VERDICT_TEXT[verdictOf(fields.map(([, v]) => v))]}${mixed}`, fields }
}

/** 同屏写锁的提示与「核对」入口（同 Thermostat.tsx 的 LockBar；本标签本面板正在进行的下发由面板自己显示） */
function LockBar({ lock, running }: { lock: LockInfo | null; running: Running | null }) {
  if (!lock) return null
  if (running && lock.mine) return null
  const unknown = lock.phase === 'unknown'
  const t = unknown && lock.owner !== 'other-account' && lock.origin !== 'synced' ? lockTitle(lock) : null
  const subject = lock.label ? `（${lock.label}）` : ''
  const head = !unknown ? '同一控制屏上有一条下发正在进行，暂不能下发。'
    : lock.owner === 'other-account' ? OTHER_ACCOUNT_TEXT
    : lock.origin === 'synced' ? '另一个标签页的下发结果未知，本项目暂停下发，等那边结束或到期后自动恢复。'
    : `上次下发${subject}：${t!.title}。为避免重复下发，本项目（同一控制屏）已暂停下发。`
  const tail = !unknown ? '' : lock.verifying ? (t && lock.settling ? '' : '正在核对 …')
    : !lock.sendSettled ? '上一条指令尚未结束，结束后会自动核对。'
    : `可点「核对」重新读取，一致即恢复；${lock.expiresAt ? `最迟 ${hhmmss(lock.expiresAt)} ` : ''}到期后自动恢复。`
  const check = async () => {
    const r = await verify(lock.key)
    if (r === 'released') showToast('核对一致，已恢复下发')
    else if (r === 'none') return
    else if (lockOf(lock.key)?.settling && r !== 'send-pending' && r !== 'not-visible') showToast('暂未核对一致，稍后自动再核对，仍暂停下发', true)
    else if (r === 'send-pending') showToast('上一条指令尚未结束，暂不能核对', true)
    else if (r === 'mismatch') showToast('指令已下发，设备状态暂未变化，仍暂停下发', true)
    else if (r === 'unverifiable') showToast('该项暂无回读，无法确认，仍暂停下发', true)
    else if (r === 'offline') showToast('控制屏离线，暂时无法核对，可稍后再试', true)
    else if (r === 'not-visible') showToast(OTHER_ACCOUNT_TEXT, true)
    else if (r === 'failed' || r === 'account-changed') showToast('核对读取失败，仍暂停下发，可再次核对', true)
  }
  return (
    <div className={'te-bar ' + (unknown ? 'fail' : 'sending')} role={unknown ? 'alert' : 'status'} style={{ margin: '12px 0 0' }} data-lock={lock.phase}>
      <span>
        {head}{tail}
        {t && t.fields.length > 0 && (
          <ul className="lock-fields" data-lock-fields="">
            {t.fields.map(([k, v]) => <li key={k} data-field={k} data-state={v}>{labelOf(k)}：{FIELD_STATE[v]}</li>)}
          </ul>
        )}
      </span>
      {unknown && lock.origin !== 'synced' && <Button disabled={lock.verifying || !lock.sendSettled} onClick={() => void check()}>核对</Button>}
    </div>
  )
}

/** 读数上不能设置时的锁图标（Tooltip 挂在可聚焦的图标上，同 S10b） */
function LockTip({ label, why }: { label: string; why: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} role="img" aria-label={`${label}不能设置：${why}`} className="faint" style={{ fontSize: 12 }}><Icon icon={faLock} /> 不可设置</span>
      </TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  )
}

interface EditorProps { s: SettingsView; draft: FaDraft | null; ctx: FaCtx; frozen: boolean; onEdit: (f: Field204, v: number) => void }

/** 一项的外框：标题、原值、读数上不能设置的锁 / 生效中 / 未启用 */
function FieldBox({ s, draft, f, label, active, inactive, children }: { s: SettingsView; draft: FaDraft | null; f: Field204; label: string; active?: boolean; inactive?: boolean; children: ReactNode }) {
  const why = fieldBlock(s, f)
  const changed = draftChanges(s, draft).find(([k]) => k === f)
  return (
    <div className={'setbox' + (why || inactive ? ' dis' : active ? ' on' : '') + (changed ? ' dirty' : '')} data-field={f}>
      <div className="sh">
        <div><b>{label}</b>{changed && <small className="num">原 {valueText(f, changed[1])}</small>}</div>
        {why ? <LockTip label={label} why={why} />
          : active ? <Badge style={{ background: 'var(--primary-2)', color: '#fff' }}>生效中</Badge>
          : inactive ? <Badge variant="gray">未启用</Badge> : null}
      </div>
      {children}
    </div>
  )
}

/** 选项按钮组（开关、控制类型、风速）：选中 aria-pressed；整组不能改时全部禁用 */
function Options({ label, f, s, draft, ctx, frozen, onEdit, opts, cls }: EditorProps & { label: string; f: Field204; opts: [number, string, IconDefinition?][]; cls: string }) {
  const block = frozen ? '已下发，待核对' : editBlock(s, draft, f, ctx)
  const shown = shownOf(s, draft, f)
  return (
    <div className={cls} role="group" aria-label={label} style={{ marginBottom: 0 }}>
      {opts.map(([v, t, ic]) => (
        <button key={v} type="button" className={'opt-btn' + (shown === v ? ' on' : '')} aria-pressed={shown === v} disabled={!!block} title={block ?? undefined}
          onClick={() => onEdit(f, v)}>{ic && <Icon icon={ic} style={{ fontSize: 11 }} />}{t}</button>
      ))}
    </div>
  )
}

/** 设定值步进（露点 0.5 °C、湿度 1 %RH） */
function Stepper({ f, label, unit, digits, s, draft, ctx, frozen, onEdit }: EditorProps & { f: 'dewPoint' | 'humiditySet'; label: string; unit: string; digits: number }) {
  const block = frozen ? '已下发，待核对' : editBlock(s, draft, f, ctx)
  const v = shownOf(s, draft, f)
  const dis = (dir: 1 | -1) => !!block || v === null || !canStepSetpoint(f, v, dir)
  return (
    <div className="stepper">
      <button type="button" aria-label={`${label}降低`} title={block ?? undefined} disabled={dis(-1)} onClick={() => v !== null && onEdit(f, stepSetpoint(f, v, -1))}>−</button>
      <span className="sv num" aria-label={label}>{v === null ? PLACEHOLDER : v.toFixed(digits)}{v !== null && <small>{unit}</small>}</span>
      <button type="button" className="plus" aria-label={`${label}升高`} title={block ?? undefined} disabled={dis(1)} onClick={() => v !== null && onEdit(f, stepSetpoint(f, v, 1))}>+</button>
    </div>
  )
}

/** 可编辑的运行设置（S10c） */
function SettingsEditor(p: EditorProps) {
  const { s, draft } = p
  const ct = shownOf(s, draft, 'controlType')
  const off = s.fields.switch.state === 'settable' && shownOf(s, draft, 'switch') === 0
  return (
    <>
      <FieldBox s={s} draft={draft} f="switch" label="开关">
        <Options {...p} label="开关" f="switch" cls="ctl-type" opts={[[1, '开', faPowerOff], [0, '关', faPowerOff]]} />
      </FieldBox>
      {off && <div className="ctl-hint" data-hint="off"><Icon icon={faLock} />{TEXT_DEVICE_OFF}</div>}
      <FieldBox s={s} draft={draft} f="controlType" label="控制类型">
        <Options {...p} label="控制类型" f="controlType" cls="ctl-type" opts={[[1, '露点控制', faTemperatureLow], [0, '湿度控制', faDroplet]]} />
      </FieldBox>
      {ct !== null && !s.canChange && <div className="ctl-hint"><Icon icon={faLock} />{TEXT_CT_LOCKED}</div>}
      <FieldBox s={s} draft={draft} f="dewPoint" label="露点设定" active={ct === 1} inactive={ct !== 1 && !fieldBlock(s, 'dewPoint')}>
        <Stepper {...p} f="dewPoint" label="露点设定" unit="°C" digits={1} />
      </FieldBox>
      <FieldBox s={s} draft={draft} f="humiditySet" label="湿度设定" active={ct === 0} inactive={ct !== 0 && !fieldBlock(s, 'humiditySet')}>
        <Stepper {...p} f="humiditySet" label="湿度设定" unit="%RH" digits={0} />
      </FieldBox>
      <FieldBox s={s} draft={draft} f="windSpeed" label="风速">
        <Options {...p} label="风速" f="windSpeed" cls="fan3" opts={[[0, '低', faSignal], [1, '高', faSignal], [2, '自动', faSignal]]} />
      </FieldBox>
    </>
  )
}

interface PanelProps {
  st: SettingsState
  project: Project
  unit: UnitView
  unitLabel: string
  /** 这台设备的草稿（别的设备的草稿不传） */
  draft: FaDraft | null
  conflict: Field204[]
  /** 草稿已交给一次下发、待确认：不按普通轮询整理，直到核对一致、确定失败或放弃 */
  pending: boolean
  onEdit: (f: Field204, v: number) => void
  onDiscard: () => void
  onPending: (on: boolean) => void
  lock: LockInfo | null
  running: Running | null
  result: WriteResult | null
  clearResult: () => void
  readPair: (deviceId: number | null, signal?: AbortSignal, opts?: { defer?: boolean }) => Promise<FreshPair>
  writable: string | null
}

function SettingsPanel(props: PanelProps) {
  const { st, project, unit, unitLabel, draft, conflict, pending, onEdit, onDiscard, onPending, lock, running, result, readPair, writable } = props
  // 确认与当前项目都在真正发起下发的这个组件里取：卸载、离开、换项目时确认按取消结算（docs/分工.md 第 3 节第 7 条）
  const confirm = useConfirm()
  const { project: current } = useCurrentProject()
  const present = usePresent()
  const ready = st.kind === 'ready' ? st : null
  const s = ready?.settings ?? null
  const ctx: FaCtx = { online: project.online === true, fresh: !ready?.staleError, connected: unit.connected, writable }
  const latest = useLatest({ project: current, s, draft, writable })
  const msg = settingsMessage(st)
  const deviceId = s?.deviceId ?? null
  const mine = deviceId !== null && running?.target === faTarget(deviceId)
  const busy = lock !== null || running !== null
  const changes = draftChanges(s, draft)
  const dirty = changes.length > 0
  const block = panelBlock(ctx)

  const abort = (why: string) => showToast(`${unitLabel}：${why}，本次未下发，请重新核对后再下发`, true)

  async function send() {
    const p0 = project
    if (!ready || !s || isLocked(p0)) return
    const built = build204(s, ready.raw, draft, ctx)
    if (!built.ok) { showToast(built.reason, true); return }
    const cs = changes
    const ok = await confirm({ title: '确认下发设置', body: <>将向 <b>{p0.name}</b>（<span className="num">{p0.code}</span>）的「{unitLabel}」下发：{describeChanges(cs)}，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    const now = latest.current
    const p = now.project
    if (!p || p.id !== p0.id) return abort('当前项目已变化')
    if (isLocked(p)) return abort('有下发正在进行')
    if (now.writable) return abort(now.writable)
    if (!now.draft || !draft || JSON.stringify(now.draft.values) !== JSON.stringify(draft.values)) return abort('未下发的修改已变化')
    // 下发开始：这份草稿进入「待确认」（与写锁分开维护），同温控
    const wasPending = pending
    onPending(true)
    const out = await runFreshAirSet({
      project: p, deviceId: s.deviceId, subject: unitLabel, okText: `${unitLabel} 已生效：${describeResult(cs)}`,
      confirmed: { query: built.query, view: s, raw: ready.raw, draft },
      read: (signal, opts) => readPair(s.deviceId, signal, opts),
      currentProject: () => latest.current.project,
      writable: () => latest.current.writable,
      present: () => present.current && latest.current.project?.id === p.id,
      toast: showToast,
      onApplied: onDiscard,
    })
    // ok（写锁认可的核对一致）/ fail（已发出被明确拒绝）才清；没发出（not-sent / 中止 / 被占）保留草稿、恢复原待确认
    if (out === 'ok' || out === 'fail') onDiscard()
    else if (out === 'not-sent' || out === 'aborted' || out === 'busy') onPending(wasPending)
  }

  const showWrite = !!ready && !writable
  return (
    <Card className="set-panel" role="region" aria-label="运行设置">
      <CardHeader style={{ marginBottom: 12 }}><CardTitle>运行设置</CardTitle>
        {ready && <span className="faint num" style={{ fontSize: 12 }}>{ready.staleError ? `刷新失败，显示 ${timeLabel(ready.updatedAt)} 的设置` : `${timeLabel(ready.updatedAt)} 读取`}</span>}
      </CardHeader>
      {s && showWrite ? <SettingsEditor s={s} draft={draft} ctx={ctx} frozen={pending || busy} onEdit={onEdit} />
        : s ? <SettingsBody s={s} />
        : msg && (
          <div role={msg.alert ? 'alert' : 'status'} className="ctl-hint" style={{ display: 'block' }}>
            <b style={{ display: 'block', marginBottom: 4 }}><Icon icon={msg.icon} /> {msg.title}</b>
            <span>{msg.text}</span>
            {msg.retry && <div style={{ marginTop: 10 }}><Button onClick={msg.retry}>重试</Button></div>}
          </div>
        )}
      {/* 只读形态（freshAirWrite = 'off'、没有 204 权限）：保留禁用的下发按钮和原因 */}
      {ready && writable && <>
        <Button variant="primary" size="lg" block disabled aria-describedby="fa-write-pending" style={{ marginTop: 12 }}><Icon icon={faPaperPlane} />下发设置</Button>
        <div id="fa-write-pending" className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>{writable}</div>
      </>}
      {showWrite && (mine ? (
        <div className="te-bar sending" role="status" style={{ margin: '12px 0 0' }}>
          <span>{running?.stage === 'preflight' ? '正在重新读取新风设置，核对确认的内容 …' : running?.stage === 'verifying' ? '已下发，正在核对 …' : '正在下发到控制屏 …'}</span>
          <Button variant="primary" disabled>下发中</Button>
        </div>
      ) : conflict.length ? (
        <div className="te-bar fail" role="alert" style={{ margin: '12px 0 0' }}>
          <span>{conflict.map((f) => LABEL_204[f]).join('、')}已在外部变化，未下发的修改需要重新核对。</span>
          <Button onClick={onDiscard}>放弃修改</Button>
        </div>
      ) : pending && draft ? (
        <div className="te-bar pending" data-pending="" style={{ margin: '12px 0 0' }}>
          <span>{busy ? '已下发，待核对一致：' : '上次下发未核对一致：'}<b className="num">{dirty ? describeChanges(changes) : describeDraft(draft)}</b>{busy ? '' : '。可放弃本次改动，或以设备读数为准重新下发。'}</span>
          <span className="row">
            <Button onClick={onDiscard}>放弃本次改动</Button>
            {!busy && dirty && <Button variant="primary" onClick={() => void send()} disabled={!!block}>重新下发</Button>}
          </span>
        </div>
      ) : (
        <>
          {dirty && (
            <div className="te-bar pending" data-draft="" style={{ margin: '12px 0 0' }}>
              <span>待下发：<b className="num">{describeChanges(changes)}</b></span>
              <Button onClick={onDiscard} disabled={busy}>放弃本次改动</Button>
            </div>
          )}
          <Button variant="primary" size="lg" block disabled={!dirty || busy || !!block} title={block ?? (dirty ? undefined : '没有需要下发的修改')} style={{ marginTop: 12 }} onClick={() => void send()}><Icon icon={faPaperPlane} />下发设置</Button>
          {block && <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>{block}</div>}
        </>
      ))}
      {showWrite && result && !mine && (
        <div className={'te-bar ' + (isGood(result) ? 'pending' : 'fail')} role={isGood(result) ? 'status' : 'alert'} style={{ margin: '12px 0 0' }} data-result="">
          <span>{resultText(result, labelOf)}</span>
          <Button onClick={props.clearResult}>知道了</Button>
        </div>
      )}
      <LockBar lock={lock} running={mine ? running : null} />
    </Card>
  )
}

const CLEARED_TEXT = { gone: '已读不到这台设备的运行设置', blocked: '已不能设置（设备或项目离线、读取失败、该项已不可设置）', applied: '' }

export default function FreshAir() {
  const { project } = useCurrentProject()
  const confirm = useConfirm()
  const writes = useWrites(project)
  // 写锁核对在途期间暂停 202 / 210 轮询（核对结束恢复），减少核对读数与轮询读数交错
  const paused = writes.lock?.verifying === true
  const view = useUnits(project, paused)
  const [selRaw, setSel] = useState('')
  const units = view.kind === 'ready' ? view.units : []
  const idx = Math.max(0, units.findIndex((x) => x.key === selRaw))
  const u: UnitView | undefined = units[idx]
  const settings = useSettings(project, u, paused)
  const panel = hasSettings(project)
  const readPair = useFreshPair(project)
  const refetch = useRefetchFreshAir(project)
  const writable = writableReason()

  // 草稿带上所属项目：切换项目即作废。pending：已交给一次下发、待确认（与写锁分开维护）
  const [draftState, setDraftState] = useState<{ pid: string; d: FaDraft | null; pending?: boolean }>({ pid: '', d: null })
  const pid = project?.id ?? ''
  const rawDraft = draftState.pid === pid ? draftState.d : null
  const frozen = !!rawDraft && draftState.pending === true
  const setDraft = (d: FaDraft | null) => setDraftState({ pid, d })
  const discard = () => setDraftState((st) => (st.pid === pid ? { pid, d: null } : st))
  const markPending = (on: boolean) => setDraftState((st) => (st.pid === pid && st.d ? { ...st, pending: on } : st))
  const s = settings.kind === 'ready' ? settings.settings : null
  const ctx: FaCtx = { online: project?.online === true, fresh: settings.kind === 'ready' && !settings.staleError, connected: u?.connected === true, writable }
  const onDevice = !!rawDraft && !!s && rawDraft.deviceId === s.deviceId
  const rec = !rawDraft || !onDevice ? { draft: rawDraft, conflict: [] as Field204[] } : frozen ? { draft: rawDraft, conflict: [] as Field204[] } : reconcileDraft(rawDraft, s, ctx)
  const draft = rec.draft

  // 下发状态机判断「是否仍在原项目」用实际解析出的当前项目
  useLayoutEffect(() => { if (project) noteCurrentProject(project.id) }, [project])
  // 写锁到期放开时发「强制重读」：属于本项目（任一锁键相同）就重读 202 / 210；锁放开（核对一致、到期）也重读一次
  useEffect(() => {
    if (!project) return
    const mine = new Set(lockKeysOf(project))
    return onForceReread((e) => { if (e.keys.some((k) => mine.has(k))) refetch() })
  }, [project, refetch])
  const lockKey = writes.lock?.key ?? null
  const prevLock = useRef<string | null>(null)
  useEffect(() => {
    if (prevLock.current && !lockKey) refetch()
    prevLock.current = lockKey
  }, [lockKey, refetch])

  // 草稿生命周期：回读后读不到 / 不能设置 / 已生效的草稿真正清除（只整理当前选中设备的草稿；待确认期间不整理）
  const draftOnSelected = !!rawDraft && u?.deviceId === rawDraft.deviceId
  const settingsSettled = settings.kind !== 'loading'
  useEffect(() => {
    if (!rawDraft || frozen) return
    if (view.kind === 'ready' && !units.some((x) => x.deviceId === rawDraft.deviceId)) { setDraftState({ pid, d: null }); showToast(`新风设备${CLEARED_TEXT.gone}，未下发的修改已清除`, true); return }
    if (!draftOnSelected || !settingsSettled) return
    const r = reconcileDraft(rawDraft, s, ctx)
    if (r.draft === rawDraft) return
    // 回读是外部数据源：读到新状态后同步整理草稿（只在草稿确实变化时）
    setDraftState({ pid, d: r.draft })
    if (r.cleared === 'gone' || r.cleared === 'blocked') showToast(`「${u?.name || '新风设备'}」${CLEARED_TEXT[r.cleared]}，未下发的修改已清除`, true)
  }, [rawDraft, frozen, view.kind, units, draftOnSelected, settingsSettled, s, ctx.online, ctx.fresh, ctx.connected, ctx.writable, pid])

  /** 编辑一项；另一台设备还有未下发的修改时先确认放弃 */
  const onEdit = async (f: Field204, v: number) => {
    if (!s) return
    if (rawDraft && rawDraft.deviceId !== s.deviceId && Object.keys(rawDraft.values).length) {
      if (frozen) { showToast('另一台设备的下发还在核对，暂不能修改', true); return }
      const other = units.find((x) => x.deviceId === rawDraft.deviceId)
      const ok = await confirm({ title: '放弃未下发的修改', body: <>「{other?.name || '另一台设备'}」还有未下发的修改（{describeDraft(rawDraft)}），放弃并改为修改「{u?.name || '这台设备'}」？</>, okText: '放弃修改' })
      if (!ok) return
      setDraft(editDraft(s, null, f, v, ctx))
      return
    }
    const next = editDraft(s, draft, f, v, ctx)
    setDraft(Object.keys(next.values).length ? next : null)
  }

  const updated = view.kind === 'ready' || view.kind === 'empty'
    ? <div className="muted num" style={{ fontSize: 12, marginTop: 24 }}><Icon icon={faRotate} /> {view.kind === 'ready' && view.staleError ? `刷新失败，显示 ${timeLabel(view.updatedAt)} 的数据` : `${timeLabel(view.updatedAt)} 更新`}</div>
    : null
  const head = <PageHead project={project} count={view.kind === 'ready' ? units.length : undefined} right={updated} />
  const body = (() => {
    switch (view.kind) {
      // 没有项目、项目离线时 Layout 不挂载设备页（S11），空态在 Layout；数据层照样不发请求，这里只留页头兜底
      case 'no-project': case 'offline': return <></>
      case 'forbidden': return <Placeholder icon={faLock} title="未开通新风数据" text="当前账号没有读取新风除湿机数据的权限，请联系管理员开通。" />
      case 'loading': return <Placeholder icon={faFan} title="正在读取" text="正在从控制屏读取新风除湿机数据…" />
      case 'unavailable': return <Placeholder icon={faPlugCircleXmark} title="控制屏未连接" text="控制屏暂时无法连接，稍后会自动重试。" onRetry={view.retry} />
      case 'error': return <Placeholder alert icon={faTriangleExclamation} title="新风数据加载失败" text={view.error.message || defaultText('server')} onRetry={view.retry} />
      case 'empty': return <Placeholder icon={faFan} title="暂无新风除湿机数据" text="该项目暂时没有可显示的新风除湿机。" />
      default: return null
    }
  })()
  if (body || !u) return <div className="page">{head}{body}</div>

  return (
    <div className="page">
      {head}
      {/* 设备切换：青色边框表示“当前设备”；键盘焦点另用 3px 浅青外圈（只在键盘聚焦时出现，鼠标点击不出现，见 TabsTrigger）。
          .dev-tab 的 box-shadow 是未分层规则，外圈要 ! 才能压过，并保留原阴影 */}
      <Tabs value={u.key} onValueChange={setSel}>
        <TabsList className="dev-tabs" aria-label="新风设备">
          {units.map((f, i) => {
            const [t, c] = statusOf(f)
            return (
              <TabsTrigger key={f.key} value={f.key} className={'dev-tab outline-none focus-visible:not-data-[pointer-focus]:shadow-[0_0_0_3px_rgba(6,182,212,.12),var(--shadow)]!' + (f.key === u.key ? ' on' : '')}>
                <span className="di"><Icon icon={faFan} /></span>
                <span className="block"><b className="num">{unitName(f, i)}</b><small className={c === 'gray' ? 'faint' : c}>{t}{f.connected && f.runningMode && <> · {f.runningMode}</>}</small></span>
              </TabsTrigger>
            )
          })}
        </TabsList>
        <TabsContent value={u.key}>
          <div className={'fa-top' + (panel ? '' : ' wide')}>
            <LiveCard u={u} name={unitName(u, idx)} wide={!panel} />
            {panel && project && (
              <SettingsPanel st={settings} project={project} unit={u} unitLabel={unitName(u, idx)}
                draft={onDevice ? draft : null} conflict={onDevice ? rec.conflict : []} pending={frozen && onDevice}
                onEdit={(f, v) => void onEdit(f, v)} onDiscard={discard} onPending={markPending}
                lock={writes.lock} running={writes.running} result={s ? writes.result(faTarget(s.deviceId)) : null}
                clearResult={() => { if (s) clearResultOf(project.id, faTarget(s.deviceId)) }} readPair={readPair} writable={writable} />
            )}
          </div>

          <Card pad={false}>
            <div className="px-[22px] py-5" style={{ paddingBottom: 14 }}><CardTitle>设备汇总</CardTitle></div>
            <Table>
              <TableHeader><TableRow><TableHead>设备</TableHead><TableHead>开关</TableHead><TableHead>模式</TableHead><TableHead className="text-right">运行时间</TableHead><TableHead className="text-right">滤网运行时间</TableHead><TableHead>滤网寿命</TableHead></TableRow></TableHeader>
              <TableBody>
                {units.map((f, i) => {
                  const look = filterLook(f)
                  const live = f.connected
                  return (
                    <TableRow key={f.key} onClick={() => setSel(f.key)} style={{ cursor: 'pointer', color: live && f.on ? undefined : 'var(--muted)' }}>
                      <TableCell style={{ fontWeight: 500, color: 'var(--text)' }}>{unitName(f, i)}</TableCell>
                      <TableCell>{live ? (f.on === null ? PLACEHOLDER : <Badge variant={f.on ? 'green' : 'gray'}><Icon icon={faPowerOff} /> {f.on ? '开' : '关'}</Badge>) : <Badge variant="red">未连接</Badge>}</TableCell>
                      <TableCell>{live ? f.runningMode || PLACEHOLDER : PLACEHOLDER}</TableCell>
                      <TableCell className="num text-right">{live ? num(f.runningTime) : PLACEHOLDER}</TableCell>
                      <TableCell className="num text-right">{live ? num(f.filterRunning) : PLACEHOLDER}</TableCell>
                      <TableCell style={{ width: 170 }}>
                        {live ? (
                          <div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: (f.filter.percent ?? 0) + '%', background: look.bar }} /></div><span className={'num ' + look.cls} style={{ width: 34, textAlign: 'right', fontSize: 12 }}>{f.filter.percent === null ? PLACEHOLDER : `${f.filter.percent}%`}</span></div>
                        ) : PLACEHOLDER}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

