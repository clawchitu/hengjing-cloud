// 统一控制（S12b）接入公共写锁（src/api/writeLock.ts，#28）。
//
// - 应用初始化（AppProvider）调 setupUnifiedWriteLock：先 configureWriteLock({ resolveProject })，再 registerVerifier(203, …)。
//   resolveProject 是 S6a 组织范围的同步查询：从 QueryClient 缓存里取当前账号的集成项目与项目列表（同 useOrgScope 的 joinScope
//   口径：项目要在某个集成项目里才算可见），按 id 找回项目；缓存里还没有就按不可见（不读）。
// - 203 核对：200 里只有房间级的开关（switch）与设定温度（set_temp），只核对这两项。这次改了系统开关或运行模式的无法核对
//   （记为未核对），核对器一律返回不一致，锁等有效期（2 分钟）到期后释放并发出强制重读。
// - 刷新恢复的锁：注册核对器时组织数据多半还没加载（按不可见跳过）。集成项目列表、项目列表任一加载成功（含演示数据写入缓存）时，
//   对 localStorage 里恢复来的、结果未知的锁，按 resolveProject 能不能解析出项目决定要不要再核对一次（两份数据谁先到都行）。
import type { QueryClient } from '@tanstack/react-query'
import { configureWriteLock, lockKeysOf, lockOf, parseStored, registerVerifier, STORAGE_PREFIX, verify, type LockTarget, type Scalar, type SentRecord } from '@/api/writeLock'
import type { WriteQuery } from '@/api/ctrl'
import { orgKeys } from '@/data/org/hooks'
import { getSessionView } from '@/data/session'
import type { Group, Project } from '@/data/org/types'
import type { UnifiedSnapshot } from './batch'

/** 同一块控制屏（或 DTU、项目）上一条下发还没有结论 */
export const LOCK_BUSY_TEXT = '上一条下发还在处理中'
/** 改了系统开关 / 运行模式：200 里没有读数，无法核对 */
export const LOCK_UNVERIFIABLE_TEXT = '系统开关、运行模式无法回读核对（未核对），锁到期后自动释放'

/** 加锁目标：控制屏号、DTU 号、项目 id */
export const lockTargetOf = (p: { id: string; controlScreenId?: string; dtuId?: string }): LockTarget => ({ id: p.id, controlScreenId: p.controlScreenId, dtuId: p.dtuId })

/** 203 下发的核对数据（落盘）：四个字段原样记下，核对时只比房间开关与设定温度 */
export function recordOf(q: WriteQuery<203>): SentRecord {
  const target: Record<string, Scalar> = { systemSwitch: q.systemSwitch, systemMode: q.systemMode, roomSwitch: q.roomSwitch, roomTemp: q.roomTemp }
  return { msg: 203, deviceId: null, target }
}

/** 这次下发能不能回读核对：没改系统开关 / 运行模式，并且改了房间开关或温度 */
export function verifiable203(t: { [k: string]: Scalar }): boolean {
  if (t.systemSwitch !== -1 || t.systemMode !== 0) return false
  return t.roomSwitch !== -1 || t.roomTemp !== -1
}

/** 温度按 0.01 容差比较（与状态机的逐字段核对 rules.ts echoMismatches 同一口径，float32） */
const TEMP_EPS = 0.01

/** 203 核对：回读快照里房间开关、设定温度（全部房间一致）都等于目标才算一致；无法核对的一律不一致 */
export function match203(t: { [k: string]: Scalar }, snap: UnifiedSnapshot): boolean {
  if (!verifiable203(t) || !snap || snap.rooms <= 0) return false
  if (t.roomSwitch !== -1 && snap.roomSwitch !== t.roomSwitch) return false
  if (t.roomTemp !== -1 && (typeof t.roomTemp !== 'number' || snap.roomTemp == null || Math.abs(snap.roomTemp - t.roomTemp) >= TEMP_EPS)) return false
  return true
}

/** S6a 组织范围的同步查询：当前账号可见的项目里按 id 找（只读缓存，不发请求） */
export type SessionOf = () => { authed: boolean; userKey: string | null }
export function resolveOrgProject(qc: QueryClient, projectId: string, session: SessionOf = getSessionView): LockTarget | null {
  const { userKey, authed } = session()
  if (!authed) return null
  const groups = qc.getQueryData<Group[]>(orgKeys.groups(userKey, null))
  const projects = qc.getQueryData<Project[]>(orgKeys.projects(userKey, {}))
  if (!groups || !projects) return null
  if (!groups.some((g) => g.projectIds.includes(projectId))) return null
  const p = projects.find((x) => x.id === projectId)
  return p ? lockTargetOf(p) : null
}

const wired = new WeakSet<QueryClient>()

/**
 * 应用初始化：注入 resolveProject、注册 203 核对器、项目列表加载成功后补核对恢复的锁。同一个 QueryClient 只接一次。
 * read：回读 200 整理成快照（真实接口用 readUnifiedSnapshot，演示数据用 mockUnifiedRead）
 */
export function setupUnifiedWriteLock(qc: QueryClient, read: (projectId: string, signal: AbortSignal) => Promise<UnifiedSnapshot>, session: SessionOf = getSessionView): void {
  if (wired.has(qc)) return
  wired.add(qc)
  const resolve = (id: string) => resolveOrgProject(qc, id, session)
  configureWriteLock({ resolveProject: resolve })
  // 先判断能不能核对（改了系统开关 / 运行模式的直接不一致），能核对才回读
  registerVerifier(203, async (rec, signal) => verifiable203(rec.target) && match203(rec.target, await read(rec.projectId, signal)))
  qc.getQueryCache().subscribe((ev) => {
    const k = ev.query.queryKey
    if (k[0] !== 'org' || (k[2] !== 'projects' && k[2] !== 'groups')) return
    const loaded = (ev.type === 'updated' && ev.action.type === 'success') || (ev.type === 'added' && ev.query.state.data !== undefined)
    // added 可能在渲染期间同步发出（QueryObserver 在 useState 初始化里建）：放到微任务里，不在渲染中触发锁的 emit
    if (loaded) queueMicrotask(() => verifyRestored(resolve))
  })
  verifyRestored(resolve)
}

/** 本标签页从 localStorage 恢复来的、结果未知的锁：resolveProject 能解析出项目才核对 */
function verifyRestored(resolve: (id: string) => LockTarget | null) {
  let s: Storage
  try { if (typeof localStorage === 'undefined') return; s = localStorage } catch { return }
  const keys: string[] = []
  try { for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(STORAGE_PREFIX)) keys.push(k.slice(STORAGE_PREFIX.length)) } } catch { return }
  for (const key of keys) {
    const l = lockOf(key)
    if (!l || l.origin !== 'restored' || l.phase !== 'unknown' || l.verifying) continue
    const rec = parseStored(s.getItem(STORAGE_PREFIX + key))
    if (rec && resolve(rec.projectId)) void verify(key)
  }
}

/** 强制重读事件是否和这些项目有关 */
export const rereadHits = (ev: { keys: readonly string[]; projectId: string }, projects: ReadonlyArray<{ id: string; controlScreenId?: string; dtuId?: string }>) =>
  projects.some((p) => p.id === ev.projectId || lockKeysOf(lockTargetOf(p)).some((k) => ev.keys.includes(k)))
