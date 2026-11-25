// 当前项目的持久化：存 localStorage 的 hjc-project（与拆分前 store.tsx 的行为一致：启动时读一次，
// 切换项目时写入；回退到第一个项目时不改写）。另有 selectTick：每次切换上报完成后加一，常用项目据此刷新。
// 模块级外部存储，所有组件共享同一个值，不需要 Provider。
// 另记「切换被拒」的项目（键为 账号 + 项目 id）：refreshing 已在后台刷新组织范围；refreshed 刷新两份都成功了仍不在范围里。

export const PROJECT_KEY = 'hjc-project'
/** 记下 hjc-project 是哪个账号（session userKey）选的（S13 走查 P7：同一浏览器换账号不沿用上一个账号的当前项目） */
export const PROJECT_OWNER_KEY = 'hjc-project-owner'
/** 每个账号自己的当前项目：hjc-project:<userKey>（A 选、B 选、A 再登录，A 仍是自己选的） */
export const projectKeyOf = (userKey: string) => `${PROJECT_KEY}:${userKey}`

let stored: string | undefined // undefined：还没读过存储
let owner: string | null | undefined // undefined：还没读过存储；null：没记账号（旧数据）
const perUser = new Map<string, string | null>() // 账号 → 它自己的当前项目；null：没存过
let tick = 0
const subs = new Set<() => void>()
const emit = () => { for (const fn of subs) fn() }

const load = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const save = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 存储不可用时只在内存里生效 */ } }

function read(): string {
  return load(PROJECT_KEY) || ''
}

function readOwner(): string | null {
  return load(PROJECT_OWNER_KEY) || null
}

export const getStoredProjectId = () => (stored === undefined ? (stored = read()) : stored)
const getOwner = () => (owner === undefined ? (owner = readOwner()) : owner)
const getPerUser = (u: string) => {
  if (!perUser.has(u)) perUser.set(u, load(projectKeyOf(u)) || null)
  return perUser.get(u)!
}

/**
 * 某个账号的当前项目（解析时不在范围里就回退到这个账号的第一个可见项目）：
 * - 这个账号自己存过（hjc-project:<userKey>）→ 用它；
 * - 没存过，最近一次选择（hjc-project）是它自己选的 → 用它；
 * - 升级前没记账号的旧数据 → 归第一个读到它的账号（记下账号，之后别的账号不再沿用），同一个账号升级后不丢上次的项目；
 * - 是别的账号选的 → ''。
 * 账号未知时照旧返回最近一次选择
 */
export const getStoredProjectIdFor = (userKey: string | null | undefined) => {
  const id = getStoredProjectId()
  if (!userKey) return id
  const mine = getPerUser(userKey)
  if (mine !== null) return mine
  const o = getOwner()
  if (o === userKey) return id
  if (o === null && id) {
    owner = userKey
    save(PROJECT_OWNER_KEY, userKey)
    perUser.set(userKey, id)
    save(projectKeyOf(userKey), id)
    return id
  }
  return ''
}
export const getSelectTick = () => tick

/** userKey：选这个项目的账号，一起记下（不传就不改账号记录，算作记录里那个账号的选择） */
export function setStoredProjectId(id: string, userKey?: string | null) {
  stored = id
  save(PROJECT_KEY, id)
  // 不传账号时算作记录里那个账号的选择（账号记录不变）
  const u = userKey || getOwner()
  if (userKey) {
    owner = userKey
    save(PROJECT_OWNER_KEY, userKey)
  }
  if (u) {
    perUser.set(u, id)
    save(projectKeyOf(u), id)
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
  perUser.clear()
  tick = 0
  subs.clear()
  rejected.clear()
  scopeSig = undefined
}
