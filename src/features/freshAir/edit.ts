// 新风运行设置（S10c）的编辑规则与 204 组装（纯函数，不发请求）。依据 docs/plan-s10-s7.md「S10c」与 2.3、后端 11/25 答复：
// - 所有「不变」字段一律传 -1（答复第 4 条，204 也是）：组装只走 src/api/ctrl.ts 的 buildRunningCtrlSet（先铺 -1 底板，
//   只用用户明确改了的字段覆盖并登记；写入口的 assertNoImplicitZero 兜底），build204 是本功能唯一的组装点；
// - 0 是有效值：control_type 0 = 湿度控制、wind_speed 0 = 低、switch 0 = 关，用户明确选了就原样下发；-100 无效；
// - 210 读到 -1 = 该项不能设置，只禁用那一项（答复第 5 条，model.ts 的 fieldBlock）；control_type 为 -1 时只禁用控制类型和
//   与之相关的露点、湿度，风速和开关照常可设；
// - 草稿与读数分开：草稿只记用户动过的项（values）和开始编辑时的读数（base，用于发现外部修改）。
// 可改项（editBlock，逐项）：
//   1. 面板整体只读（panelBlock）：features.freshAirWrite = 'off'、没有 204 权限、项目离线、最近一次读取失败、设备未连接；
//   2. 读数上不能设置（fieldBlock：-1、无效读数、control_type 连带）；
//   3. 设备开关为关（读数或草稿）：只能改开关（方案 A7，照 201）；开关读数不可设置 / 无效时不按关处理；
//   4. can_change = false：控制类型不可切换；
//   5. 露点设定、湿度设定二选一：只有当前（草稿优先）控制类型对应的那一项能改。
import { buildRunningCtrlSet, type WriteQuery } from '@/api/ctrl'
import { blocked204, FIELDS_204, LABEL_204, type Field204 } from '@/api/writeLockVerify'
import { canStep, stepTemp } from '@/features/thermostat/edit'
import { CONTROL_TYPES, fieldBlock, LIMITS, SWITCHES_210, WIND_SPEEDS_210, type Raw210, type SettingsView } from './model'

export type Values204 = Partial<Record<Field204, number>>

/** 一台设备的草稿：values 只记用户动过的项；base 是开始编辑时的读数（null = 读数上没有值） */
export interface FaDraft {
  deviceId: number
  values: Values204
  base: Record<Field204, number | null>
}

/** 面板上下文：writable 为 null 表示可以下发，否则是只读的原因（开关关着、没有权限） */
export interface FaCtx { online: boolean; fresh: boolean; connected: boolean; writable: string | null }

export const TEXT_WRITE_OFF = '运行设置下发暂未开放，当前仅显示设备读到的设置'
export const TEXT_WRITE_FORBIDDEN = '当前账号没有下发运行设置的权限，当前仅显示设备读到的设置'
export const TEXT_OFFLINE = '项目离线，不能设置'
export const TEXT_STALE = '最近一次读取运行设置失败，不能设置'
export const TEXT_DISCONNECTED = '设备未连接，不能设置'
export const TEXT_DEVICE_OFF = '设备已关闭，请先开启再设置'
export const TEXT_CT_LOCKED = '该设备的控制类型不可切换'
export const TEXT_DEW_INACTIVE = '当前为湿度控制，露点设定不生效'
export const TEXT_HUM_INACTIVE = '当前为露点控制，湿度设定不生效'
export const TEXT_NO_CHANGES = '没有需要下发的修改'
export const TEXT_CONFLICT = '新风设置已在外部变化，请重新核对'

/** 设定值按 0.01 比较（露点步长 0.5、湿度步长 1，与 writeLockVerify.ts 的 sameSetpoint 同一取整） */
const sameVal = (f: Field204, a: number | null | undefined, b: number | null | undefined) => {
  if (a === null || a === undefined || b === null || b === undefined) return a === b
  return f === 'dewPoint' || f === 'humiditySet' ? Math.round(a * 100) === Math.round(b * 100) : a === b
}

/** 面板整体不能下发的原因（只读）；可以为 null */
export function panelBlock(ctx: FaCtx): string | null {
  if (ctx.writable) return ctx.writable
  if (!ctx.online) return TEXT_OFFLINE
  if (!ctx.fresh) return TEXT_STALE
  if (!ctx.connected) return TEXT_DISCONNECTED
  return null
}

/** 某一项的当前显示值：草稿优先，其次读数 */
export const shownOf = (s: SettingsView, d: FaDraft | null | undefined, f: Field204): number | null =>
  d && d.deviceId === s.deviceId && d.values[f] !== undefined ? d.values[f]! : s.fields[f].value

/** 某一项不能改的原因（见文件头 1–5）；可以改为 null */
export function editBlock(s: SettingsView, d: FaDraft | null | undefined, f: Field204, ctx: FaCtx): string | null {
  const p = panelBlock(ctx)
  if (p) return p
  const r = fieldBlock(s, f)
  if (r) return r
  if (f !== 'switch' && s.fields.switch.state === 'settable' && shownOf(s, d, 'switch') === 0) return TEXT_DEVICE_OFF
  if (f === 'controlType' && !s.canChange) return TEXT_CT_LOCKED
  if (f === 'dewPoint' && shownOf(s, d, 'controlType') !== 1) return TEXT_DEW_INACTIVE
  if (f === 'humiditySet' && shownOf(s, d, 'controlType') !== 0) return TEXT_HUM_INACTIVE
  return null
}

export const newDraft = (s: SettingsView): FaDraft => ({
  deviceId: s.deviceId,
  values: {},
  base: Object.fromEntries(FIELDS_204.map((f) => [f, s.fields[f].value])) as Record<Field204, number | null>,
})

/**
 * 编辑草稿：这一项不能改就原样返回；改回读数值等于去掉这一项。改完后把因此变得不能改的其他项去掉
 * （关机时去掉其他改动；切换控制类型时去掉不再生效的那个设定值）。草稿属于另一台设备时从新草稿开始
 */
export function editDraft(s: SettingsView, d: FaDraft | null | undefined, f: Field204, v: number, ctx: FaCtx): FaDraft {
  const cur: FaDraft = d && d.deviceId === s.deviceId ? { ...d, values: { ...d.values } } : newDraft(s)
  if (editBlock(s, cur, f, ctx)) return d && d.deviceId === s.deviceId ? d : cur
  if (sameVal(f, v, s.fields[f].value)) delete cur.values[f]
  else cur.values[f] = v
  for (const g of FIELDS_204) if (g !== f && cur.values[g] !== undefined && editBlock(s, cur, g, ctx)) delete cur.values[g]
  return cur
}

/** 设定值步进（露点 0.5、湿度 1，收进范围并对齐步长；与温控 stepTemp 同一算法） */
export function stepSetpoint(f: 'dewPoint' | 'humiditySet', from: number, dir: 1 | -1): number {
  return stepTemp(from, dir, LIMITS[f])
}
export const canStepSetpoint = (f: 'dewPoint' | 'humiditySet', v: number, dir: 1 | -1) => canStep(v, dir, LIMITS[f])

/** 草稿相对读数的实际改动：[字段, 原值, 新值]（与读数相同的项不算），按 FIELDS_204 的顺序 */
export type Change204 = [Field204, number | null, number]
export function draftChanges(s: SettingsView | null | undefined, d: FaDraft | null | undefined): Change204[] {
  if (!s || !d || d.deviceId !== s.deviceId) return []
  const out: Change204[] = []
  for (const f of FIELDS_204) {
    const v = d.values[f]
    if (v !== undefined && !sameVal(f, v, s.fields[f].value)) out.push([f, s.fields[f].value, v])
  }
  return out
}

export interface Reconciled {
  draft: FaDraft | null
  /** 清除的原因：设备不在了（或换了设备）/ 不能设置了 / 读数已是草稿值 */
  cleared?: 'gone' | 'blocked' | 'applied'
  /** 编辑期间读数被外部修改的项（草稿保留，但不能下发） */
  conflict: Field204[]
}

/**
 * 草稿生命周期（每次回读后调用）：设备不在 / 面板只读 / 改动项变得不能改 → 清除；读数已等于草稿的项去掉，全去掉则清除；
 * 剩下的项里读数与开始编辑时的基准不同 → 冲突
 */
export function reconcileDraft(d: FaDraft | null, s: SettingsView | null | undefined, ctx: FaCtx): Reconciled {
  if (!d) return { draft: null, conflict: [] }
  if (!s || s.deviceId !== d.deviceId) return { draft: null, cleared: 'gone', conflict: [] }
  if (panelBlock(ctx)) return { draft: null, cleared: 'blocked', conflict: [] }
  const values: Values204 = {}
  for (const f of FIELDS_204) {
    const v = d.values[f]
    if (v !== undefined && !sameVal(f, v, s.fields[f].value)) values[f] = v
  }
  const keys = Object.keys(values) as Field204[]
  if (!keys.length) return { draft: null, cleared: 'applied', conflict: [] }
  const next: FaDraft = keys.length === Object.keys(d.values).length ? d : { ...d, values }
  if (keys.some((f) => editBlock(s, next, f, ctx))) return { draft: null, cleared: 'blocked', conflict: [] }
  const conflict = keys.filter((f) => !sameVal(f, s.fields[f].value, d.base[f]))
  return { draft: next, conflict }
}

const inRange = (f: 'dewPoint' | 'humiditySet', v: number) => {
  const r = LIMITS[f]
  const k = (v - r.min) / r.step
  return v >= r.min - 1e-9 && v <= r.max + 1e-9 && Math.abs(k - Math.round(k)) < 1e-6
}

export type BuildResult = { ok: true; query: WriteQuery<204>; changed: Field204[] } | { ok: false; reason: string }

/**
 * 草稿 + 读数 → 204 Query（唯一的组装点）。s / raw 必须是同一次 210 读取（确认后预检用新读的那一份）。
 * 只放用户改了的字段，其余 -1（buildRunningCtrlSet 的底板）；id、name 取这份读数。
 * 面板只读、没有改动、有冲突、改动项不能改、设定值不在范围或不在步长上、blocked204 兜底不过（读数为空、id 不符、改了不能设置的项）时不给 Query
 */
export function build204(s: SettingsView, raw: Raw210 | null | undefined, d: FaDraft | null | undefined, ctx: FaCtx): BuildResult {
  const p = panelBlock(ctx)
  if (p) return { ok: false, reason: p }
  const changes = draftChanges(s, d)
  if (!changes.length) return { ok: false, reason: TEXT_NO_CHANGES }
  const rec = reconcileDraft(d ?? null, s, ctx)
  if (!rec.draft) return { ok: false, reason: rec.cleared === 'blocked' ? '改动的项已不能设置，请重新核对' : TEXT_CONFLICT }
  if (rec.conflict.length) return { ok: false, reason: TEXT_CONFLICT }
  for (const [f, , v] of changes) {
    const why = editBlock(s, d, f, ctx)
    if (why) return { ok: false, reason: `${LABEL_204[f]}：${why}` }
    if ((f === 'dewPoint' || f === 'humiditySet') && !inRange(f, v)) return { ok: false, reason: `${LABEL_204[f]}不在可设置范围内` }
  }
  const changed = changes.map(([f]) => f)
  const bad = blocked204(raw, s.deviceId, changed)
  if (bad) return { ok: false, reason: bad }
  const given: Values204 = Object.fromEntries(changes.map(([f, , v]) => [f, v]))
  return { ok: true, query: buildRunningCtrlSet(s.deviceId, s.name, given), changed }
}

/** 两份 Query 完全相同（确认时与预检时的组装结果比对） */
export const sameQuery = (a: WriteQuery<204>, b: WriteQuery<204>) => JSON.stringify(a) === JSON.stringify(b)

/** 两份运行设置读数相同（含每一项的状态、can_change、名称）：确认后新读的读数与确认时比对，不同就不发 */
export function sameSettings(a: SettingsView, b: SettingsView): boolean {
  if (a.deviceId !== b.deviceId || a.name !== b.name || a.canChange !== b.canChange) return false
  return FIELDS_204.every((f) => a.fields[f].state === b.fields[f].state && sameVal(f, a.fields[f].value, b.fields[f].value))
}

/** 210 的全部字段（含 name、can_change 与没改的项）；缺省按 proto3 默认值 */
const RAW_FIELDS = ['id', 'name', 'controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch', 'canChange'] as const
const RAW_DEFAULT: Record<(typeof RAW_FIELDS)[number], unknown> = { id: 0, name: '', controlType: 0, dewPoint: 0, humiditySet: 0, windSpeed: 0, switch: 0, canChange: false }
/**
 * 两份 210 原始解码读数逐字段严格相同（预检用：确认时的读数 vs 确认后新读的读数）。
 * 不经视图折叠（control_type = -1 时露点 / 湿度在视图里是 null）、数值不取整，-1 / 65536 / -100 等按原值比；
 * 任何一项不同（含没改的项、name、can_change）都算变化。sameSettings 只给界面用
 */
export function sameRaw210(a: Raw210 | null | undefined, b: Raw210 | null | undefined): boolean {
  if (!a || !b) return false
  return RAW_FIELDS.every((k) => Object.is(a[k] ?? RAW_DEFAULT[k], b[k] ?? RAW_DEFAULT[k]))
}

// ---------------------------------------------------------------------------
// 文案

/** 一项的值 → 显示文字（枚举按 proto 注释；设定值带单位）；null 为 -- */
export function valueText(f: Field204, v: number | null | undefined): string {
  if (v === null || v === undefined) return '--'
  if (f === 'controlType') return CONTROL_TYPES[v] ?? String(v)
  if (f === 'windSpeed') return WIND_SPEEDS_210[v] ?? String(v)
  if (f === 'switch') return SWITCHES_210[v] ?? String(v)
  if (f === 'dewPoint') return `${v.toFixed(1)} °C`
  return `${v.toFixed(0)} %RH`
}

/** 草稿条与确认弹窗：「风速 自动 → 高，露点设定 13.0 °C → 13.5 °C」 */
export const describeChanges = (cs: readonly Change204[]) => cs.map(([f, a, b]) => `${LABEL_204[f]} ${valueText(f, a)} → ${valueText(f, b)}`).join('，')
/** 成功提示：「风速 高」 */
export const describeResult = (cs: readonly Change204[]) => cs.map(([f, , b]) => `${LABEL_204[f]} ${valueText(f, b)}`).join('，')
/** 待确认草稿（读数已不可用或已等于草稿时）：「风速 → 高」 */
export const describeDraft = (d: FaDraft) => FIELDS_204.filter((f) => d.values[f] !== undefined).map((f) => `${LABEL_204[f]} → ${valueText(f, d.values[f])}`).join('，')
