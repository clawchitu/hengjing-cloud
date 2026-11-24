// 后端特殊取值的处理工具。
// - 设置接口（201、203、204、206）里不修改的字段一律传 -1（后端 11/24 答复）；
//   203 的 system_mode 是枚举，「不变」是 0（OPERATION_MODE_NONE）。
// - 设备读数 65536 表示无数据（设备字段 2 字节最大 65535，65536 = 未初始化）→ 隐藏该项。
// - 小时统计（208/209）里 -100 是无效数据；210 的露点/设定湿度 -1 显示 --。

export const UNCHANGED = -1
export const NO_DATA = 65536
export const INVALID_HOURLY = -100
export const PLACEHOLDER = '--'

/** 设备读数：65536、NaN、缺失 → null（页面据此隐藏该项） */
export function reading(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v) || v === NO_DATA) return null
  return v
}

/** 小时统计值：额外把 -100 视为无效 */
export function hourlyReading(v: number | null | undefined): number | null {
  const r = reading(v)
  return r === INVALID_HOURLY ? null : r
}

/** 设定值：-1 表示不可用/未设置 → null */
export function setting(v: number | null | undefined): number | null {
  const r = reading(v)
  return r === UNCHANGED ? null : r
}

/** 显示用：null 显示 -- */
export const display = (v: number | null, digits = 1) => (v === null ? PLACEHOLDER : v.toFixed(digits))

/**
 * 组装设置请求：fields 里每一项默认 -1（不变），只有 changes 里给了的才下发真实值。
 * changes 里显式传 undefined 也视为不变。
 */
export function withUnchanged<K extends string>(fields: readonly K[], changes: Partial<Record<K, number>>): Record<K, number> {
  const out = {} as Record<K, number>
  for (const f of fields) {
    const v = changes[f]
    out[f] = v === undefined ? UNCHANGED : v
  }
  return out
}

/** 是否真的有要改的项（全是 -1 的请求不应发出） */
export const hasChanges = (q: Record<string, number>) => Object.values(q).some((v) => v !== UNCHANGED)
