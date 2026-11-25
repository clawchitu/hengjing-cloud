// 首页天气的纯函数（S7b）：天气图标、/weather 不可用时顶替用的小时、城市搜索匹配。组件在 ./WeatherSection.tsx。
import { faSun, faCloudSun, faCloudRain, faCloud, faSnowflake, faSmog, faCloudBolt, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import type { City, HourForecast } from '../../features/weather'

// 天气图标：按天气现象代码（00 晴、01 多云、02 阴、03–12 雨、13–17 雪、18 / 53 雾霾……）

export function iconOf(code: string | null, text: string | null): [IconDefinition, string] {
  const c = code === null ? NaN : Number(code)
  const t = text ?? ''
  if (c === 0 || (!Number.isFinite(c) && t.includes('晴'))) return [faSun, '#f59e0b']
  if (c === 1 || (!Number.isFinite(c) && t.includes('多云'))) return [faCloudSun, '#f59e0b']
  if ((c >= 3 && c <= 5) || t.includes('雷')) return [faCloudBolt, '#6366f1']
  if ((c >= 6 && c <= 12) || (c >= 19 && c <= 25) || t.includes('雨')) return [faCloudRain, '#0ea5e9']
  if ((c >= 13 && c <= 17) || (c >= 26 && c <= 28) || t.includes('雪')) return [faSnowflake, '#38bdf8']
  if (c === 18 || c === 53 || (c >= 29 && c <= 36) || t.includes('雾') || t.includes('霾') || t.includes('沙')) return [faSmog, '#94a3b8']
  return [faCloud, '#94a3b8']
}

export const WEEKDAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
/** 'yyyy-MM-dd HH:mm' → 'H时' */
export const hourLabel = (t: string | null) => (t ? `${Number(t.slice(11, 13))}时` : '')
export const deg = (v: number | null) => (v === null ? '--' : `${v}°`)

/** 顶替的时间差上限：最近的一小时离现在超过 2 小时就不顶替 */
export const NEAREST_HOUR_MAX_GAP_MS = 2 * 3600_000
/** /weather 不可用时，用 24 小时预报里离现在最近的一小时顶替实时（只顶替温度、天气、风向、风力）；差超过 2 小时返回 null */
export function nearestHour(hours: readonly HourForecast[], now: number): HourForecast | null {
  let best: HourForecast | null = null
  let gap = NEAREST_HOUR_MAX_GAP_MS + 1
  for (const h of hours) {
    if (!h.time) continue
    const t = Date.parse(h.time.replace(' ', 'T') + ':00+08:00')
    if (!Number.isFinite(t)) continue
    const d = Math.abs(t - now)
    if (d < gap) { gap = d; best = h }
  }
  return best
}

/** 按城市名、省名匹配；「无锡」能匹配「无锡市」 */
export const matchCity = (c: City, provinceName: string, q: string) => {
  const s = q.trim()
  return !s || c.name.includes(s) || provinceName.includes(s)
}

