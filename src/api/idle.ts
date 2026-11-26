// 无操作超时：连续 idleTimeoutHours（config.js，默认 8 小时）没有任何用户操作，就要重新登录。
// 用来堵 Chrome「继续浏览上次打开的网页」的口子：它会连 sessionStorage 一起恢复，关浏览器再打开不用登录。
//
// - 「操作」只算用户的真实交互：pointerdown、keydown、wheel、touchstart（ACTIVITY_EVENTS），每个标签页每分钟最多记一次。
//   后台轮询、定时续期、页面可见性变化都不算。
// - 最后操作时间存 localStorage 的 hjc-last-activity（只是一个毫秒时间戳，不敏感），所有标签页共享：
//   任何一个标签页有操作都算数。
// - 判断时机（session.ts、http.ts）：启动和恢复时、运行中每分钟、切回标签页和网络恢复时、每次续期前、记录操作前。
// - 判超时：now − lastActivity > 时长；或者 lastActivity 缺失、早于本次登录时间（Tokens.loginAt）。
import { getConfig } from './config'
import type { Tokens } from './tokens'

export const ACTIVITY_KEY = 'hjc-last-activity'
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
/** 同一个标签页记录操作的最小间隔 */
export const ACTIVITY_THROTTLE_MS = 60_000
/** 运行中检查的间隔 */
export const IDLE_CHECK_MS = 60_000
export const IDLE_LOGOUT_TEXT = '长时间未操作，请重新登录'

const HOUR = 3600_000
export const idleTimeoutMs = () => getConfig().idleTimeoutHours * HOUR

const store = (): Storage | null => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}
let memory: number | null = null // 没有 Web Storage 的环境（node 脚本）

/** 存储值和本页内存值里较新的那个：写不进存储（配额满等）时，本页的操作仍然算数 */
export function readLastActivity(): number | null {
  const s = store()
  let stored: number | null = null
  try {
    const raw = s?.getItem(ACTIVITY_KEY) ?? null
    const n = raw === null ? NaN : Number(raw)
    stored = Number.isFinite(n) && n > 0 ? n : null
  } catch { /* 读不了存储：只看内存值 */ }
  if (stored === null) return memory
  return memory === null ? stored : Math.max(stored, memory)
}

let lastWrite = -Infinity
/** 写入最后操作时间（不节流）。登录成功时调用 */
export function writeLastActivity(now = Date.now()) {
  lastWrite = now
  memory = now
  try { store()?.setItem(ACTIVITY_KEY, String(now)) } catch { /* 存储不可用：本页按内存值 */ }
}

/** 用户操作：每个标签页每 ACTIVITY_THROTTLE_MS 最多写一次 */
export function recordActivity(now = Date.now()) {
  if (now - lastWrite < ACTIVITY_THROTTLE_MS) return
  writeLastActivity(now)
}

/** 有令牌时是否已超时（没有令牌返回 false：没有会话可退） */
export function isIdleExpired(t: Tokens | null, now = Date.now()): boolean {
  if (!t) return false
  const last = readLastActivity()
  if (last === null) return true
  if (typeof t.loginAt === 'number' && last < t.loginAt) return true
  return now - last > idleTimeoutMs()
}

// 超时后的退出由 session.ts 处理（清令牌、invalidate、广播、回登录页）；http.ts 续期前发现超时只通知这里
const handlers = new Set<() => void>()
export function onIdleExpired(fn: () => void): () => void {
  handlers.add(fn)
  return () => { handlers.delete(fn) }
}
/** 通知已超时。返回是否有人处理（没有订阅时调用方自己清登录态） */
export function notifyIdleExpired(): boolean {
  for (const fn of handlers) fn()
  return handlers.size > 0
}

/** 仅供测试：重置模块内状态 */
export function __resetIdleForTests() {
  lastWrite = -Infinity
  memory = null
  handlers.clear()
}
