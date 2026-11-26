// 纯函数：后端实体 → 视图模型、组织范围的拼装、当前项目与默认经销商的取值规则。不依赖 React，单测直接覆盖。
import type { DistributorEntity, IntegratedProjectEntity, ProjectEntity } from '../../api/pcfg'
import { toAppCode } from './capabilities'
import { regionText, type RegionNames } from '../region/text'
import type { Dealer, Group, Project, Scope } from './types'

/**
 * 平台账号下没有 distributor_id 的集成项目（平台创建的）归到这个虚拟经销商「平台」，
 * 侧栏分组、经销商选择都能看到它们。按它取集成项目时不传 distributor_id，前端过滤。
 * 命名空间：后端 id 是 24 位十六进制 ObjectId，不会含冒号；哨兵带「virtual:」前缀，与后端 id 不可能相同。
 * 万一后端真的返回了等于哨兵的 id（数据异常），toDealer 丢弃该经销商、toGroup 把它标成不可达的
 * 「invalid:」归属并告警，不会被当成平台分组或误走「取全部再过滤」的分支。
 */
export const PLATFORM_DEALER_ID = 'virtual:platform'
const COLLIDED = 'invalid:'
const warnCollision = (what: string) => console.warn(`[org] 后端返回的${what} id 与虚拟经销商哨兵相同，已忽略`)
export const PLATFORM_DEALER: Dealer = Object.freeze({ id: PLATFORM_DEALER_ID, name: '平台', short: '平台', region: '' })

/** 在线判定：后端只在 true 时输出 online，缺失（或任何非 true 的值）都按离线 */
export const isOnlineEntity = (e: { online?: unknown }) => e.online === true

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const count = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }

/** names：行政区划名称表（src/data/region，按需加载）；不传或加载失败时区域显示原码 */
export function toProject(e: ProjectEntity, names: RegionNames | null = null): Project {
  return {
    id: e.id,
    code: str(e.code),
    name: str(e.name),
    groupId: '',
    city: '',
    district: '',
    area: regionText(e.customer_region, names),
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

function groupDealerId(d: string): string {
  if (!d) return PLATFORM_DEALER_ID
  if (d === PLATFORM_DEALER_ID) { warnCollision('集成项目的 distributor_'); return COLLIDED + d }
  return d
}

export function toGroup(e: IntegratedProjectEntity): Group {
  return {
    id: e.id,
    code: str(e.code),
    dealerId: groupDealerId(str(e.distributor_id)),
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

/** 后端 id 与哨兵冲突时返回 null（调用方丢弃） */
export function toDealer(e: DistributorEntity): Dealer | null {
  if (e.id === PLATFORM_DEALER_ID) { warnCollision('经销商'); return null }
  const name = str(e.name)
  return { id: e.id, name, short: str(e.abbreviation) || name, region: str(e.region), code: e.code }
}

/** 经销商列表后面补上虚拟经销商「平台」（有没有归属经销商的集成项目时） */
export function withPlatformDealer<T extends readonly Dealer[]>(dealers: T, groups: readonly Pick<Group, 'dealerId'>[]): T | Dealer[] {
  if (!groups.some((g) => g.dealerId === PLATFORM_DEALER_ID) || dealers.some((d) => d.id === PLATFORM_DEALER_ID)) return dealers
  return [...dealers, PLATFORM_DEALER]
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
    ds = ids.map((id) => (id === PLATFORM_DEALER_ID ? PLATFORM_DEALER : { id, name: '', short: '', region: '' }))
  } else if (!opts.dealerAccount) ds = [...withPlatformDealer(ds, groups)]
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
