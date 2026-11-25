// 统一控制的规则与校验（纯函数，不发请求）。
// - app_code 决定温度设定是否可用：1 可用；8、12 不可用；其他/缺失按不可用处理（白名单）。
// - 项目离线不允许下发。
// - 组装 203 Query 一律走 ctrl.ts 的 buildUnifiedCtrlSet()：不改的四项（含运行模式）一律填 -1（后端 11/25 答复第 4 条）；0 是真实值。
// - 运行模式只能选 MODE_OPTIONS 里的 14 种；草稿里「不变」= 不给这一项（undefined）。0（OPERATION_MODE_NONE）、-1 等其他值都算无效模式，拒绝下发。
import { buildUnifiedCtrlSet, MODE_UNCHANGED, type WriteQuery } from '@/api/ctrl'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'
import { UNCHANGED } from '@/api/values'
import {
  DEFAULT_TEMP_RANGE, MODE_OPTIONS, SWITCH_OFF, SWITCH_ON, TEMP_DISABLED_APP_CODES, TEMP_ENABLED_APP_CODES, TEXT,
  type SwitchValue, type TempRange,
} from './constants'

/** 当前项目信息。S6a 合并前由调用方注入，之后改由项目数据 hooks 提供 */
export interface UnifiedContext {
  /** 后端项目 id（ctrl 请求的 project_id） */
  projectId: string
  /** 项目编号（界面上的「项目 ID」，如 240829001） */
  projectCode: string
  projectName?: string
  /** 项目 app_code；缺失按未知处理 */
  appCode: number | null | undefined
  /** 在线状态；只有 true 才算在线（online 缺失即离线，见实测记录 Q9） */
  online: boolean | null | undefined
  /** 后端给出的设定温度范围（以后才有）；缺失回退 16/30/0.5 */
  tempRange?: Partial<TempRange> | null
}

/** 用户在界面上选的改动；没给的项就是「不变」 */
export interface UnifiedDraft {
  systemSwitch?: SwitchValue
  systemMode?: Mode
  roomSwitch?: SwitchValue
  roomTemp?: number
}

export type TempAvailability = { enabled: true } | { enabled: false; reason: string }

/** 按 app_code 判断温度设定是否可用 */
export function tempAvailability(appCode: number | null | undefined): TempAvailability {
  if (typeof appCode === 'number' && TEMP_ENABLED_APP_CODES.includes(appCode)) return { enabled: true }
  if (typeof appCode === 'number' && TEMP_DISABLED_APP_CODES.includes(appCode)) return { enabled: false, reason: TEXT.tempDisabledByApp }
  return { enabled: false, reason: TEXT.tempDisabledUnknownApp }
}

const validNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 后端范围优先，逐项回退默认值；范围不合理（min ≥ max、step ≤ 0）整体回退默认值 */
export function resolveTempRange(r?: Partial<TempRange> | null): TempRange {
  const min = validNum(r?.min) ? r.min : DEFAULT_TEMP_RANGE.min
  const max = validNum(r?.max) ? r.max : DEFAULT_TEMP_RANGE.max
  const step = validNum(r?.step) ? r.step : DEFAULT_TEMP_RANGE.step
  if (!(min < max) || !(step > 0)) return { ...DEFAULT_TEMP_RANGE }
  return { min, max, step }
}

/** 设定温度校验；合法返回 null，否则返回文案 */
export function checkTemp(v: unknown, range: TempRange = DEFAULT_TEMP_RANGE): string | null {
  if (!validNum(v)) return TEXT.tempNotNumber
  if (v < range.min || v > range.max) return TEXT.tempOutOfRange(range)
  const k = (v - range.min) / range.step
  if (Math.abs(k - Math.round(k)) > 1e-9) return TEXT.tempBadStep(range)
  return null
}

/** 把温度收进范围并对齐步进（给 −/+ 步进器用） */
export function clampTemp(v: number, range: TempRange = DEFAULT_TEMP_RANGE): number {
  const x = Math.min(range.max, Math.max(range.min, validNum(v) ? v : range.min))
  const k = Math.round((x - range.min) / range.step)
  return Math.min(range.max, +(range.min + k * range.step).toFixed(6))
}

const isSwitch = (v: unknown): v is SwitchValue => v === SWITCH_ON || v === SWITCH_OFF
const MODE_VALUES = new Set<number>(MODE_OPTIONS.map((o) => o.value))

/** 校验问题的固定代码（日志只记代码，不记文案） */
export type IssueCode =
  | 'NO_PROJECT' | 'OFFLINE' | 'BAD_SWITCH' | 'BAD_MODE' | 'TEMP_DISABLED' | 'TEMP_INVALID' | 'NO_CHANGES'
export interface Issue { code: IssueCode; message: string }

export type Validation = { ok: true; query: WriteQuery<203> } | { ok: false; errors: string[]; issues: Issue[] }

/** 下发前的完整校验，通过时给出组装好的 203 Query（不改的字段全是 -1，含运行模式） */
export function validateUnified(draft: UnifiedDraft, ctx: UnifiedContext | null | undefined): Validation {
  const issues: Issue[] = []
  const add = (code: IssueCode, message: string) => { issues.push({ code, message }) }
  const fail = (): Validation => ({ ok: false, errors: issues.map((i) => i.message), issues })
  if (!ctx || !ctx.projectId) { add('NO_PROJECT', TEXT.noProject); return fail() }
  if (ctx.online !== true) add('OFFLINE', TEXT.offline)

  const d = draft ?? {}
  if (d.systemSwitch !== undefined && !isSwitch(d.systemSwitch)) add('BAD_SWITCH', TEXT.badSwitch(TEXT.systemSwitch))
  if (d.roomSwitch !== undefined && !isSwitch(d.roomSwitch)) add('BAD_SWITCH', TEXT.badSwitch(TEXT.roomSwitch))
  // 「不变」只能是不给（undefined）；0（OPERATION_MODE_NONE）不是可下发的模式，原样发出去设备会当真实值，按无效模式拒绝
  if (d.systemMode !== undefined && !MODE_VALUES.has(d.systemMode)) add('BAD_MODE', TEXT.badMode)
  if (d.roomTemp !== undefined) {
    const avail = tempAvailability(ctx.appCode)
    if (!avail.enabled) add('TEMP_DISABLED', avail.reason)
    else {
      const e = checkTemp(d.roomTemp, resolveTempRange(ctx.tempRange))
      if (e) add('TEMP_INVALID', e)
    }
    // 后端 11/25 答复第 16 条：统一控制下发温度时，房间关着温度也会生效（不会把房间打开，开启后按此温度运行）。
    // 所以房间关着、或这次同时关房间，都可以设温度，不再拦（页面给「房间开启后生效」的提示）
  }

  const query = buildUnifiedCtrlSet({
    systemSwitch: d.systemSwitch,
    systemMode: d.systemMode,
    roomSwitch: d.roomSwitch,
    roomTemp: d.roomTemp,
  })
  if (!changedFields(query).length) add('NO_CHANGES', TEXT.noChanges)

  return issues.length ? fail() : { ok: true, query }
}

/** 确认弹窗里逐项列出将下发的值（只列有改动的项） */
export function describeQuery(q: WriteQuery<203>): Array<{ label: string; value: string }> {
  const sw = (v: number) => (v === SWITCH_ON ? TEXT.on : TEXT.off)
  const out: Array<{ label: string; value: string }> = []
  if (q.systemSwitch !== UNCHANGED) out.push({ label: TEXT.systemSwitch, value: sw(q.systemSwitch) })
  if (q.systemMode !== MODE_UNCHANGED) out.push({ label: TEXT.systemMode, value: MODE_OPTIONS.find((o) => o.value === q.systemMode)?.label ?? String(q.systemMode) })
  if (q.roomSwitch !== UNCHANGED) out.push({ label: TEXT.roomSwitch, value: sw(q.roomSwitch) })
  if (q.roomTemp !== UNCHANGED) out.push({ label: TEXT.roomTemp, value: `${q.roomTemp}${TEXT.tempUnit}` })
  return out
}

/**
 * 回读整理后的统一控制相关值（页面把 200/210 等读数映射成这个形状）。
 * - undefined（不给这个键）：回读接口根本没有这项读数（如 200 里没有系统开关、运行模式）→ 未核对
 * - null：接口有这项读数，但设备没回报（protobuf 里字段缺失）、取值无效或没有房间 → 无法核对，不能当成 0（关）
 */
export interface UnifiedEcho {
  systemSwitch?: number | null
  systemMode?: number | null
  roomSwitch?: number | null
  roomTemp?: number | null
  /** 离线（is_connected=false）的房间数：这些房间不参与核对；有离线房间且没有不一致的 → 结果未知 */
  offline?: number
  /** 房间开关未上报（features.roomSwitchReported = false）：房间开关一律无法核对，离线也不改成结果未知 */
  switchUnreported?: boolean
  /** 逐房间读数（只含在线房间；null = 取值无效）。给了就按房间逐个核对，不看上面的汇总值 */
  perRoom?: { roomSwitch?: ReadonlyArray<number | null>; roomTemp?: ReadonlyArray<number | null> }
}
export type EchoField = Exclude<keyof UnifiedEcho, 'perRoom' | 'offline' | 'switchUnreported'>
export const ECHO_FIELDS: readonly EchoField[] = ['systemSwitch', 'systemMode', 'roomSwitch', 'roomTemp']
/**
 * 逐字段核对结论（只列没核对一致的字段）：
 * - differ：读到了、但值和下发的不一样（未变化）
 * - missing：接口有这项读数，但设备没回报 / 回读失败（无法核对）
 * - unreadable：回读接口没有这项读数（未核对）
 */
export interface EchoMismatch { field: EchoField; kind: 'missing' | 'differ' | 'unreadable'; message: string }

/** 本次下发改了哪些字段（-1 的不算；0 是真实值，算改了） */
export function changedFields(q: WriteQuery<203>): EchoField[] {
  return ECHO_FIELDS.filter((k) => q[k] !== UNCHANGED)
}

const FIELD_LABEL: Record<EchoField, string> = { systemSwitch: TEXT.systemSwitch, systemMode: TEXT.systemMode, roomSwitch: TEXT.roomSwitch, roomTemp: TEXT.roomTemp }
const NONE: WriteQuery<203> = { systemSwitch: UNCHANGED, systemMode: MODE_UNCHANGED, roomSwitch: UNCHANGED, roomTemp: UNCHANGED }
const valid = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 逐字段核对：只核对下发了的字段；温度按 0.01 容差比较（float32）。空数组 = 全部一致。
 * 同一字段可能同时有一条 differ 和一条 missing（逐房间读数里既有不一致、又有没回报的）。
 * after 为 null（回读失败）时每个字段都是 missing
 */
export function echoMismatches(q: WriteQuery<203>, after: UnifiedEcho | null | undefined): EchoMismatch[] {
  const out: EchoMismatch[] = []
  for (const k of changedFields(q)) {
    const label = FIELD_LABEL[k]
    const perRoom = k === 'roomSwitch' || k === 'roomTemp' ? after?.perRoom?.[k] : undefined
    if (after && !(k in after) && perRoom === undefined) {
      out.push({ field: k, kind: 'unreadable', message: TEXT.echoUnreadable(label) })
      continue
    }
    const vals: ReadonlyArray<number | null | undefined> = perRoom ?? (after ? [after[k]] : [])
    const same = (got: number) => (k === 'roomTemp' ? Math.abs(got - q.roomTemp) < 0.01 : got === q[k])
    const present = vals.filter(valid)
    const bad = present.filter((v) => !same(v))
    if (bad.length) {
      const got = bad[0]
      const sentText = describeQuery({ ...NONE, [k]: q[k] })[0]?.value ?? String(q[k])
      const isSw = k === 'systemSwitch' || k === 'roomSwitch'
      // 开关回读到 0/1 以外的值时直接显示原始数字，避免「下发 关闭，回读 关闭」这种矛盾文案
      const gotText = isSw && got !== SWITCH_ON && got !== SWITCH_OFF ? String(got) : describeQuery({ ...NONE, [k]: got })[0]?.value ?? String(got)
      const part = perRoom && bad.length < perRoom.length ? TEXT.echoPart(perRoom.length, bad.length) : ''
      out.push({ field: k, kind: 'differ', message: TEXT.echoDiffer(label, sentText, gotText) + part })
    }
    // 没有任何读数（回读失败、没有房间），或有房间没回报：无法核对。
    // 同一字段里有的房间不一致、有的房间没回报：两条都记（不一致照常列出，整体按无法核对算）
    if (!vals.length || present.length < vals.length) out.push({ field: k, kind: 'missing', message: TEXT.echoMissing(label) })
  }
  return out
}

/**
 * 回读结论（控制屏已应答 success=true 之后）：
 * - applied：下发的字段全部读到且一致（已生效）
 * - unchanged：有字段读到了、但和下发的不一样（未变化）；同时还有核对不了的字段也算未变化（排序 B，Fable 11/25）
 * - unverifiable：没有不一致的，但有字段核对不了（没有房间条目、200 回包为空 {}、设备没回报、200 里根本没有这项读数如系统开关 / 运行模式）→ 无法核对
 * - unknown：有房间离线（读数不可信，结果未知）
 */
export type EchoVerdict = 'applied' | 'unchanged' | 'unverifiable' | 'unknown'
/**
 * 下发核对口径（Fable 11/24，排序 11/25 改 B）：一次下发里既有能核对的字段、又有不能核对的字段时，能核对的部分照常逐字段判
 * （mismatches 里照常列出 differ），整体结果按排序取最靠前的：结果未知（有房间离线）> 未变化 > 无法核对 > 已生效。
 * 与 fieldResults 逐字段结论取最靠前的那个一致。回读请求本身失败不走这里（状态机直接判「结果未知」，不并进无法核对）
 */
export function echoVerdict(ms: readonly EchoMismatch[], after?: UnifiedEcho | null, fields?: readonly EchoField[]): EchoVerdict {
  // 有房间离线 → 结果未知；只有一种例外：这次只改了房间开关且开关未上报（离线与否都拿不到可信读数）→ 无法核对
  const onlyUnreportedSwitch = !!after?.switchUnreported && !!fields?.length && fields.every((f) => f === 'roomSwitch')
  if (after?.offline && !onlyUnreportedSwitch) return 'unknown'
  if (ms.some((m) => m.kind === 'differ')) return 'unchanged'
  if (ms.some((m) => m.kind === 'missing' || m.kind === 'unreadable')) return 'unverifiable'
  return 'applied'
}

/** 单个字段的下发结果（四种之一）：applied 已生效、unchanged 未变化、unverifiable 无法核对、unknown 结果未知 */
export type FieldStatus = EchoVerdict
/** 总结果排序（Fable 11/25）：结果未知 > 未变化 > 无法核对 > 已生效；总结果取逐字段里最靠前的 */
export const FIELD_STATUS_ORDER: readonly FieldStatus[] = ['unknown', 'unchanged', 'unverifiable', 'applied']
export interface FieldResult { field: EchoField; label: string; status: FieldStatus; messages: string[] }

/**
 * 逐字段结论（只列下发了的字段）：
 * - 回读失败（after 为 null，不带说明）或有房间离线（读数不可信）→ 结果未知
 * - 有 differ → 未变化（同一字段既有不一致、又有没回报的，按排序算未变化）；只有 missing / unreadable → 无法核对；都没有 → 已生效
 * - replied=false（应答结果未知）：除了回读一致的（已生效），其余都是结果未知
 */
export function fieldResults(q: WriteQuery<203>, after: UnifiedEcho | null | undefined, opts: { replied?: boolean } = {}): FieldResult[] {
  const ms = echoMismatches(q, after)
  return changedFields(q).map((field) => {
    const mine = ms.filter((m) => m.field === field)
    let status: FieldStatus = !after ? 'unknown'
      : field === 'roomSwitch' && after.switchUnreported ? 'unverifiable'
      : after.offline ? 'unknown'
      : mine.some((m) => m.kind === 'differ') ? 'unchanged'
      : mine.length ? 'unverifiable' : 'applied'
    if (opts.replied === false && status !== 'applied') status = 'unknown'
    // 回读请求本身失败：不列逐字段的「设备未回报」（那是回读成功但没读数，不是一回事）
    return { field, label: FIELD_LABEL[field], status, messages: after ? mine.map((m) => m.message) : [] }
  })
}

/** 逐字段结论 → 总结果（排序最靠前的）；没有字段时算已生效 */
export const overallOf = (rs: ReadonlyArray<{ status: FieldStatus }>): FieldStatus =>
  FIELD_STATUS_ORDER.find((s) => rs.some((r) => r.status === s)) ?? 'applied'

/**
 * 结果标题（Fable 11/25）：所有字段同一种结果 → 就是那个词；混合 → 按排序逐项计数，如「1 项未生效，1 项无法核对」，不压成一个词
 */
export function resultTitle(rs: ReadonlyArray<{ status: FieldStatus }>): string {
  const kinds = FIELD_STATUS_ORDER.filter((s) => rs.some((r) => r.status === s))
  if (kinds.length <= 1) return TEXT.fieldStatus[kinds[0] ?? 'applied']
  return kinds.map((s) => TEXT.fieldCount(rs.filter((r) => r.status === s).length, s)).join('，')
}
