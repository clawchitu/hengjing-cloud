// 202（新风 / 除湿机状态）里滤网两个字段的口径（后端 11/25 答复第 10 条）：
// - filter_life：滤网剩余寿命，单位是「天」（filter_life = 100 指 100 天）；
// - filter_life_p：滤网剩余寿命的比例，0–1（1 = 100%）。界面显示时乘 100；告警阈值也按比例算。
// 注意：proto 里 filter_life_p 是 int32，按比例传只能是 0 或 1，已列入待后端确认（是否改成 float）；这里按 0–1 的数处理，
// 小数也能用。S10a 的视图模型（model.ts）直接用这里的函数，不另写一套。
import { reading } from '@/api/values'

/** 告警阈值（比例）：低于 0.15 红色「请尽快更换」，低于 0.5 橙色「已使用过半」 */
export const FILTER_RED_RATIO = 0.15
export const FILTER_ORANGE_RATIO = 0.5

export type FilterLevel = 'red' | 'orange' | 'ok'

export interface FilterView {
  /** 剩余寿命（天）；无数据为 null */
  days: number | null
  /** 剩余比例 0–1；无数据或不在 0–1 内为 null */
  ratio: number | null
  /** 显示用百分比（比例 × 100，取整）；无数据为 null */
  percent: number | null
  /** 告警级别（按比例）；无数据为 null。是否显示颜色和更换提示由 features.freshAirFilterWarn 决定 */
  level: FilterLevel | null
}

/** 202 的一条 → 滤网视图。65536、-100、非有限数按无数据；0 是有效读数（0 天 / 0%） */
export function filterOf(raw: { filterLife?: number; filterLifeP?: number }): FilterView {
  const d = reading(raw.filterLife)
  const days = d !== null && d >= 0 ? d : null
  const p = reading(raw.filterLifeP)
  const ratio = p !== null && p >= 0 && p <= 1 ? p : null
  return {
    days,
    ratio,
    percent: ratio === null ? null : Math.round(ratio * 100),
    level: ratio === null ? null : ratio < FILTER_RED_RATIO ? 'red' : ratio < FILTER_ORANGE_RATIO ? 'orange' : 'ok',
  }
}

/** 运行时间、滤网运行时间：单位小时（后端 11/26 确认）。「1,234 小时」；-1、缺失、非有限数显示「—」 */
export function hoursText(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === -1) return '—'
  return `${Math.round(v).toLocaleString('en-US')} 小时`
}
