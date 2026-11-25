// 首页天气的数据 hooks（TanStack Query，沿用全局默认值：服务器错误、网络、超时重试 1 次）。
// - 城市：useWeatherCity() 读当前账号选过的城市（cityStore.ts），没选过就是无锡；
// - 实时 + 7 天（/weather）和 24 小时（/weather24）是两个独立查询，状态各自独立，一个失败不影响另一个；
// - 服务端按 city 缓存 30 分钟，这里 staleTime 也是 30 分钟；查询键带账号，换账号不串；
// - 失败（接口报错、没有数据）不抛到组件，返回 status='error' 和「暂无天气数据」，页面据此降级，不白屏；
// - 没有该接口权限时不发请求，status='forbidden'。
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { can, useSession } from '@/data/session'
import { readCity, writeCity } from './cityStore'
import { weatherQueryOf, type City } from './cities'
import type { Weather24View, WeatherNowView } from './model'
import { weatherSource } from './source'

export const WEATHER_STALE_MS = 30 * 60_000
export const NO_WEATHER_TEXT = '暂无天气数据'
export const WEATHER_FORBIDDEN_TEXT = '当前账号未开通天气功能'

export const weatherKeys = {
  all: ['weather'] as const,
  now: (userKey: string | null, kind: string, city: string) => ['weather', userKey, kind, 'now', city] as const,
  hours: (userKey: string | null, kind: string, city: string) => ['weather', userKey, kind, 'hours', city] as const,
}

export interface WeatherLoad<T> {
  status: 'loading' | 'success' | 'error' | 'forbidden'
  data: T | null
  /** error / forbidden 时给页面显示的文案 */
  text: string | null
  /** 重新请求；成功返回 true，失败返回 false，不抛 */
  refetch: () => Promise<boolean>
}

// 选择变化时通知所有用到 useWeatherCity 的组件（城市选择器和天气卡可以各自调用，拿到同一个城市）
let version = 0
const subs = new Set<() => void>()
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
const getVersion = () => version

/** 当前账号的天气城市；setCity 记住选择（编码不在城市文件里或未登录时不生效，返回 false） */
export function useWeatherCity(): { city: City; setCity: (code: string) => boolean } {
  const { userKey } = useSession()
  const v = useSyncExternalStore(subscribe, getVersion, getVersion)
  const city = useMemo(() => { void v; return readCity(userKey) }, [userKey, v])
  const setCity = useCallback((code: string) => {
    const ok = writeCity(userKey, code)
    if (ok) { version++; for (const fn of subs) fn() }
    return ok
  }, [userKey])
  return { city, setCity }
}

const noop = () => Promise.resolve(false)

function useWeatherQuery<T>(route: '/v1/weather' | '/v1/weather24', which: 'now' | 'hours', city: City, fetch: (q: string, signal: AbortSignal) => Promise<T>): WeatherLoad<T> {
  const { userKey, authed } = useSession()
  const src = weatherSource()
  const permitted = can(route)
  const q = weatherQueryOf(city)
  const query = useQuery({
    queryKey: weatherKeys[which](userKey, src.kind, q),
    queryFn: ({ signal }) => fetch(q, signal),
    // 会话视图可能先是 authed、账号键还没到（userKey 为 null）：这时不请求，免得先按默认城市、不带账号的键多发一次
    enabled: authed && !!userKey && permitted,
    staleTime: src.kind === 'real' ? WEATHER_STALE_MS : Infinity,
  })
  const qRefetch = query.refetch
  const refetch = useCallback(() => qRefetch().then((r) => !r.isError && r.data !== undefined, () => false), [qRefetch])
  if (!permitted) return { status: authed ? 'forbidden' : 'loading', data: null, text: authed ? WEATHER_FORBIDDEN_TEXT : null, refetch: noop }
  if (query.data !== undefined) return { status: 'success', data: query.data, text: null, refetch }
  if (query.isError) return { status: 'error', data: null, text: NO_WEATHER_TEXT, refetch }
  return { status: 'loading', data: null, text: null, refetch }
}

/** /weather：实时 + 7 天 */
export function useWeatherNow(city: City): WeatherLoad<WeatherNowView> {
  return useWeatherQuery('/v1/weather', 'now', city, (q, signal) => weatherSource().now(q, signal))
}
/** /weather24：24 小时 */
export function useWeather24(city: City): WeatherLoad<Weather24View> {
  return useWeatherQuery('/v1/weather24', 'hours', city, (q, signal) => weatherSource().hours(q, signal))
}
