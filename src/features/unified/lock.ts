// 统一控制（S12b）接入公共写锁（src/api/writeLock.ts，#28）。
//
// - 应用初始化（AppProvider）调 setupUnifiedWriteLock：先 configureWriteLock({ resolveProject })，再 registerVerifier(203, …)。
//   resolveProject 是 S6a 组织范围的同步查询：从 QueryClient 缓存里取当前账号的集成项目与项目列表（同 useOrgScope 的 joinScope
//   口径：项目要在某个集成项目里才算可见），按 id 找回项目；缓存里还没有就按不可见（不读）。
// - 203 核对：200 里只有房间级的开关（switch）与设定温度（set_temp），只核对这两项。这次改了系统开关或运行模式的无法核对
//   （记为未核对），核对器一律返回不一致，锁等有效期（2 分钟）到期后释放并发出强制重读。
// - 刷新恢复的锁：注册核对器时组织数据多半还没加载（按不可见跳过）；项目列表加载成功后，对恢复来的结果未知锁再核对一次。
import type { QueryClient } from '@tanstack/react-query'
import { configureWriteLock, lockKeysOf, lockOf, registerVerifier, verify, type LockTarget, type Scalar, type SentRecord } from '@/api/writeLock'
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

/** 203 核对：回读快照里房间开关、设定温度（全部房间一致）都等于目标才算一致；无法核对的一律不一致 */
export function match203(t: { [k: string]: Scalar }, snap: UnifiedSnapshot): boolean {
  if (!verifiable203(t) || !snap || snap.rooms <= 0) return false
  if (t.roomSwitch !== -1 && snap.roomSwitch !== t.roomSwitch) return false
  if (t.roomTemp !== -1 && (typeof t.roomTemp !== 'number' || snap.roomTemp == null || Math.abs(snap.roomTemp - t.roomTemp) >= 0.05)) return false
  return true
}

/** S6a 组织范围的同步查询：当前账号可见的项目里按 id 找（只读缓存，不发请求） */
export function resolveOrgProject(qc: QueryClient, projectId: string): LockTarget | null {
  const { userKey, authed } = getSessionView()
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
export function setupUnifiedWriteLock(qc: QueryClient, read: (projectId: string, signal: AbortSignal) => Promise<UnifiedSnapshot>): void {
  if (wired.has(qc)) return
  wired.add(qc)
  configureWriteLock({ resolveProject: (id) => resolveOrgProject(qc, id) })
  registerVerifier(203, async (rec, signal) => match203(rec.target, await read(rec.projectId, signal)))
  qc.getQueryCache().subscribe((ev) => {
    const k = ev.query.queryKey
    if (ev.type !== 'updated' || ev.action.type !== 'success' || k[0] !== 'org' || k[2] !== 'projects') return
    for (const p of (ev.query.state.data as Project[] | undefined) ?? []) {
      const l = lockOf(lockTargetOf(p))
      if (l && l.origin === 'restored' && l.phase === 'unknown' && !l.verifying) void verify(l.key)
    }
  })
}

/** 强制重读事件是否和这些项目有关 */
export const rereadHits = (ev: { keys: readonly string[]; projectId: string }, projects: ReadonlyArray<{ id: string; controlScreenId?: string; dtuId?: string }>) =>
  projects.some((p) => p.id === ev.projectId || lockKeysOf(lockTargetOf(p)).some((k) => ev.keys.includes(k)))
