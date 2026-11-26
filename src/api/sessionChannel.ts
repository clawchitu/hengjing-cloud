// 各标签页之间同步登录态的 BroadcastChannel（令牌存 sessionStorage，各标签页互不可见，只能靠它互通）。
// 每个标签页只开一个频道对象（BroadcastChannel 不会把消息发回同一个对象），收发都经这里。
// 消息：
// - rotated：某个标签页续期成功，旧 refresh_token → 新令牌（http.ts 发，session.ts 收）；
// - ask / give：新开的标签页没有令牌，向已登录的标签页要（session.ts）；
// - login：某个标签页登录成功（session.ts）；
// - logout：某个标签页主动退出或无操作超时（reason: 'idle'），所有标签页一起退出（session.ts）。
// 频道只在同源页面之间可见；令牌本来就在同源可读的 sessionStorage 里，经频道传递不扩大暴露面。
import type { Tokens } from './tokens'

export const SESSION_CHANNEL = 'hjc-session'

export type SessionMessage =
  | { type: 'rotated'; from: string; to: Tokens }
  | { type: 'ask'; id: string }
  | { type: 'give'; id: string; tokens: Tokens }
  | { type: 'login'; to: Tokens }
  | { type: 'logout'; reason?: 'idle' }

let channel: BroadcastChannel | null | undefined
const handlers = new Set<(m: SessionMessage) => void>()

function open(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SESSION_CHANNEL) : null
  channel?.addEventListener('message', (e: MessageEvent<unknown>) => {
    const m = e.data as SessionMessage | null
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return
    for (const fn of handlers) fn(m)
  })
  return channel
}

/** 当前环境有没有跨标签页频道（没有 BroadcastChannel 的旧浏览器、node 脚本为 false） */
export const hasSessionChannel = () => open() !== null

export function postSession(m: SessionMessage) {
  try { open()?.postMessage(m) } catch { /* 频道已关（测试重置）或消息无法克隆：本页照常 */ }
}

/** 订阅别的标签页发来的消息，返回撤销函数 */
export function onSessionMessage(fn: (m: SessionMessage) => void): () => void {
  open()
  handlers.add(fn)
  return () => { handlers.delete(fn) }
}

/** 仅供测试：关掉频道（下次使用时重开），清空订阅 */
export function __resetSessionChannelForTests() {
  channel?.close()
  channel = undefined
  handlers.clear()
}
