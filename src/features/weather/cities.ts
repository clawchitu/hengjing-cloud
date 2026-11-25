// 首页天气的本地城市：省 → 地级市两级，数据在 cities.data.ts（scripts/gen-weather-cities.mjs 生成）。
// 不调 /wx/city-list，不做浏览器定位、IP 定位，也不用项目所在城市（负责人和唐学未 11/25 的最终口径）。
import { CITY_SOURCE, PROVINCES } from './cities.data'

export interface City {
  /** 6 位行政区划码；直辖市用省级码（110000） */
  code: string
  name: string
  /** 'name'：/weather 按行政区划码查不到，要按名称查（实测见 docs/api/weather-coverage-1124.json） */
  queryBy?: 'name'
}
export interface Province { code: string; name: string; cities: readonly City[] }

export { CITY_SOURCE, PROVINCES }

/** 用户没选过城市时的默认城市：无锡 */
export const DEFAULT_CITY_CODE = '320200'

const byCode = new Map<string, { city: City; province: Province }>()
for (const p of PROVINCES) for (const c of p.cities) byCode.set(c.code, { city: c, province: p })

/** 按 6 位码找城市；不在城市文件里返回 null */
export const findCity = (code: unknown): City | null => (typeof code === 'string' && byCode.get(code)?.city) || null
/** 城市所在的省 */
export const provinceOf = (code: string): Province | null => byCode.get(code)?.province ?? null
/** 默认城市（城市文件里一定有，用例钉住） */
export const defaultCity = (): City => findCity(DEFAULT_CITY_CODE) as City

/** /weather、/weather24 请求体里的 city：带 queryBy='name' 标记的按名称查，其余按行政区划码查 */
export const weatherQueryOf = (city: City): string => (city.queryBy === 'name' ? city.name : city.code)
