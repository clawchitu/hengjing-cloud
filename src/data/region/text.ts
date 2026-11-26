// 区划码 → 区域文字的纯函数（不含名称表，单测直接传表）。
/** 6 位区划码 → 名称 */
export type RegionNames = ReadonlyMap<string, string>

/** 直辖市、省直辖县级市的地级一层是占位名，显示时用省级名代替 */
const PLACEHOLDER = /^(市辖区|县|省直辖县级行政区划|自治区直辖县级行政区划)$/

/**
 * 项目的 customer_region（实测是「省/市/区县」6 位码用 / 连接，也有只到市、只到省的）转成区域文字：
 * - 按最细一级取名：区县级「市 区县」（苏州市 吴中区），市级「市」（苏州市），省级「省」（江苏省）；
 * - 直辖市、省直辖县级市的地级是占位名，换成省级名：「北京市 东城区」「湖北省 仙桃市」，只到市级的直辖市显示「天津市」；
 * - 空值返回 ''（页面显示「—」）；格式不对、各级码对不上或查不到返回「原值（未知）」；
 * - names 为 null（名称表没加载成功）时原样返回码。
 * 也接受 9 / 12 位的统计用区划码，只取前 6 位。
 */
export function regionText(raw: unknown, names: RegionNames | null): string {
  const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (!s) return ''
  if (!names) return s
  const unknown = `${s}（未知）`
  // 空段（「/」「320000//320500」）也算格式不对
  const segs = s.split('/').map((x) => x.trim())
  if (!segs.every((x) => /^\d{6}(\d{3}|\d{6})?$/.test(x))) return unknown
  const codes = segs.map((x) => x.slice(0, 6))
  const code = codes[codes.length - 1]
  const prov = code.slice(0, 2) + '0000'
  const city = code.slice(0, 4) + '00'
  const level = code === prov ? 1 : code === city ? 2 : 3
  // 前面各段必须是最细一级的上级（「320000/320500/320506」），对不上按未知
  if (!codes.every((c) => c === prov || c === city || c === code)) return unknown
  const p = names.get(prov)
  if (!p) return unknown
  if (level === 1) return p
  const c = names.get(city)
  if (!c) return unknown
  const cityName = PLACEHOLDER.test(c) ? p : c
  if (level === 2) return cityName
  const d = names.get(code)
  return d ? `${cityName} ${d}` : unknown
}
