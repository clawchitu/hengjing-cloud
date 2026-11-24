// 房间卡片内修改设定温度与节能模式的规则（纯函数，不发请求）。依据 docs/design/thermostat-edit.md、
// docs/plan-v1.md 文末后端答复（Q5、⑤⑥⑦）、docs/api/ctrl同步消息200-210.md 4.2，以及 11/24 群里的决定：
// - 只有温度和节能能改；风速只读；设定湿度去除；
// - 温度 16–30℃、步长 0.5（后端以后在接口里给范围，缺失回退这个值）；
// - 房间关闭、面板未连接、项目离线、最近一次读取失败、没读到末端时不允许设置；
// - 节能模式下温度由系统设定：节能开启（面板或草稿）时温度不能改；同一次下发不能既改温度又开节能；
//   从节能切回标准只发 eco=0，温度用面板回读值；
// - 201 只发改了的标量，其余一律 -1；end_modes 不传空列表，而是把最新读到的该房间末端原样传回。
import { buildRoomTemperatureSet, type WriteQuery } from '@/api/ctrl'
import { checkTemp, clampTemp, resolveTempRange } from '@/features/unified/rules'
import type { TempRange } from '@/features/unified/constants'
import type { RoomView } from './model'

export type { TempRange }
export { resolveTempRange }

/** 一个房间的草稿：只记用户动过的项；base 是开始编辑时的面板值（用于发现外部修改） */
export interface RoomDraft {
  key: string
  temp?: number
  eco?: 0 | 1
  base: { setTemp: number | null; eco: 0 | 1 | null }
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
  if (!room.wireEndModes.length) return '没有读到该房间的末端配置，不能下发'
  return null
}

/** 温度 / 节能不能设置的原因（房间关闭也不行）；可以设置为 null */
export function editBlock(room: RoomView, ctx: EditCtx): string | null {
  return writeBlock(room, ctx) ?? (room.on ? null : '房间已关闭，请先开启再设置')
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
export const newDraft = (room: RoomView): RoomDraft => ({ key: room.key, base: { setTemp: room.setTemp, eco: room.eco } })

/**
 * 编辑草稿。开节能时去掉温度改动（节能下温度由系统设定，同一次下发不能同时改）；
 * 节能开着时不接受温度改动
 */
export function editDraft(room: RoomView, draft: RoomDraft | null, patch: { temp?: number; eco?: 0 | 1 }): RoomDraft {
  const d: RoomDraft = draft && draft.key === room.key ? { ...draft, base: draft.base } : newDraft(room)
  if (patch.eco !== undefined) {
    d.eco = patch.eco
    if (patch.eco === 1) delete d.temp
  }
  if (patch.temp !== undefined && !tempBlock(room, d)) d.temp = patch.temp
  return d
}

export interface Reconciled {
  /** 整理后的草稿；null = 清除 */
  draft: RoomDraft | null
  /** 清除的原因：房间不在了 / 不能设置了 / 面板已是草稿值 */
  cleared?: 'gone' | 'blocked' | 'applied'
  /** 编辑期间面板值被外部修改的项（草稿保留，但要用户重新核对，不能下发） */
  conflict: ('temp' | 'eco')[]
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
  if (d.temp === undefined && d.eco === undefined) return { draft: null, cleared: 'applied', conflict: [] }
  const conflict: ('temp' | 'eco')[] = []
  if (d.temp !== undefined && !sameN(room.setTemp, d.base.setTemp)) conflict.push('temp')
  if (d.eco !== undefined && room.eco !== d.base.eco) conflict.push('eco')
  const changed = d.temp !== draft.temp || d.eco !== draft.eco
  return { draft: changed ? d : draft, conflict }
}

export interface DraftChanges {
  /** [原值, 新值] */
  temp?: [number, number]
  eco?: [0 | 1, 0 | 1]
}

/** 草稿相对面板当前值的实际改动（与当前值相同的项不算） */
export function draftChanges(room: RoomView, draft: RoomDraft | null | undefined): DraftChanges {
  const out: DraftChanges = {}
  if (!draft || draft.key !== room.key) return out
  if (draft.temp !== undefined && room.setTemp !== null && !same(draft.temp, room.setTemp)) out.temp = [room.setTemp, draft.temp]
  if (draft.eco !== undefined && room.eco !== null && draft.eco !== room.eco) out.eco = [room.eco, draft.eco]
  return out
}

export const hasDraftChanges = (c: DraftChanges) => c.temp !== undefined || c.eco !== undefined

export type BuildResult = { ok: true; query: WriteQuery<201> } | { ok: false; reason: string }

/**
 * 草稿 → 201 Query。只放改了的标量（温度 / 节能），其余 -1；end_modes 用这份读数里该房间的末端原样传回。
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
  return {
    ok: true,
    query: buildRoomTemperatureSet(room.equipmentId, {
      ...(c.temp ? { temperature: c.temp[1] } : {}),
      ...(c.eco ? { eco: c.eco[1] } : {}),
      endModes: room.wireEndModes.map((m) => ({ ...m })),
    }),
  }
}

/** 房间开关 → 201 Query：switch 是真实值，其余标量 -1，end_modes 用这份读数的原样传回 */
export function buildRoomSwitch(room: RoomView, on: boolean, ctx: EditCtx): BuildResult {
  const block = switchBlock(room, ctx)
  if (block) return { ok: false, reason: block }
  return { ok: true, query: buildRoomTemperatureSet(room.equipmentId, { switch: on ? 1 : 0, endModes: room.wireEndModes.map((m) => ({ ...m })) }) }
}

export const ecoLabel = (v: 0 | 1) => (v === 1 ? '节能' : '标准')
export const fmtTemp = (v: number) => v.toFixed(1)

/** 草稿条与确认弹窗里的描述：「设定温度 25.5 → 24.5°C，节能模式 标准 → 节能」 */
export function describeChanges(c: DraftChanges): string {
  const parts: string[] = []
  if (c.temp) parts.push(`设定温度 ${fmtTemp(c.temp[0])} → ${fmtTemp(c.temp[1])}°C`)
  if (c.eco) parts.push(`节能模式 ${ecoLabel(c.eco[0])} → ${ecoLabel(c.eco[1])}`)
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
