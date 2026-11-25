// 由温度（°C）和相对湿度（%）算露点（Magnus 公式，Alduchov-Eskridge 系数 a=17.625、b=243.04），保留 1 位小数。
// 湿度缺失、不在 (0, 100] 内或温度缺失时返回 null。
const A = 17.625
const B = 243.04

export function dewPoint(temp: number | null, rh: number | null): number | null {
  if (temp == null || rh == null || !Number.isFinite(temp) || !Number.isFinite(rh) || rh <= 0 || rh > 100) return null
  const g = Math.log(rh / 100) + (A * temp) / (B + temp)
  return Math.round(((B * g) / (A - g)) * 10) / 10
}
