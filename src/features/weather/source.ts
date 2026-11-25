// 天气的两个数据源，接口相同，按运行时配置 dataSource 选择（与 src/features/thermostat/source.ts 同样的做法）：
// - real：POST /weather、/weather24 {city}，city 由 weatherQueryOf() 决定（行政区划码，带标记的按名称）；
// - mock：演示回包（src/mock/weather.ts），城市名换成所选城市，不发请求。
// 交付包（__HJC_MOCK__ = false）里 weatherSource() 恒为 real，演示分支在打包时剔除。
import { isMockMode } from '@/api/config'
import { request } from '@/api/http'
import { weather24Raw, weatherRaw } from '@/mock/weather'
import { findCity } from './cities'
import { toWeather24, toWeatherNow, type RawWeather, type RawWeather24, type Weather24View, type WeatherNowView } from './model'

export interface WeatherSource {
  readonly kind: 'real' | 'mock'
  /** /weather：实时 + 7 天 */
  now(city: string, signal?: AbortSignal): Promise<WeatherNowView>
  /** /weather24：24 小时 */
  hours(city: string, signal?: AbortSignal): Promise<Weather24View>
}

export const realSource: WeatherSource = {
  kind: 'real',
  now: async (city, signal) => toWeatherNow(await request<RawWeather>('/weather', { body: { city }, signal })),
  hours: async (city, signal) => toWeather24(await request<RawWeather24>('/weather24', { body: { city }, signal })),
}

/** 演示回包的城市名换成所选城市（查询值是码或名称），其余数据不变 */
const mockName = (q: string) => findCity(q)?.name ?? q
const mockSource: WeatherSource = {
  kind: 'mock',
  now: async (city) => { const r = structuredClone(weatherRaw); r.weather!.cityInfo = { ...r.weather!.cityInfo, c3: mockName(city) }; return toWeatherNow(r) },
  hours: async (city) => { const r = structuredClone(weather24Raw); r.weather!.area = mockName(city); return toWeather24(r) },
}

export const weatherSource = (): WeatherSource => (__HJC_MOCK__ && isMockMode() ? mockSource : realSource)
