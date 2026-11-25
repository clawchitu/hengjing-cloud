// /weather、/weather24 回包 → 视图模型。字段以 docs/api/weather-sample-320500.json 和
// docs/api/实测记录-1125-新风天气.md R7 为准；所有字段都可能缺，缺了就是 null，界面据此隐藏。
// 回包里没有数据（weather 缺失、ret_code 非 0、/weather 没有 now、/weather24 没有 hourList）时抛 WeatherNoData。
import { dewPoint } from './dew'

type Str = string | undefined | null
interface RawForecast {
  day?: string; weekday?: number
  day_weather?: string; night_weather?: string; day_weather_code?: string; night_weather_code?: string
  day_wind_direction?: string; day_wind_power?: string
  day_air_temperature?: string; night_air_temperature?: string
  air_press?: string; jiangshui?: string; ziwaixian?: string; sun_begin_end?: string
}
interface RawNow {
  temperature?: string; weather?: string; weather_code?: string; wind_direction?: string; wind_power?: string
  temperature_time?: string; sd?: string; aqiDetail?: { quality?: string; aqi?: string; pm2_5?: string }
}
export interface RawWeather {
  weather?: { ret_code?: number; time?: string; cityInfo?: { c0?: string; c3?: string }; now?: RawNow } & Partial<Record<`f${1 | 2 | 3 | 4 | 5 | 6 | 7}`, RawForecast>>
}
export interface RawWeather24 {
  weather?: { ret_code?: number; area?: string; areaCode?: string; hourList?: { time?: string; weather?: string; weather_code?: string; temperature?: string; wind_direction?: string; wind_power?: string }[] }
}

export class WeatherNoData extends Error {
  constructor() { super('未查到该城市天气'); this.name = 'WeatherNoData' }
}

export interface DayForecast {
  /** YYYY-MM-DD */
  date: string | null
  /** 1–7，周一为 1 */
  weekday: number | null
  dayText: string | null; nightText: string | null; dayCode: string | null
  high: number | null; low: number | null
  windDirection: string | null; windPower: string | null
  /** hPa */
  pressure: number | null
  /** 降水概率 % */
  rainChance: number | null
  uv: string | null
  sunrise: string | null; sunset: string | null
}
export interface WeatherNowView {
  city: string | null
  /** 数据时间 YYYY-MM-DD HH:mm */
  time: string | null
  temp: number | null; text: string | null; code: string | null
  windDirection: string | null; windPower: string | null
  /** 相对湿度 % */
  humidity: number | null
  /** 露点 °C，由温度和湿度算出 */
  dew: number | null
  aqi: number | null; aqiText: string | null; pm25: number | null
  /** f1–f7，缺的天跳过 */
  days: DayForecast[]
}
export interface HourForecast { time: string | null; text: string | null; code: string | null; temp: number | null; windDirection: string | null; windPower: string | null }
export interface Weather24View { area: string | null; hours: HourForecast[] }

const str = (v: Str) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
/** 字符串里的第一个数（'51%' → 51、'1031.3 hPa' → 1031.3）；没有数返回 null */
export function num(v: Str): number | null {
  const m = str(v)?.match(/^-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
/** 'HH:mm|HH:mm' → 日出、日落 */
export function sunOf(v: Str): { sunrise: string | null; sunset: string | null } {
  const m = str(v)?.match(/^(\d{2}:\d{2})\|(\d{2}:\d{2})$/)
  return m ? { sunrise: m[1], sunset: m[2] } : { sunrise: null, sunset: null }
}
/** 风力只取级别（'0-3级 <5.4m/s'、'0-3级 微风  <5.4m/s' → '0-3级'，'3级' → '3级'） */
export function windLevel(v: Str): string | null {
  return str(v)?.match(/^\d+(-\d+)?级/)?.[0] ?? null
}
/** 'yyyyMMdd' → 'yyyy-MM-dd' */
export function dateOf(v: Str): string | null {
  const m = str(v)?.match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
/** 'yyyyMMddHHmm'（/weather24）或 'yyyyMMddHHmmss'（/weather）→ 'yyyy-MM-dd HH:mm' */
export function timeOf(v: Str): string | null {
  const m = str(v)?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null
}
const noData = (w: { ret_code?: number } | undefined) => !w || (w.ret_code !== undefined && w.ret_code !== 0)

function dayOf(f: RawForecast): DayForecast {
  return {
    date: dateOf(f.day), weekday: typeof f.weekday === 'number' && f.weekday >= 1 && f.weekday <= 7 ? f.weekday : null,
    dayText: str(f.day_weather), nightText: str(f.night_weather), dayCode: str(f.day_weather_code),
    high: num(f.day_air_temperature), low: num(f.night_air_temperature),
    windDirection: str(f.day_wind_direction), windPower: windLevel(f.day_wind_power),
    pressure: num(f.air_press), rainChance: num(f.jiangshui), uv: str(f.ziwaixian), ...sunOf(f.sun_begin_end),
  }
}

export function toWeatherNow(r: RawWeather | null | undefined): WeatherNowView {
  const w = r?.weather
  if (noData(w) || !w?.now) throw new WeatherNoData()
  const n = w.now
  const temp = num(n.temperature)
  const humidity = num(n.sd)
  const days = ([1, 2, 3, 4, 5, 6, 7] as const).flatMap((i) => { const f = w[`f${i}`]; return f ? [dayOf(f)] : [] })
  return {
    city: str(w.cityInfo?.c3), time: timeOf(w.time),
    temp, text: str(n.weather), code: str(n.weather_code),
    windDirection: str(n.wind_direction), windPower: windLevel(n.wind_power),
    humidity, dew: dewPoint(temp, humidity),
    aqi: num(n.aqiDetail?.aqi), aqiText: str(n.aqiDetail?.quality), pm25: num(n.aqiDetail?.pm2_5),
    days,
  }
}

export function toWeather24(r: RawWeather24 | null | undefined): Weather24View {
  const w = r?.weather
  if (noData(w) || !Array.isArray(w?.hourList) || w.hourList.length === 0) throw new WeatherNoData()
  return {
    area: str(w.area),
    hours: w.hourList.map((h) => ({ time: timeOf(h?.time), text: str(h?.weather), code: str(h?.weather_code), temp: num(h?.temperature), windDirection: str(h?.wind_direction), windPower: windLevel(h?.wind_power) })),
  }
}
