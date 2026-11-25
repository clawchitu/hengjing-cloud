// 侧栏项目切换器的两份按账号记录（只存在浏览器本地，不上报后端）：
// - 最近使用：hjc-recent-projects:<userKey>，切换当前项目成功时把它放到最前（useCurrentProject().setProjectId 里记）；
// - 已置顶：hjc-pinned-projects:<userKey>，切换器每行的星标切换。不另做「收藏」。
// 模块级外部存储（同 current.ts），useSyncExternalStore 订阅；存储不可用时只在内存里生效。
import { useCallback, useSyncExternalStore } from 'react'

export const RECENT_KEY = 'hjc-recent-projects'
export const PINNED_KEY = 'hjc-pinned-projects'
/** 最近使用最多存这么多个（显示时再去掉不可见、已置顶的，取前 RECENT_SHOWN 个） */
export const RECENT_KEEP = 20
export const RECENT_SHOWN = 5
/** 置顶上限：防止存储无限增长 */
export const PINNED_KEEP = 200

const keyOf = (base: string, userKey: string) => `${base}:${userKey}`
const EMPTY: readonly string[] = Object.freeze([])

const cache = new Map<string, readonly string[]>()
const subs = new Set<() => void>()
const emit = () => { for (const fn of subs) fn() }

function load(k: string): readonly string[] {
  let raw: string | null = null
  try { raw = localStorage.getItem(k) } catch { /* 存储不可用 */ }
  if (!raw) return EMPTY
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return EMPTY
    return Object.freeze([...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))])
  } catch { return EMPTY }
}

function get(k: string): readonly string[] {
  let v = cache.get(k)
  if (!v) { v = load(k); cache.set(k, v) }
  return v
}

function put(k: string, v: readonly string[]) {
  const frozen = Object.freeze([...v])
  cache.set(k, frozen)
  try { localStorage.setItem(k, JSON.stringify(frozen)) } catch { /* 只在内存里生效 */ }
  emit()
}

export const getRecent = (userKey: string | null | undefined): readonly string[] => (userKey ? get(keyOf(RECENT_KEY, userKey)) : EMPTY)
export const getPinned = (userKey: string | null | undefined): readonly string[] => (userKey ? get(keyOf(PINNED_KEY, userKey)) : EMPTY)

/** 切换当前项目成功时调用：放到最前，去重 */
export function recordRecent(userKey: string | null | undefined, id: string) {
  if (!userKey || !id) return
  const k = keyOf(RECENT_KEY, userKey)
  const prev = get(k)
  if (prev[0] === id) return
  put(k, [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_KEEP))
}

/** 星标：已置顶就取消，否则置顶（新置顶的排在最前） */
export function togglePinned(userKey: string | null | undefined, id: string) {
  if (!userKey || !id) return
  const k = keyOf(PINNED_KEY, userKey)
  const prev = get(k)
  put(k, prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev].slice(0, PINNED_KEEP))
}

function subscribe(fn: () => void) {
  subs.add(fn)
  // 别的标签页改了记录：丢掉缓存重读
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(RECENT_KEY + ':') || e.key.startsWith(PINNED_KEY + ':')) { cache.clear(); fn() }
  }
  window.addEventListener('storage', onStorage)
  return () => { subs.delete(fn); window.removeEventListener('storage', onStorage) }
}

/** 当前账号的最近使用、已置顶（未登录为空） */
export function useProjectPrefs(userKey: string | null | undefined): { recent: readonly string[]; pinned: readonly string[] } {
  const r = useCallback(() => getRecent(userKey), [userKey])
  const p = useCallback(() => getPinned(userKey), [userKey])
  return { recent: useSyncExternalStore(subscribe, r, r), pinned: useSyncExternalStore(subscribe, p, p) }
}

/** 仅供测试：清掉内存缓存 */
export function __resetPrefsForTests() {
  cache.clear()
  subs.clear()
}
