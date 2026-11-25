// 当前项目的持久化：存 localStorage 的 hjc-project（与拆分前 store.tsx 的行为一致：启动时读一次，
// 切换项目时写入；回退到第一个项目时不改写）。另有 selectTick：每次切换上报完成后加一，常用项目据此刷新。
// 模块级外部存储，所有组件共享同一个值，不需要 Provider。
// 另记「切换被拒」的项目（键为 账号 + 项目 id）：refreshing 已在后台刷新组织范围；refreshed 刷新两份都成功了仍不在范围里。

export const PROJECT_KEY = 'hjc-project'
/** 记下 hjc-project 是哪个账号（session userKey）选的（S13 走查 P7：同一浏览器换账号不沿用上一个账号的当前项目） */
export const PROJECT_OWNER_KEY = 'hjc-project-owner'

let stored: string | undefined // undefined：还没读过存储
let owner: string | null | undefined // undefined：还没读过存储；null：没记账号（旧数据）
let tick = 0
const subs = new Set<() => void>()
const emit = () => { for (const fn of subs) fn() }

function read(): string {
  try { return localStorage.getItem(PROJECT_KEY) || '' } catch { return '' }
}

function readOwner(): string | null {
  try { return localStorage.getItem(PROJECT_OWNER_KEY) || null } catch { return null }
}

export const getStoredProjectId = () => (stored === undefined ? (stored = read()) : stored)
const getOwner = () => (owner === undefined ? (owner = readOwner()) : owner)
/**
 * 某个账号的当前项目：存的项目是别的账号选的 → ''（解析时回退到这个账号的第一个可见项目，不改写存储）。
 * 没记账号的旧数据、账号未知时照旧返回存的值（升级后同一个账号不丢上次的项目）
 */
export const getStoredProjectIdFor = (userKey: string | null | undefined) => {
  const id = getStoredProjectId()
  const o = getOwner()
  return !userKey || !o || o === userKey ? id : ''
}
export const getSelectTick = () => tick

/** userKey：选这个项目的账号，一起记下（不传就不改账号记录） */
export function setStoredProjectId(id: string, userKey?: string | null) {
  stored = id
  try { localStorage.setItem(PROJECT_KEY, id) } catch { /* 存储不可用时只在内存里生效 */ }
  if (userKey) {
    owner = userKey
    try { localStorage.setItem(PROJECT_OWNER_KEY, userKey) } catch { /* 同上 */ }
  }
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
/** 「刷新后仍不在范围」的结论只保留这么久，过期后再选会重新刷新一次（例如期间被授予了权限） */
export const REJECT_TTL_MS = 60_000
const rejected = new Map<string, { state: RejectState; at: number }>()
export function getRejected(k: string): RejectState | undefined {
  const r = rejected.get(k)
  if (r && r.state === 'refreshed' && Date.now() - r.at > REJECT_TTL_MS) { rejected.delete(k); return undefined }
  return r?.state
}
export function setRejected(k: string, v: RejectState) {
  // 只是提示用的小表，防止无限增长
  if (!rejected.has(k) && rejected.size >= 200) rejected.delete(rejected.keys().next().value!)
  rejected.set(k, { state: v, at: Date.now() })
}
export const forgetRejected = (k: string) => { rejected.delete(k) }

let scopeSig: string | undefined
/**
 * 组织范围（账号、集成项目归属、项目列表）变了就清掉全部「被拒」记录：之前的结论可能已不成立。
 * 传入范围签名（不含在线状态），与上次不同才清，同一份数据在多个组件里重复上报不会误清
 */
export function noteScope(sig: string) {
  if (scopeSig !== undefined && scopeSig !== sig) rejected.clear()
  scopeSig = sig
}

/** 仅供测试：重置模块内状态 */
export function __resetCurrentForTests() {
  stored = undefined
  owner = undefined
  tick = 0
  subs.clear()
  rejected.clear()
  scopeSig = undefined
}
