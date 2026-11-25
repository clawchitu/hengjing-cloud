// 后端特殊取值的处理工具。
// - 设置接口（201、203、204、206）里不修改的字段一律传 -1（后端 11/24、11/25 答复），203 的 system_mode 枚举也一样传 -1；
//   0 是真实值，不能当「不变」（proto3 里没赋值的标量编码后就是 0，所以组装一律先铺 -1 底板，见 ctrl.ts unchangedOf）。
// - 设备读数 65536 表示无数据（设备字段 2 字节最大 65535，65536 = 未初始化，后端 11/24 答复⑪）→ 隐藏该项。
// - -100 是无效数据（proto 207/208 字段注释；后端 11/25 答复第 9 条：「0 是有效数据，-100 才是无效数据」），所有读数一样处理。
//   0 是有效读数，不能当成「没有数据」。
// - 210 的露点 / 设定湿度 / 控制类型读到 -1：这一项不能设置（后端 11/25 答复第 5 条），显示 --。

export const UNCHANGED = -1
export const NO_DATA = 65536
export const INVALID_HOURLY = -100
export const PLACEHOLDER = '--'

/** 设备读数：65536（未初始化）、-100（无效数据）、NaN、缺失 → null（页面据此隐藏该项）；0 是有效读数 */
export function reading(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v) || v === NO_DATA || v === INVALID_HOURLY) return null
  return v
}

/** 小时统计值：与 reading 同一口径（-100 现在对所有读数都是无效），保留这个名字给统计代码用 */
export const hourlyReading = reading

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

/** fields 里是否有不是 -1 的项（全是 -1 的请求不应发出）。只看给出的可改字段，不看设备 ID 等 */
export const hasChanges = <K extends string>(q: Record<K, number>, fields: readonly K[]) => fields.some((f) => q[f] !== UNCHANGED)
