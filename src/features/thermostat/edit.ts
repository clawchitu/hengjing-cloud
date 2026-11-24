// 房间卡片内修改设定温度与节能模式的规则（纯函数，不发请求）。依据 docs/design/thermostat-edit.md、
// docs/plan-v1.md 文末后端答复（Q5、⑤⑥⑦）与 docs/api/ctrl同步消息200-210.md 4.2。
// - 只有温度和节能能改；风速只读；设定湿度去除；末端本期只读；
// - 温度 16–30℃、步长 0.5（后端以后在接口里给范围，缺失回退这个值）；
// - 房间关闭、面板未连接、项目离线时不允许设置；
// - 201 只发改了的字段，其余标量一律 -1，end_modes 不改传空列表（ctrl.ts 的 buildRoomTemperatureSet）。
import { buildRoomTemperatureSet, type WriteQuery } from '@/api/ctrl'
import { checkTemp, clampTemp, resolveTempRange } from '@/features/unified/rules'
import type { TempRange } from '@/features/unified/constants'
import type { RoomView } from './model'

export type { TempRange }
export { resolveTempRange }

/** 一个房间的草稿：只记用户动过的项（与面板当前值相同的项视为没改） */
export interface RoomDraft {
  key: string
  temp?: number
  eco?: 0 | 1
}

/** 温度比较精度：设定温度是 float，步长 0.5，按 0.01 比较足够 */
const same = (a: number, b: number) => Math.abs(a - b) < 0.005

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

/** 不能设置的原因；可以设置为 null */
export function editBlock(room: RoomView, projectOnline: boolean): string | null {
  if (!projectOnline) return '项目离线，不能设置'
  if (!room.connected) return '面板离线，不能设置'
  if (!room.on) return '房间已关闭，请先开启再设置'
  return null
}

/** 房间开关不能下发的原因（房间关着可以开，但项目离线 / 面板未连接不行） */
export function switchBlock(room: RoomView, projectOnline: boolean): string | null {
  if (!projectOnline) return '项目离线，不能设置'
  if (!room.connected) return '面板离线，不能设置'
  return null
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
 * 草稿 → 201 Query。只放改了的字段（温度 / 节能），其余标量 -1、end_modes 为空列表。
 * 不能设置、没有改动、温度不合法时不给 Query（不下发）
 */
export function buildRoomSet(room: RoomView, draft: RoomDraft | null | undefined, projectOnline: boolean, range: TempRange): BuildResult {
  const block = editBlock(room, projectOnline)
  if (block) return { ok: false, reason: block }
  const c = draftChanges(room, draft)
  if (!hasDraftChanges(c)) return { ok: false, reason: '没有需要下发的修改' }
  if (c.temp) {
    const bad = checkTemp(c.temp[1], range)
    if (bad) return { ok: false, reason: bad }
  }
  return {
    ok: true,
    query: buildRoomTemperatureSet(room.equipmentId, {
      ...(c.temp ? { temperature: c.temp[1] } : {}),
      ...(c.eco ? { eco: c.eco[1] } : {}),
    }),
  }
}

/** 房间开关 → 201 Query：只有 switch 是真实值，其余标量 -1、end_modes 为空列表 */
export const buildRoomSwitch = (room: RoomView, on: boolean): WriteQuery<201> => buildRoomTemperatureSet(room.equipmentId, { switch: on ? 1 : 0 })

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
