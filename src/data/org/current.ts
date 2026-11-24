// 当前项目的持久化：存 localStorage 的 hjc-project（与拆分前 store.tsx 的行为一致：启动时读一次，
// 切换项目时写入；回退到第一个项目时不改写）。另有 selectTick：每次切换上报完成后加一，常用项目据此刷新。
// 模块级外部存储，所有组件共享同一个值，不需要 Provider。

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

/** 仅供测试：重置模块内状态 */
export function __resetCurrentForTests() {
  stored = undefined
  tick = 0
  subs.clear()
}
