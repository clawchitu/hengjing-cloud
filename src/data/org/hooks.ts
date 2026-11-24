// 组织数据 hooks（TanStack Query，沿用 S4 的 QueryClient 默认值：读请求网络/超时/服务器错误重试 1 次）。
// 查询键都以 ['org', userKey] 开头：按账号隔离缓存，退出时整体清掉（useResetOrgOnSignOut）。
// 每个 hook 返回 Loadable：data（加载中 / 失败时为空数组或上一次的数据）、status 三态、error、isEmpty。
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { reportProjectSelect } from '../../api'
import { isMockMode } from '../../api/config'
import { ApiError, isApiError } from '../../api/errors'
import { useSession } from '../session'
import { capabilitiesOf, type Capabilities } from './capabilities'
import { bumpSelectTick, getSelectTick, getStoredProjectId, setStoredProjectId, subscribeCurrent } from './current'
import { joinScope, resolveCurrentProject, resolveDealerId, withPlatformDealer } from './map'
import { mockOrg, orgSource, type OrgContext, type ProjectFilter } from './sources'
import type { Dealer, Group, LoadStatus, Project, Scope } from './types'

export interface Loadable<T> {
  data: T
  status: LoadStatus
  /** 只在 status=error（从没拿到过数据）时有 */
  error: ApiError | null
  /** 有旧数据时后台刷新失败的错误（status 仍为 success，页面可提示「数据可能已过期」） */
  staleError: ApiError | null
  /** 已成功加载且没有数据 */
  isEmpty: boolean
  refetch: () => void
}

/** 真实接口的组织数据 30 秒内视为新鲜（在线状态需要更及时的页面自己 refetch 或设轮询） */
const REAL_STALE_MS = 30_000
const NONE: never[] = []
const noop = () => {}

export const orgKeys = {
  all: ['org'] as const,
  user: (userKey: string | null) => ['org', userKey] as const,
  dealers: (userKey: string | null) => ['org', userKey, 'dealers'] as const,
  groups: (userKey: string | null, dealerId: string | null) => ['org', userKey, 'groups', dealerId] as const,
  projects: (userKey: string | null, filter: ProjectFilter) => ['org', userKey, 'projects', { onlyOnline: !!filter.onlyOnline }] as const,
  apps: (userKey: string | null) => ['org', userKey, 'apps'] as const,
}

const toApiError = (e: unknown): ApiError | null =>
  e == null ? null : isApiError(e) ? e : new ApiError('server', e instanceof Error ? e.message : '加载失败', { cause: e })

function useOrgCtx() {
  const s = useSession()
  const ctx = useMemo<OrgContext>(() => ({ user: s.user, dealerAccount: s.dealerAccount }), [s.user, s.dealerAccount])
  return { ctx, userKey: s.userKey, authed: s.authed }
}

/**
 * 公共查询包装。mock 模式把演示数据作为 initialData（首屏同步可得，永不过期）；real 模式正常请求。
 * enabled=false（如经销商账号不取经销商列表）时返回 fallback 且状态为 success；未登录时状态为 loading。
 */
function useOrgQuery<T>(
  key: readonly unknown[],
  fetcher: (ctx: OrgContext, signal: AbortSignal) => Promise<T>,
  mockData: (ctx: OrgContext) => T,
  fallback: T,
  enabled = true,
): Loadable<T> {
  const { ctx, authed } = useOrgCtx()
  const mock = isMockMode()
  const on = authed && enabled
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetcher(ctx, signal),
    enabled: on,
    ...(mock ? { initialData: () => mockData(ctx), staleTime: Infinity } : { staleTime: REAL_STALE_MS }),
  })
  const qRefetch = q.refetch
  const refetch = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!on) return { data: fallback, status: authed ? 'success' : 'loading', error: null, staleError: null, isEmpty: authed && isEmptyData(fallback), refetch: noop }
  const data = (q.data ?? fallback) as T
  // 有数据（含后台刷新失败时保留的旧数据）就是 success；只有从没拿到过数据时失败才报 error
  const status: LoadStatus = q.data !== undefined ? 'success' : q.isError ? 'error' : 'loading'
  const err = toApiError(q.error)
  return { data, status, error: status === 'error' ? err : null, staleError: status === 'success' && q.isError ? err : null, isEmpty: status === 'success' && isEmptyData(data), refetch }
}

const isEmptyData = (d: unknown) => (Array.isArray(d) ? d.length === 0 : d && typeof d === 'object' ? Object.keys(d).length === 0 : !d)

// ---------------------------------------------------------------------------
// 列表

/**
 * 经销商列表（经销商选择器用）。平台账号调 /distributors { has_integrated_project: true }；
 * 真实接口的经销商账号不显示选择器，不发请求，返回空列表。演示数据的经销商账号返回它自己（与拆分前一致）。
 */
export function useDealers(): Loadable<Dealer[]> {
  const { ctx, userKey } = useOrgCtx()
  const platform = !ctx.dealerAccount
  const list = useOrgQuery<Dealer[]>(orgKeys.dealers(userKey), (c, s) => orgSource().dealers(c, s), mockOrg.dealers, NONE, isMockMode() || platform)
  // 平台账号：有没有归属经销商的集成项目时，列表末尾补虚拟经销商「平台」（演示数据没有这种集成项目，不变）。
  // 不依赖 /distributors 成功：列表失败时「平台」仍可选（status 仍为 error，页面显示错误和重试）；加载中先不补，
  // 免得默认值先落到「平台」再跳到第一个真实经销商
  const all = useIntegratedProjects({ enabled: platform })
  const data = useMemo(() => (platform && list.status !== 'loading' ? withPlatformDealer(list.data, all.data) : list.data), [platform, list.status, list.data, all.data])
  return data === list.data ? list : { ...list, data, isEmpty: list.status === 'success' && data.length === 0 }
}

/**
 * 集成项目。dealerId 不传 → 账号范围内全部（经销商账号自动限定本级及下级）；
 * 传入 → 该经销商（含下级）的集成项目。enabled=false 时返回空列表（如平台账号还没选出经销商）。
 */
export function useIntegratedProjects(opts: { dealerId?: string; enabled?: boolean } = {}): Loadable<Group[]> {
  const { userKey } = useOrgCtx()
  const dealerId = opts.dealerId || undefined
  return useOrgQuery<Group[]>(
    orgKeys.groups(userKey, dealerId ?? null),
    (c, s) => orgSource().groups(c, dealerId, s),
    (c) => mockOrg.groups(c, dealerId),
    NONE,
    opts.enabled ?? true,
  )
}

/** 项目列表（POST /ctrl/projects，一次取全部），含在线状态 online 与应用编码 programCode（app_code） */
export function useProjects(filter: ProjectFilter = {}): Loadable<Project[]> {
  const { userKey } = useOrgCtx()
  const f = { onlyOnline: !!filter.onlyOnline }
  return useOrgQuery<Project[]>(orgKeys.projects(userKey, f), (c, s) => orgSource().projects(c, f, s), (c) => mockOrg.projects(c, f), NONE)
}

const NO_APPS: Record<string, string> = {}
/** app_id → 应用名称（集成项目卡的类型标签，S6b 用） */
export function useApps(): Loadable<Record<string, string>> {
  const { userKey } = useOrgCtx()
  return useOrgQuery(orgKeys.apps(userKey), (c, s) => orgSource().apps(c, s), mockOrg.apps, NO_APPS)
}

// ---------------------------------------------------------------------------
// 组合

const combine = (...ls: Loadable<unknown>[]): { status: LoadStatus; error: ApiError | null } => {
  const err = ls.find((l) => l.status === 'error')
  if (err) return { status: 'error', error: err.error }
  return { status: ls.some((l) => l.status === 'loading') ? 'loading' : 'success', error: null }
}

export interface OrgScope extends Loadable<Scope> {
  /** /distributors 失败（只影响经销商选择和侧栏的经销商分组，不拖垮整个组织范围） */
  dealersError: ApiError | null
}

/**
 * 当前账号可见的组织范围 { dealers, groups, projects }：集成项目里的项目（见 map.ts joinScope）。
 * 侧栏项目切换、顶栏搜索、首页统计、统一控制用它。status 只看集成项目与项目列表：任一失败即 error、
 * 任一加载中即 loading；经销商列表失败单独放在 dealersError。
 */
export function useOrgScope(): OrgScope {
  const { ctx } = useOrgCtx()
  const d = useDealers()
  const g = useIntegratedProjects()
  const p = useProjects()
  const scope = useMemo(() => joinScope(d.data, g.data, p.data, { dealerAccount: ctx.dealerAccount }), [d.data, g.data, p.data, ctx.dealerAccount])
  const { status, error } = combine(g, p)
  const [rd, rg, rp] = [d.refetch, g.refetch, p.refetch]
  const refetch = useCallback(() => { rd(); rg(); rp() }, [rd, rg, rp])
  return { data: scope, status, error, staleError: g.staleError ?? p.staleError, dealersError: d.status === 'error' ? d.error : null, isEmpty: status === 'success' && scope.projects.length === 0, refetch }
}

export interface CurrentProject {
  /** 当前项目；可见项目为空（加载中、失败、无数据）时为 null */
  project: Project | null
  /** 存储里的项目 ID 失效时回退到第一个可见项目（不改写存储） */
  setProjectId: (id: string) => void
  /** 每次切换上报完成后加一（常用项目据此刷新） */
  selectTick: number
  status: LoadStatus
  error: ApiError | null
}

/**
 * 当前项目：持久化在 localStorage 的 hjc-project，在可见范围（useOrgScope().projects）里解析，
 * 失效或换了账号就回退到第一个可见项目。切换时上报：演示数据记入本地计数；真实接口的
 * POST /project/click/{id} 由 S6b 接上（S6a 只读，不发）。
 */
export function useCurrentProject(): CurrentProject {
  const { ctx } = useOrgCtx()
  const scope = useOrgScope()
  const stored = useSyncExternalStore(subscribeCurrent, getStoredProjectId, getStoredProjectId)
  const selectTick = useSyncExternalStore(subscribeCurrent, getSelectTick, getSelectTick)
  const project = resolveCurrentProject(scope.data.projects, stored)
  const user = ctx.user
  const visible = scope.data.projects
  const setProjectId = useCallback((id: string) => {
    // 只接受当前可见范围里的项目：不在范围内的 id（演示数据、过期链接等）一律不写进存储、不上报
    if (!visible.some((p) => p.id === id)) { console.warn('[org] 忽略不在可见范围内的项目', id); return }
    setStoredProjectId(id)
    if (isMockMode()) void reportProjectSelect(user, id).then(bumpSelectTick)
    else bumpSelectTick()
  }, [user, visible])
  return { project, setProjectId, selectTick, status: scope.status, error: scope.error }
}

/** 项目能力（是否有房间温控、是否有新风运行设置等），按 app_code 派生；project 为空按「未知应用」 */
export function useCapabilities(project: Pick<Project, 'programCode'> | null | undefined): Capabilities {
  const code = project?.programCode ?? 0
  return useMemo(() => capabilitiesOf(code), [code])
}

/**
 * 经销商选择：返回 [有效的经销商 ID, 设置函数]。用户选过且仍在列表里就用它，否则用列表第一个；
 * 列表异步到达时自动取到默认值（替代 useState(dealers[0]?.id) 只在初始化取一次的写法）。
 */
export function useDealerPick(dealers: readonly Pick<Dealer, 'id'>[]): [string, (id: string) => void] {
  const [picked, setPicked] = useState('')
  return [resolveDealerId(dealers, picked), setPicked]
}

/**
 * 账号变化（主动退出、续期失败、别的标签页退出或换账号、同账号重新登录中间的未登录）时，
 * 取消进行中的请求并清掉全部查询缓存：组织数据按账号分键，但 S4 的 ['ctrl', …] 等不含账号，
 * 不清就会让下一个账号先看到上一个账号的数据。用 layout effect，在新账号的界面绘制前清掉。AppProvider 调一次
 */
export function useResetOnAccountChange() {
  const qc = useQueryClient()
  const { userKey } = useSession()
  const prev = useRef(userKey)
  useLayoutEffect(() => {
    if (prev.current && prev.current !== userKey) {
      // removeQueries 本身也会中止进行中的请求（用例验证了 signal 被 abort）；cancelQueries 保险起见先发
      // 新账号的组织查询（['org', 新 userKey]）此时可能已在本次渲染里建好并挂着观察者，不能删
      const stale = (q: { queryKey: readonly unknown[] }) => !(q.queryKey[0] === 'org' && userKey !== null && q.queryKey[1] === userKey)
      void qc.cancelQueries({ predicate: stale })
      qc.removeQueries({ predicate: stale })
    }
    prev.current = userKey
  }, [userKey, qc])
}
