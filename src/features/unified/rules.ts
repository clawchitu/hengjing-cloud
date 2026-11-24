// 统一控制的规则与校验（纯函数，不发请求）。
// - app_code 决定温度设定是否可用：1 可用；8、12 不可用；其他/缺失按不可用处理（白名单）。
// - 项目离线不允许下发。
// - 组装 203 Query 一律走 ctrl.ts 的 buildUnifiedCtrlSet()：不改的开关/温度填 -1，模式填 0（不变）。
import { buildUnifiedCtrlSet, type WriteQuery } from '@/api/ctrl'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'
import { hasChanges, UNCHANGED } from '@/api/values'
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
  | 'NO_PROJECT' | 'OFFLINE' | 'BAD_SWITCH' | 'BAD_MODE' | 'TEMP_DISABLED' | 'TEMP_INVALID' | 'TEMP_WHILE_ROOM_OFF' | 'NO_CHANGES'
export interface Issue { code: IssueCode; message: string }

export type Validation = { ok: true; query: WriteQuery<203> } | { ok: false; errors: string[]; issues: Issue[] }

/** 下发前的完整校验，通过时给出组装好的 203 Query（不改的字段全是 -1 / 模式 0） */
export function validateUnified(draft: UnifiedDraft, ctx: UnifiedContext | null | undefined): Validation {
  const issues: Issue[] = []
  const add = (code: IssueCode, message: string) => { issues.push({ code, message }) }
  const fail = (): Validation => ({ ok: false, errors: issues.map((i) => i.message), issues })
  if (!ctx || !ctx.projectId) { add('NO_PROJECT', TEXT.noProject); return fail() }
  if (ctx.online !== true) add('OFFLINE', TEXT.offline)

  const d = draft ?? {}
  if (d.systemSwitch !== undefined && !isSwitch(d.systemSwitch)) add('BAD_SWITCH', TEXT.badSwitch(TEXT.systemSwitch))
  if (d.roomSwitch !== undefined && !isSwitch(d.roomSwitch)) add('BAD_SWITCH', TEXT.badSwitch(TEXT.roomSwitch))
  // 0 是「不变」（OPERATION_MODE_NONE），等同于没选
  if (d.systemMode !== undefined && d.systemMode !== Mode.OPERATION_MODE_NONE && !MODE_VALUES.has(d.systemMode)) add('BAD_MODE', TEXT.badMode)
  if (d.roomTemp !== undefined) {
    const avail = tempAvailability(ctx.appCode)
    if (!avail.enabled) add('TEMP_DISABLED', avail.reason)
    else {
      const e = checkTemp(d.roomTemp, resolveTempRange(ctx.tempRange))
      if (e) add('TEMP_INVALID', e)
    }
    // 后端答复⑦：房间关闭时界面不允许设置温度。注意：这里只能拦「本次同时关房间」，
    // 房间原本就关着的情况要等页面接入 200 的房间状态后在页面层处理
    if (d.roomSwitch === SWITCH_OFF) add('TEMP_WHILE_ROOM_OFF', TEXT.tempWhileRoomOff)
  }

  const query = buildUnifiedCtrlSet({
    systemSwitch: d.systemSwitch,
    systemMode: d.systemMode,
    roomSwitch: d.roomSwitch,
    roomTemp: d.roomTemp,
  })
  const changed = hasChanges(query, ['systemSwitch', 'roomSwitch', 'roomTemp'] as const) || query.systemMode !== Mode.OPERATION_MODE_NONE
  if (!changed) add('NO_CHANGES', TEXT.noChanges)

  return issues.length ? fail() : { ok: true, query }
}

/** 确认弹窗里逐项列出将下发的值（只列有改动的项） */
export function describeQuery(q: WriteQuery<203>): Array<{ label: string; value: string }> {
  const sw = (v: number) => (v === SWITCH_ON ? TEXT.on : TEXT.off)
  const out: Array<{ label: string; value: string }> = []
  if (q.systemSwitch !== UNCHANGED) out.push({ label: TEXT.systemSwitch, value: sw(q.systemSwitch) })
  if (q.systemMode !== Mode.OPERATION_MODE_NONE) out.push({ label: TEXT.systemMode, value: MODE_OPTIONS.find((o) => o.value === q.systemMode)?.label ?? String(q.systemMode) })
  if (q.roomSwitch !== UNCHANGED) out.push({ label: TEXT.roomSwitch, value: sw(q.roomSwitch) })
  if (q.roomTemp !== UNCHANGED) out.push({ label: TEXT.roomTemp, value: `${q.roomTemp}${TEXT.tempUnit}` })
  return out
}

/** 回读整理后的统一控制相关值（页面把 200/210 等读数映射成这个形状）；缺失或 null 表示没读到 */
export interface UnifiedEcho {
  systemSwitch?: number | null
  systemMode?: number | null
  roomSwitch?: number | null
  roomTemp?: number | null
}
export type EchoField = keyof UnifiedEcho
export const ECHO_FIELDS: readonly EchoField[] = ['systemSwitch', 'systemMode', 'roomSwitch', 'roomTemp']
export interface EchoMismatch { field: EchoField; kind: 'missing' | 'differ'; message: string }

/** 本次下发改了哪些字段（-1 / 模式 0 的不算） */
export function changedFields(q: WriteQuery<203>): EchoField[] {
  return ECHO_FIELDS.filter((k) => (k === 'systemMode' ? q.systemMode !== Mode.OPERATION_MODE_NONE : q[k] !== UNCHANGED))
}

const FIELD_LABEL: Record<EchoField, string> = { systemSwitch: TEXT.systemSwitch, systemMode: TEXT.systemMode, roomSwitch: TEXT.roomSwitch, roomTemp: TEXT.roomTemp }
const NONE: WriteQuery<203> = { systemSwitch: UNCHANGED, systemMode: Mode.OPERATION_MODE_NONE, roomSwitch: UNCHANGED, roomTemp: UNCHANGED }

/** 逐字段核对：只核对下发了的字段；温度按 0.01 容差比较（float32）。空数组 = 全部一致 */
export function echoMismatches(q: WriteQuery<203>, after: UnifiedEcho | null | undefined): EchoMismatch[] {
  const out: EchoMismatch[] = []
  for (const k of changedFields(q)) {
    const got = after?.[k]
    if (got === null || got === undefined || !Number.isFinite(got)) {
      out.push({ field: k, kind: 'missing', message: TEXT.echoMissing(FIELD_LABEL[k]) })
      continue
    }
    const same = k === 'roomTemp' ? Math.abs(got - q.roomTemp) < 0.01 : got === q[k]
    if (same) continue
    const sentText = describeQuery({ ...NONE, [k]: q[k] })[0]?.value ?? String(q[k])
    const isSw = k === 'systemSwitch' || k === 'roomSwitch'
    // 开关回读到 0/1 以外的值时直接显示原始数字，避免「下发 关闭，回读 关闭」这种矛盾文案
    const gotText = isSw && got !== SWITCH_ON && got !== SWITCH_OFF ? String(got) : describeQuery({ ...NONE, [k]: got })[0]?.value ?? String(got)
    out.push({ field: k, kind: 'differ', message: TEXT.echoDiffer(FIELD_LABEL[k], sentText, gotText) })
  }
  return out
}
