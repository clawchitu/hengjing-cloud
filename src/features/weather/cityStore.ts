// 用户选过的天气城市：存在 localStorage，键带账号维度（会话的 userKey），不同账号互不影响。
// 读取时校验结构和编码是否还在城市文件里，读不到、损坏、编码已不存在都回退默认城市（无锡）。
// 未登录（userKey 为 null）不读不写，一律默认城市。
import { defaultCity, findCity, type City } from './cities'

export const CITY_KEY_PREFIX = 'hjc-weather-city:'
export const cityKeyOf = (userKey: string) => CITY_KEY_PREFIX + userKey

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** 读取当前账号选过的城市；没有或无效时返回默认城市 */
export function readCity(userKey: string | null): City {
  if (!userKey) return defaultCity()
  try {
    const raw = storage()?.getItem(cityKeyOf(userKey))
    if (!raw) return defaultCity()
    const v = JSON.parse(raw) as { code?: unknown } | null
    return findCity(v && typeof v === 'object' ? v.code : undefined) ?? defaultCity()
  } catch { return defaultCity() }
}

/** 记住当前账号选的城市；编码不在城市文件里、未登录时不写，返回是否写入 */
export function writeCity(userKey: string | null, code: string): boolean {
  if (!userKey || !findCity(code)) return false
  try { storage()?.setItem(cityKeyOf(userKey), JSON.stringify({ code })); return true } catch { return false }
}
