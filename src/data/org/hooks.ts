// 组织数据 hooks（TanStack Query，沿用 S4 的 QueryClient 默认值：读请求网络/超时/服务器错误重试 1 次）。
// 查询键都以 ['org', userKey] 开头：按账号隔离缓存，退出时整体清掉（useResetOrgOnSignOut）。
// 每个 hook 返回 Loadable：data（加载中 / 失败时为空数组或上一次的数据）、status 三态、error、isEmpty。
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getFrequentProjects as getMockFrequent, reportProjectSelect } from '../../api'
import { isMockMode } from '../../api/config'
import { ApiError, isApiError } from '../../api/errors'
import { getFrequentProjects, getIntegratedProjectStat, reportProjectClick } from '../../api/pcfg'
import { can, useSession } from '../session'
import { capabilitiesOf, type Capabilities } from './capabilities'
import { bumpSelectTick, forgetRejected, getRejected, getSelectTick, getStoredProjectId, setRejected, setStoredProjectId, subscribeCurrent } from './current'
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
  stat: (userKey: string | null) => ['org', userKey, 'stat'] as const,
  frequent: (userKey: string | null, tick: number) => ['org', userKey, 'frequent', tick] as const,
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
  /**
   * 切换当前项目，同步返回结果（见 SetProjectResult）。目标在当前可见范围里：写入、上报点击并返回 true；
   * 不在（例如按经销商取的集成项目比全量缓存新）：不写存储、不上报，在后台刷新一次组织范围
   * （只刷新数据，不提交任何选择），返回 'refreshing'；这次刷新成功后再选它仍不在范围里，返回 'forbidden'。
   * 调用方用 whenProjectSet()，只有成功才跳转、提示成功
   */
  setProjectId: (id: string) => SetProjectResult
  /** 每次切换上报完成后加一（常用项目据此刷新） */
  selectTick: number
  status: LoadStatus
  error: ApiError | null
}

/** true 切换成功；'refreshing' 不在缓存的可见范围里、正在后台刷新；'forbidden' 刷新成功后仍不在可见范围里 */
export type SetProjectResult = true | 'refreshing' | 'forbidden'

/** 切换失败的提示文案 */
export const SET_PROJECT_FAIL_TEXT: Record<Exclude<SetProjectResult, true>, string> = {
  refreshing: '项目列表正在刷新，请稍后重试',
  forbidden: '无权查看该项目',
}

/** 处理 setProjectId 的结果（同步）：成功才执行 ok（提示、跳转），否则把失败文案交给 fail */
export function whenProjectSet(r: SetProjectResult, ok: () => void, fail: (text: string) => void) {
  if (r === true) ok(); else fail(SET_PROJECT_FAIL_TEXT[r] ?? SET_PROJECT_FAIL_TEXT.refreshing)
}

/** 真实接口：切换成功后上报一次点击（POST /project/click/{id}，只记次数，不是下发接口）。没有该路由的权限就不发 */
function reportClick(id: string) {
  if (!can(`/v1/project/click/${id}`)) return
  reportProjectClick(id).then(bumpSelectTick, (e: unknown) => console.warn('[org] 项目点击上报失败', isApiError(e) ? e.message : e))
}

/**
 * 当前项目：持久化在 localStorage 的 hjc-project，在可见范围（useOrgScope().projects）里解析，
 * 失效或换了账号就回退到第一个可见项目。切换时上报：演示数据记入本地计数；真实接口发 POST /project/click/{id}
 * （失败只记日志，不影响切换）。上报完成后 selectTick 加一，常用项目据此重取。
 */
export function useCurrentProject(): CurrentProject {
  const { ctx, userKey } = useOrgCtx()
  const qc = useQueryClient()
  const scope = useOrgScope()
  const stored = useSyncExternalStore(subscribeCurrent, getStoredProjectId, getStoredProjectId)
  const selectTick = useSyncExternalStore(subscribeCurrent, getSelectTick, getSelectTick)
  const project = resolveCurrentProject(scope.data.projects, stored)
  const user = ctx.user
  const visible = scope.data.projects
  const setProjectId = useCallback((id: string): SetProjectResult => {
    const k = `${userKey}\n${id}`
    if (visible.some((p) => p.id === id)) {
      forgetRejected(k)
      setStoredProjectId(id)
      if (isMockMode()) void reportProjectSelect(user, id).then(bumpSelectTick)
      else reportClick(id)
      return true
    }
    // 不在缓存的可见范围里（演示数据、过期链接、缓存旧了）：失败，不写存储、不上报。
    // 第一次：后台刷新项目列表和全量集成项目，刷新结果只更新数据，不提交任何选择（用户再点一次时按新数据判断）；
    // 刷新进行中再点：仍提示正在刷新，不重复刷新；刷新两份都成功后仍不在范围里：无权查看。刷新失败则忘掉，下次再刷
    console.warn('[org] 忽略不在可见范围内的项目', id)
    const st = getRejected(k)
    if (st === 'refreshed') return 'forbidden'
    if (st !== 'refreshing') {
      setRejected(k, 'refreshing')
      const keys = [orgKeys.projects(userKey, {}), orgKeys.groups(userKey, null)]
      // refetchQueries 在查询失败时也会正常结束（旧数据保留），所以逐个看查询状态，不能只看 Promise
      void Promise.all(keys.map((queryKey) => qc.refetchQueries({ queryKey, exact: true }))).then(() => {
        if (getRejected(k) !== 'refreshing') return // 期间已成功切换（被清掉）
        if (keys.every((queryKey) => qc.getQueryState(queryKey)?.status === 'success')) setRejected(k, 'refreshed')
        else forgetRejected(k)
      })
    }
    return 'refreshing'
  }, [user, visible, qc, userKey])
  return { project, setProjectId, selectTick, status: scope.status, error: scope.error }
}

// ---------------------------------------------------------------------------
// 首页

export interface OrgStat {
  /** 集成项目数 */
  groups: number
  /** 集成项目里的项目数（去重） */
  projects: number
  online: number
  offline: number
}

/**
 * 首页 4 张统计卡。真实接口：POST /integrated-projects/stat（接口文档 6.1，字段一一对应）；
 * 演示数据、没有该路由权限（测试经销商账号目前 403）、或统计接口失败时，按可见组织范围在前端算
 * （口径相同：集成项目数、集成项目里去重后的项目数、其中在线 / 离线数），error 里留着失败原因。
 * 统计接口加载中时 data 为 null（卡片显示占位）。
 */
export function useOrgStat(): Omit<Loadable<OrgStat | null>, 'isEmpty'> & { source: 'api' | 'scope' } {
  const { userKey, authed } = useOrgCtx()
  const scope = useOrgScope()
  const api = !isMockMode() && can('/v1/integrated-projects/stat')
  const q = useQuery({
    queryKey: orgKeys.stat(userKey),
    queryFn: ({ signal }) => getIntegratedProjectStat({ signal }),
    enabled: authed && api,
    staleTime: REAL_STALE_MS,
  })
  const { groups, projects } = scope.data
  const local = useMemo<OrgStat>(() => {
    const online = projects.filter((p) => p.online).length
    return { groups: groups.length, projects: projects.length, online, offline: projects.length - online }
  }, [groups, projects])
  const qRefetch = q.refetch
  const refetch = useCallback(() => { void qRefetch() }, [qRefetch])
  if (api && q.data) {
    const d = q.data
    return { data: { groups: d.total, projects: d.projectTotal, online: d.projectOnline, offline: d.projectOffline }, status: 'success', error: null, staleError: q.isError ? toApiError(q.error) : null, source: 'api', refetch }
  }
  if (api && !q.isError) return { data: null, status: 'loading', error: null, staleError: null, source: 'api', refetch }
  const fromScope = scope.status === 'success' ? local : null
  return { data: fromScope, status: scope.status, error: api ? toApiError(q.error) : scope.error, staleError: null, source: 'scope', refetch: api ? refetch : scope.refetch }
}

export interface FrequentProject {
  project: Project
  /** 选择次数（只有演示数据有） */
  count?: number
}

/** 常用项目向后端多要一些：按可见范围过滤后仍尽量凑满 limit 个 */
const FREQUENT_FETCH = 20

/**
 * 常用项目（首页）：真实接口 POST /projects/frequent（按点击次数降序），演示数据为本地计数。
 * 只保留当前可见组织范围里的项目，项目对象取自组织范围（与侧栏、搜索同一份），最多 limit 个。
 * 切换项目上报完成后（selectTick 变化）重取，重取期间保留上一份结果。
 * permitted=false：账号没有该路由的权限（测试经销商账号目前 403），不发请求，页面显示「未开通」。
 */
export function useFrequentProjects(limit = 4): Loadable<FrequentProject[]> & { permitted: boolean } {
  const { ctx, userKey, authed } = useOrgCtx()
  const scope = useOrgScope()
  const tick = useSyncExternalStore(subscribeCurrent, getSelectTick, getSelectTick)
  const mock = isMockMode()
  const permitted = mock || can('/v1/projects/frequent')
  const user = ctx.user
  const q = useQuery({
    queryKey: orgKeys.frequent(userKey, tick),
    queryFn: async ({ signal }): Promise<{ id: string; count?: number }[]> =>
      mock ? getMockFrequent(user) : (await getFrequentProjects(FREQUENT_FETCH, { signal })).map((e) => ({ id: e.id })),
    enabled: authed && permitted,
    // 重取期间保留上一份结果，但只限同一账号（换账号绝不沿用上一个账号的数据）
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === userKey ? keepPreviousData(prev) : undefined),
    staleTime: mock ? Infinity : REAL_STALE_MS,
  })
  const projects = scope.data.projects
  const data = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    const out: FrequentProject[] = []
    for (const f of q.data ?? NONE) {
      const p = byId.get(f.id)
      if (p && !out.some((x) => x.project.id === p.id)) out.push(f.count === undefined ? { project: p } : { project: p, count: f.count })
      if (out.length >= limit) break
    }
    return out
  }, [q.data, projects, limit])
  const qRefetch = q.refetch
  const refetch = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!permitted) return { data: NONE, status: authed ? 'success' : 'loading', error: null, staleError: null, isEmpty: authed, refetch: noop, permitted }
  const status: LoadStatus = scope.status !== 'success' ? scope.status : q.data !== undefined ? 'success' : q.isError ? 'error' : 'loading'
  const err = scope.status === 'error' ? scope.error : toApiError(q.error)
  return { data: status === 'success' ? data : NONE, status, error: status === 'error' ? err : null, staleError: status === 'success' && q.isError ? err : null, isEmpty: status === 'success' && data.length === 0, refetch, permitted }
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
