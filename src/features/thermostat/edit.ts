// 房间卡片内修改设定温度与节能模式的规则（纯函数，不发请求）。依据 docs/design/thermostat-edit.md、
// docs/plan-v1.md 文末后端答复（Q5、⑤⑥⑦）、docs/api/ctrl同步消息200-210.md 4.2、11/24 群里的决定，以及后端 11/25 答复：
// - 只有温度和节能能改；风速只读；设定湿度去除；
// - 温度 16–30℃、步长 0.5（后端以后在接口里给范围，缺失回退这个值）；
// - 面板未连接、项目离线、最近一次读取失败时不允许设置；房间确定关着（开关读数可信且为关）时只能开房间。
//   房间开关未上报（features.roomSwitchReported = false）时不拿它禁用温度和节能（11/25 第 1 条）；
// - 节能模式下温度由系统设定：节能开启（面板或草稿）时温度不能改；同一次下发不能既改温度又开节能；
//   从节能切回标准只发 eco=0，温度用面板回读值；
// - 201 只发改了的标量，其余一律 -1（11/25 第 4 条）。end_modes：没改末端传空列表；改了末端就把该房间全部末端完整传回
//   （11/25 第 3 条）。末端 switch 是状态显示、不能改，完整回传时原样带回读到的值（见 endModesFor）。
import { buildRoomTemperatureSet, type WriteQuery } from '@/api/ctrl'
import { checkTemp, clampTemp, resolveTempRange } from '@/features/unified/rules'
import type { TempRange } from '@/features/unified/constants'
import { knownOff, type RoomView, type WireEndMode } from './model'

export type { TempRange }
export { resolveTempRange }

/**
 * 一个房间的草稿：只记用户动过的项；base 是开始编辑时的面板值（用于发现外部修改）。
 * ends 是各末端的 is_selected（与 room.wireEndModes 一一对应）。本期界面没有改末端的入口，只有组装和校验
 */
export interface RoomDraft {
  key: string
  temp?: number
  eco?: 0 | 1
  ends?: boolean[]
  base: { setTemp: number | null; eco: 0 | 1 | null; ends?: boolean[] }
}

/** 页面读取状态：项目在线、最近一次 200 读取成功 */
export interface EditCtx { online: boolean; fresh: boolean }

/** 温度比较精度：设定温度是 float，步长 0.5，按 0.01 比较足够 */
const same = (a: number, b: number) => Math.abs(a - b) < 0.005
const sameN = (a: number | null, b: number | null) => (a === null || b === null ? a === b : same(a, b))

/**
 * 步进：从 from 出发按方向走一步，并收进范围、对齐步长。from 不在步长格点上时先对齐再走
 * （例如 25.3 按 + 到 25.5、按 − 到 25.0，不会出现 25.8 这种值）；范围外的值先收回范围边界
 */
export function stepTemp(from: number, dir: 1 | -1, range: TempRange): number {
  const k = (from - range.min) / range.step
  const onGrid = Math.abs(k - Math.round(k)) < 1e-6
  const base = onGrid ? Math.round(k) : dir > 0 ? Math.floor(k) : Math.ceil(k)
  return clampTemp(range.min + (base + dir) * range.step, range)
}

/** 到上限 / 下限时对应按钮禁用 */
export const canStep = (v: number, dir: 1 | -1, range: TempRange) => (dir > 0 ? v < range.max - 1e-9 : v > range.min + 1e-9)

/** 下发前提（房间开关也要满足）：不满足返回原因 */
export function writeBlock(room: RoomView, ctx: EditCtx): string | null {
  if (!ctx.online) return '项目离线，不能设置'
  if (!ctx.fresh) return '最近一次读取面板失败，不能设置'
  if (!room.connected) return '面板离线，不能设置'
  return null
}

/** 温度 / 节能不能设置的原因（房间确定关着也不行；开关未知时不拦）；可以设置为 null */
export function editBlock(room: RoomView, ctx: EditCtx): string | null {
  return writeBlock(room, ctx) ?? (knownOff(room) ? '房间已关闭，请先开启再设置' : null)
}

const selOf = (room: RoomView) => room.wireEndModes.map((m) => m.isSelected === true)
const sameSel = (a: readonly boolean[] | undefined, b: readonly boolean[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i])

/**
 * 末端选择 → 201 的 end_modes（后端 11/25 答复第 3 条）：
 * - 没改（selected 缺省，或与读数相同）：空列表，表示不改末端；
 * - 改了：该房间全部末端完整传回（有 3 个传 3 个），只换 is_selected；option_name、type、is_change 原样，
 *   switch 是状态显示、由控制屏自己控制，不能改——原样带回读到的值（协议写的是「需要将获取的完整信息传入」）。
 * 不合法返回原因：数量和读数对不上、一个都没选（协议：至少选中一项）、取消了不允许关闭的末端（is_change = false）
 */
export function endModesFor(room: RoomView, selected?: readonly boolean[]): { ok: true; endModes: WireEndMode[] } | { ok: false; reason: string } {
  const cur = selOf(room)
  if (!selected || sameSel(selected, cur)) return { ok: true, endModes: [] }
  if (selected.length !== room.wireEndModes.length) return { ok: false, reason: '末端配置已变化，请重新核对' }
  if (!selected.some(Boolean)) return { ok: false, reason: '末端至少要选中一项' }
  // is_change = false：这个末端不能改（目前只有全空气），选中 / 取消两个方向都不允许
  const locked = room.wireEndModes.find((m, i) => m.isChange === false && (m.isSelected === true) !== selected[i])
  if (locked) return { ok: false, reason: `「${locked.optionName || '该末端'}」不允许修改` }
  return { ok: true, endModes: room.wireEndModes.map((m, i) => ({ ...m, isSelected: selected[i] })) }
}

/** 房间开关不能下发的原因（房间关着可以开） */
export const switchBlock = writeBlock

export const ECO_TEMP_TEXT = '节能模式下温度由系统设定'
/** 温度不能改的原因：节能开启（面板当前是节能，或草稿要开节能） */
export function tempBlock(room: RoomView, draft: RoomDraft | null | undefined): string | null {
  if (room.eco === 1) return ECO_TEMP_TEXT
  if (draft?.key === room.key && draft.eco === 1) return ECO_TEMP_TEXT
  return null
}

/** 开始编辑：新草稿记下面板当前值作为基准 */
export const newDraft = (room: RoomView): RoomDraft => ({ key: room.key, base: { setTemp: room.setTemp, eco: room.eco, ends: selOf(room) } })

/**
 * 编辑草稿。开节能时去掉温度改动（节能下温度由系统设定，同一次下发不能同时改）；
 * 节能开着时不接受温度改动
 */
export function editDraft(room: RoomView, draft: RoomDraft | null, patch: { temp?: number; eco?: 0 | 1; ends?: boolean[] }): RoomDraft {
  const d: RoomDraft = draft && draft.key === room.key ? { ...draft, base: draft.base } : newDraft(room)
  if (patch.eco !== undefined) {
    d.eco = patch.eco
    if (patch.eco === 1) delete d.temp
  }
  if (patch.temp !== undefined && !tempBlock(room, d)) d.temp = patch.temp
  if (patch.ends !== undefined) d.ends = [...patch.ends]
  return d
}

export interface Reconciled {
  /** 整理后的草稿；null = 清除 */
  draft: RoomDraft | null
  /** 清除的原因：房间不在了 / 不能设置了 / 面板已是草稿值 */
  cleared?: 'gone' | 'blocked' | 'applied'
  /** 编辑期间面板值被外部修改的项（草稿保留，但要用户重新核对，不能下发） */
  conflict: ('temp' | 'eco' | 'ends')[]
}

/**
 * 草稿生命周期（每次回读后调用）：房间不在 / 不能设置 → 清除；面板值已等于草稿的项 → 去掉该项，全去掉则清除；
 * 剩下的项里，面板值与开始编辑时的基准不同 → 冲突
 */
export function reconcileDraft(draft: RoomDraft | null, room: RoomView | undefined, ctx: EditCtx): Reconciled {
  if (!draft) return { draft: null, conflict: [] }
  if (!room) return { draft: null, cleared: 'gone', conflict: [] }
  if (editBlock(room, ctx)) return { draft: null, cleared: 'blocked', conflict: [] }
  const d: RoomDraft = { ...draft }
  if (d.temp !== undefined && room.setTemp !== null && same(d.temp, room.setTemp)) delete d.temp
  if (d.eco !== undefined && d.eco === room.eco) delete d.eco
  if (d.ends !== undefined && sameSel(d.ends, selOf(room))) delete d.ends
  if (d.temp === undefined && d.eco === undefined && d.ends === undefined) return { draft: null, cleared: 'applied', conflict: [] }
  const conflict: ('temp' | 'eco' | 'ends')[] = []
  if (d.temp !== undefined && !sameN(room.setTemp, d.base.setTemp)) conflict.push('temp')
  if (d.eco !== undefined && room.eco !== d.base.eco) conflict.push('eco')
  if (d.ends !== undefined && !sameSel(d.base.ends, selOf(room))) conflict.push('ends')
  const changed = d.temp !== draft.temp || d.eco !== draft.eco || d.ends !== draft.ends
  return { draft: changed ? d : draft, conflict }
}

export interface DraftChanges {
  /** [原值, 新值] */
  temp?: [number, number]
  eco?: [0 | 1, 0 | 1]
  ends?: [boolean[], boolean[]]
}

/** 草稿相对面板当前值的实际改动（与当前值相同的项不算） */
export function draftChanges(room: RoomView, draft: RoomDraft | null | undefined): DraftChanges {
  const out: DraftChanges = {}
  if (!draft || draft.key !== room.key) return out
  if (draft.temp !== undefined && room.setTemp !== null && !same(draft.temp, room.setTemp)) out.temp = [room.setTemp, draft.temp]
  if (draft.eco !== undefined && room.eco !== null && draft.eco !== room.eco) out.eco = [room.eco, draft.eco]
  if (draft.ends !== undefined && !sameSel(draft.ends, selOf(room))) out.ends = [selOf(room), [...draft.ends]]
  return out
}

export const hasDraftChanges = (c: DraftChanges) => c.temp !== undefined || c.eco !== undefined || c.ends !== undefined

export type BuildResult = { ok: true; query: WriteQuery<201> } | { ok: false; reason: string }

/**
 * 草稿 → 201 Query。只放改了的标量（温度 / 节能），其余 -1；end_modes 没改传空列表，改了按这份读数完整传回（endModesFor）。
 * 不能设置、没有改动、有冲突、温度不合法、节能下改温度时不给 Query（不下发）
 */
export function buildRoomSet(room: RoomView, draft: RoomDraft | null | undefined, ctx: EditCtx, range: TempRange): BuildResult {
  const block = editBlock(room, ctx)
  if (block) return { ok: false, reason: block }
  const c = draftChanges(room, draft)
  if (!hasDraftChanges(c)) return { ok: false, reason: '没有需要下发的修改' }
  const rec = reconcileDraft(draft ?? null, room, ctx)
  if (rec.conflict.length) return { ok: false, reason: '面板设定值已在外部变化，请重新核对' }
  if (c.temp) {
    if (tempBlock(room, draft)) return { ok: false, reason: ECO_TEMP_TEXT }
    const bad = checkTemp(c.temp[1], range)
    if (bad) return { ok: false, reason: bad }
  }
  // 只改末端：写锁核对数据（record201）没有末端字段，无法核对，本期不下发（接入改末端入口时一并补核对）
  if (c.ends && !c.temp && !c.eco) return { ok: false, reason: '只改末端暂不能下发（无法核对）' }
  const ends = endModesFor(room, c.ends?.[1])
  if (!ends.ok) return { ok: false, reason: ends.reason }
  return {
    ok: true,
    query: buildRoomTemperatureSet(room.equipmentId, {
      ...(c.temp ? { temperature: c.temp[1] } : {}),
      ...(c.eco ? { eco: c.eco[1] } : {}),
      endModes: ends.endModes,
    }),
  }
}

/** 房间开关 → 201 Query：switch 是真实值，其余标量 -1，end_modes 不改（空列表） */
export function buildRoomSwitch(room: RoomView, on: boolean, ctx: EditCtx): BuildResult {
  const block = switchBlock(room, ctx)
  if (block) return { ok: false, reason: block }
  return { ok: true, query: buildRoomTemperatureSet(room.equipmentId, { switch: on ? 1 : 0, endModes: [] }) }
}

export const ecoLabel = (v: 0 | 1) => (v === 1 ? '节能' : '标准')
/** 设温度的确认弹窗里加的一句（后端 11/25 答复第 16 条：温度设置会生效，但不会把设备打开） */
export const TEMP_OFF_NOTE = '设置温度不会开启房间，房间开启后按此温度运行'
/** 房间开关未上报期间开关类下发的结果条补充（固定判无法核对，写锁 2 分钟到期才放） */
export const SWITCH_UNREPORTED_NOTE = '设备暂不回报开关状态，2 分钟后可再次操作'
export const fmtTemp = (v: number) => v.toFixed(1)

/** 草稿条与确认弹窗里的描述：「设定温度 25.5 → 24.5°C，节能模式 标准 → 节能」 */
export function describeChanges(c: DraftChanges): string {
  const parts: string[] = []
  if (c.temp) parts.push(`设定温度 ${fmtTemp(c.temp[0])} → ${fmtTemp(c.temp[1])}°C`)
  if (c.eco) parts.push(`节能模式 ${ecoLabel(c.eco[0])} → ${ecoLabel(c.eco[1])}`)
  if (c.ends) parts.push(`末端选中 ${c.ends[0].filter(Boolean).length} 项 → ${c.ends[1].filter(Boolean).length} 项`)
  return parts.join('，')
}

/** 待确认草稿的描述（面板值不可用或已等于草稿时用）：「设定温度 → 26.0°C，节能模式 → 节能」 */
export function describeDraft(d: RoomDraft): string {
  const parts: string[] = []
  if (d.temp !== undefined) parts.push(`设定温度 → ${fmtTemp(d.temp)}°C`)
  if (d.eco !== undefined) parts.push(`节能模式 → ${ecoLabel(d.eco)}`)
  return parts.join('，')
}

/** 成功提示里的描述：「设定温度 24.5°C，节能模式 开」 */
export function describeResult(c: DraftChanges): string {
  const parts: string[] = []
  if (c.temp) parts.push(`设定温度 ${fmtTemp(c.temp[1])}°C`)
  if (c.eco) parts.push(`节能模式 ${c.eco[1] === 1 ? '开' : '关'}`)
  return parts.join('，')
}

/** 确认期间状态是否变了：比较两份 Query（含末端）与房间关键状态 */
export function sameQuery(a: WriteQuery<201>, b: WriteQuery<201>) {
  return JSON.stringify(a) === JSON.stringify(b)
}
