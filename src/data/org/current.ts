// 当前项目的持久化：存 localStorage 的 hjc-project（与拆分前 store.tsx 的行为一致：启动时读一次，
// 切换项目时写入；回退到第一个项目时不改写）。另有 selectTick：每次切换上报完成后加一，常用项目据此刷新。
// 模块级外部存储，所有组件共享同一个值，不需要 Provider。
// 另记「切换被拒」的项目（键为 账号 + 项目 id）：refreshing 已在后台刷新组织范围；refreshed 刷新两份都成功了仍不在范围里。

export const PROJECT_KEY = 'hjc-project'

let stored: string | undefined // undefined：还没读过存储
let tick = 0
const subs = new Set<() => void>()
const emit = () => { for (const fn of subs) fn() }

function read(): string {
  try { return localStorage.getItem(PROJECT_KEY) || '' } catch { return '' }
}

export const getStoredProjectId = () => (stored === undefined ? (stored = read()) : stored)
export const getSelectTick = () => tick

export function setStoredProjectId(id: string) {
  stored = id
  try { localStorage.setItem(PROJECT_KEY, id) } catch { /* 存储不可用时只在内存里生效 */ }
  emit()
}

export function bumpSelectTick() {
  tick += 1
  emit()
}

export function subscribeCurrent(fn: () => void) {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

export type RejectState = 'refreshing' | 'refreshed'
const rejected = new Map<string, RejectState>()
export const getRejected = (k: string) => rejected.get(k)
export function setRejected(k: string, v: RejectState) {
  // 只是提示用的小表，防止无限增长
  if (!rejected.has(k) && rejected.size >= 200) rejected.delete(rejected.keys().next().value!)
  rejected.set(k, v)
}
export const forgetRejected = (k: string) => { rejected.delete(k) }

/** 仅供测试：重置模块内状态 */
export function __resetCurrentForTests() {
  stored = undefined
  tick = 0
  subs.clear()
  rejected.clear()
}
