// 纯函数：后端实体 → 视图模型、组织范围的拼装、当前项目与默认经销商的取值规则。不依赖 React，单测直接覆盖。
import type { DistributorEntity, IntegratedProjectEntity, ProjectEntity } from '../../api/pcfg'
import { toAppCode } from './capabilities'
import type { Dealer, Group, Project, Scope } from './types'

/** 在线判定：后端只在 true 时输出 online，缺失（或任何非 true 的值）都按离线 */
export const isOnlineEntity = (e: { online?: unknown }) => e.online === true

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const count = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }

export function toProject(e: ProjectEntity): Project {
  return {
    id: e.id,
    code: str(e.code),
    name: str(e.name),
    groupId: '',
    city: '',
    district: '',
    kind: str(e.app_category_name),
    online: isOnlineEntity(e),
    version: str(e.app_version),
    devices: count(e.brief_stat?.device_count),
    programCode: toAppCode(e.app_code),
    appName: str(e.app_name),
    region: str(e.customer_region),
    distributorId: str(e.distributor_id),
    distributorName: e.distributor_name,
    controlScreenId: e.control_screen_id,
    dtuId: e.dtu_id,
  }
}

export function toGroup(e: IntegratedProjectEntity): Group {
  return {
    id: e.id,
    code: str(e.code),
    dealerId: str(e.distributor_id),
    name: str(e.name),
    type: '',
    typeColor: 'cyan',
    desc: str(e.desc),
    created: str(e.created_at),
    appId: e.app_id,
    projectIds: Array.isArray(e.project_ids) ? [...new Set(e.project_ids.map(String))] : [],
    online: isOnlineEntity(e),
  }
}

export function toDealer(e: DistributorEntity): Dealer {
  const name = str(e.name)
  return { id: e.id, name, short: str(e.abbreviation) || name, region: str(e.region), code: e.code }
}

/** 某个集成项目里的项目（按 Group.projectIds 判断，保持 projects 的原有顺序） */
export function projectsInGroup(group: Pick<Group, 'projectIds'> | undefined, projects: readonly Project[]): Project[] {
  if (!group) return []
  const ids = new Set(group.projectIds)
  return projects.filter((p) => ids.has(p.id))
}

/** 若干集成项目里的项目（去重，保持 projects 的原有顺序） */
export function projectsInGroups(groups: readonly Pick<Group, 'projectIds'>[], projects: readonly Project[]): Project[] {
  const ids = new Set(groups.flatMap((g) => g.projectIds))
  return projects.filter((p) => ids.has(p.id))
}

/**
 * 当前账号可见的组织范围：集成项目里的项目（顺序沿用项目列表），groupId 设为第一个包含它的集成项目。
 * 经销商账号不调 /distributors（没有经销商选择器），dealers 由集成项目的 distributor_id 归纳出来，
 * 只用于侧栏分组（名称为空，经销商账号的侧栏不显示经销商名）。
 */
export function joinScope(dealers: readonly Dealer[], groups: readonly Group[], projects: readonly Project[], opts: { dealerAccount: boolean }): Scope {
  const firstGroup = new Map<string, string>()
  for (const g of groups) for (const id of g.projectIds) if (!firstGroup.has(id)) firstGroup.set(id, g.id)
  const visible = projects.filter((p) => firstGroup.has(p.id)).map((p) => {
    const gid = firstGroup.get(p.id)!
    return p.groupId === gid ? p : { ...p, groupId: gid }
  })
  let ds = [...dealers]
  if (opts.dealerAccount && ds.length === 0) {
    const ids = [...new Set(groups.map((g) => g.dealerId))]
    ds = ids.map((id) => ({ id, name: '', short: '', region: '' }))
  }
  return { dealers: ds, groups: [...groups], projects: visible }
}

/**
 * 当前项目：存储的 ID 在可见项目里就用它；否则（失效、换了账号、从没选过）回退到第一个可见项目；
 * 没有可见项目（加载中、无数据）为 null。回退不改写存储：项目列表恢复后仍回到原来的选择。
 */
export function resolveCurrentProject(projects: readonly Project[], storedId: string | null | undefined): Project | null {
  return (storedId ? projects.find((p) => p.id === storedId) : undefined) ?? projects[0] ?? null
}

/**
 * 经销商选择的有效值：用户选过且仍在列表里就用它，否则用列表第一个；列表为空为 ''。
 * 用派生值而不是 useState 初值，经销商列表异步到达时自然取到默认值（修 Groups.tsx 只在初始化取一次的坑）。
 */
export function resolveDealerId(dealers: readonly Pick<Dealer, 'id'>[], picked: string | null | undefined): string {
  return (picked && dealers.some((d) => d.id === picked) ? picked : dealers[0]?.id) ?? ''
}
