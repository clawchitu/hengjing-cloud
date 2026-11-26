// 组织数据的两个数据源，接口相同，按运行时配置 dataSource 选择（src/api/config.ts）：
// - mock：演示数据（e2e 截图全走这里）。同步可得，hooks 把它作为 initialData，首屏就有数据，
//   与拆分前 store.tsx 同步算出 scope 的行为一致，截图零差异；
// - real：S4 的请求层（src/api/pcfg.ts），只读接口。
import { getApps, getCtrlProjects, getDistributors, getIntegratedProjects } from '../../api/pcfg'
import { isMockMode } from '../../api/config'
import { gatewayOf, scopeOf } from '../../api'
import { PLATFORM_DEALER_ID, toDealer, toGroup, toProject } from './map'
import { loadRegionNames, type RegionNames } from '../region'
import type { Dealer, Group, Project, User } from './types'

export interface OrgContext {
  user: User
  /** 经销商账号（/me type=1；演示数据 role=dealer） */
  dealerAccount: boolean
}

export interface ProjectFilter { onlyOnline?: boolean }

export interface OrgSource {
  /** 经销商选择器的列表（只给平台账号用） */
  dealers(ctx: OrgContext, signal?: AbortSignal): Promise<Dealer[]>
  /** 集成项目；dealerId 不传按账号范围全部返回 */
  groups(ctx: OrgContext, dealerId: string | undefined, signal?: AbortSignal): Promise<Group[]>
  /** 项目列表（含在线状态、app_code） */
  projects(ctx: OrgContext, filter: ProjectFilter, signal?: AbortSignal): Promise<Project[]>
  /** app_id → 应用名称 */
  apps(ctx: OrgContext, signal?: AbortSignal): Promise<Record<string, string>>
}

// ---------------------------------------------------------------------------
// mock：同步函数，结果按用户缓存，同一用户多次取到同一批对象

/** 演示数据的区域文字：「城市 区县」（真实数据的格式见 regionText） */
const mockArea = (p: { city?: string; district?: string }) => [p.city, p.district].filter(Boolean).join(' ')

const viewCache = new Map<string, { dealers: Dealer[]; groups: Group[]; projects: Project[] }>()
function mockView(user: User) {
  const key = user.username + '|' + user.role
  let v = viewCache.get(key)
  if (!v) {
    const s = scopeOf(user)
    // 演示项目没有控制屏编号，沿用演示版的网关编号（GW-xxxxx）作控制屏编号，连接状态页与离线横幅显示它
    const projects: Project[] = s.projects.map((p) => ({ ...p, code: p.id, area: mockArea(p), controlScreenId: gatewayOf(p.id) }))
    const groups: Group[] = s.groups.map((g) => ({ ...g, code: g.id, projectIds: s.projects.filter((p) => p.groupId === g.id).map((p) => p.id) }))
    v = withMockExtra(user, { dealers: s.dealers.map((d) => ({ ...d })), groups, projects })
    viewCache.set(key, v)
  }
  return v
}

/**
 * 只给 e2e 用（演示数据模式）：页面加载前在 window.__HJC_MOCK_ORG_EXTRA__ 放额外的经销商、集成项目、项目
 * （视图模型，原样追加），用来造大量项目或「同一项目属于两个经销商的集成项目」这类演示数据里没有的情况。
 * 按账号过滤：经销商账号只追加 dealerId 是它自己的集成项目（以及其中的项目）。没有设置时什么都不做
 */
interface MockExtra { dealers?: Dealer[]; groups?: Group[]; projects?: Project[] }
function withMockExtra(user: User, v: { dealers: Dealer[]; groups: Group[]; projects: Project[] }) {
  const x = (globalThis as { __HJC_MOCK_ORG_EXTRA__?: MockExtra }).__HJC_MOCK_ORG_EXTRA__
  if (!x) return v
  const mine = (g: Group) => user.role === 'admin' || g.dealerId === user.dealerId
  const groups = (x.groups ?? []).filter(mine)
  // 已有的集成项目也可以追加项目（同 id 的集成项目合并 projectIds）
  const merged = v.groups.map((g) => {
    const add = (x.groups ?? []).find((e) => e.id === g.id)
    return add ? { ...g, projectIds: [...new Set([...g.projectIds, ...add.projectIds])] } : g
  })
  const newGroups = groups.filter((g) => !v.groups.some((o) => o.id === g.id))
  const visible = new Set([...merged, ...newGroups].flatMap((g) => g.projectIds))
  const known = new Set(v.projects.map((p) => p.id))
  return {
    dealers: [...v.dealers, ...(user.role === 'admin' ? x.dealers ?? [] : [])],
    groups: [...merged, ...newGroups],
    // 只追加落在本账号可见集成项目里的项目（经销商账号看不到别家的额外项目）
    projects: [...v.projects, ...(x.projects ?? []).filter((p) => !known.has(p.id) && visible.has(p.id)).map((p) => ({ ...p, area: p.area ?? mockArea(p) }))],
  }
}

export const mockOrg = {
  dealers: (ctx: OrgContext): Dealer[] => mockView(ctx.user).dealers,
  groups: (ctx: OrgContext, dealerId?: string): Group[] => {
    const all = mockView(ctx.user).groups
    return dealerId ? all.filter((g) => g.dealerId === dealerId) : all
  },
  projects: (ctx: OrgContext, filter: ProjectFilter = {}): Project[] => {
    const all = mockView(ctx.user).projects
    return filter.onlyOnline ? all.filter((p) => p.online) : all
  },
  /** 演示数据的集成项目没有 app_id，类型名称直接写在 Group.type 里 */
  apps: (): Record<string, string> => ({}),
}

const mockSource: OrgSource = {
  dealers: async (ctx) => mockOrg.dealers(ctx),
  groups: async (ctx, dealerId) => mockOrg.groups(ctx, dealerId),
  projects: async (ctx, filter) => mockOrg.projects(ctx, filter),
  apps: async () => mockOrg.apps(),
}

// ---------------------------------------------------------------------------
// real

export const realSource: OrgSource = {
  dealers: async (_ctx, signal) => (await getDistributors({ signal })).map(toDealer).filter((d): d is Dealer => d !== null),
  groups: async (_ctx, dealerId, signal) => {
    // 虚拟经销商「平台」：取全部再过滤没有归属经销商的
    if (dealerId === PLATFORM_DEALER_ID) return (await getIntegratedProjects({}, { signal })).map(toGroup).filter((g) => g.dealerId === PLATFORM_DEALER_ID)
    return (await getIntegratedProjects({ distributorId: dealerId }, { signal })).map(toGroup)
  },
  projects: async (_ctx, filter, signal) => {
    // 区划名称表与项目列表并行加载；名称表加载失败不影响列表，区域列退回显示原码
    const [entities, names] = await Promise.all([
      getCtrlProjects({ onlyOnline: filter.onlyOnline }, { signal }),
      loadRegionNames().catch((): RegionNames | null => null),
    ])
    return entities.map((e) => toProject(e, names))
  },
  apps: async (_ctx, signal) => Object.fromEntries((await getApps({ signal })).filter((a) => a.id).map((a) => [a.id, a.name ?? ''])),
}

/** 当前配置的数据源（每次调用时读配置，测试里 setConfig() 切换即可） */
export const orgSource = (): OrgSource => (isMockMode() ? mockSource : realSource)
