// 组织数据的读接口：经销商、集成项目（含统计）、项目列表、常用项目、应用，经 http.ts 的 request()；
// 另有切换项目时的点击上报（/project/click/{id}，只记次数，不是下发接口）。
// 响应保持后端 snake_case，只声明用到的字段；映射成页面视图模型在 src/data/org/map.ts。
// 依据：docs/api/接口文档.md 第 4、6、7 节，docs/plan-v1.md 1.2 节与文末后端答复。
import { ApiError } from './errors'
import { request } from './http'

/** ProjectEntity（/ctrl/projects 返回，比 /projects 多 mode、app_version 等） */
export interface ProjectEntity {
  id: string
  name?: string
  /** 界面上的「项目 ID」显示 code（Q9 结论） */
  code?: string
  /** 后端返回字符串，如 "1"、"12" */
  app_code?: string | number
  app_name?: string
  app_id?: string
  app_version?: string
  app_category_name?: string
  distributor_id?: string
  distributor_name?: string
  /** 行政区划码，如 "320000/320500/320506" */
  customer_region?: string
  customer_address?: string
  control_screen_id?: string
  dtu_id?: string
  mode?: number
  mode_desc?: string
  brief_stat?: { device_count?: string | number; room_count?: string | number }
  /** 只在 true 时出现（proto3 不输出 false），缺失即离线 */
  online?: boolean
}

export interface IntegratedProjectEntity {
  id: string
  name?: string
  code?: string
  /** 平台创建的集成项目可能没有 */
  distributor_id?: string
  project_ids?: string[]
  desc?: string
  app_id?: string
  created_at?: string
  /** 任一关联项目在线即为 true；同样只在 true 时出现 */
  online?: boolean
}

export interface DistributorEntity {
  id: string
  name?: string
  code?: string
  abbreviation?: string
  region?: string
}

export interface AppEntity { id: string; code?: string; name?: string; category_name?: string }

interface Opts { signal?: AbortSignal }

/**
 * POST /ctrl/projects：项目列表与在线筛选（后端 11/24 答复，已实测）。
 * 不传 page_options 返回全部（limit 实测无上限）；onlyOnline=true 只返回在线项目。
 */
export async function getCtrlProjects(req: { onlyOnline?: boolean } = {}, opts: Opts = {}): Promise<ProjectEntity[]> {
  const body = req.onlyOnline ? { only_online: true } : {}
  const r = await request<{ project_entities?: ProjectEntity[] }>('/ctrl/projects', { body, signal: opts.signal })
  return Array.isArray(r.project_entities) ? r.project_entities : []
}

/**
 * POST /integrated-projects。distributorId 不传按当前账号范围（经销商账号自动限定为本级及下级）；
 * 传入时包含其下级经销商。不分页，一次取全部。
 */
export async function getIntegratedProjects(req: { distributorId?: string } = {}, opts: Opts = {}): Promise<IntegratedProjectEntity[]> {
  const body = req.distributorId ? { distributor_id: req.distributorId } : {}
  const r = await request<{ entities?: IntegratedProjectEntity[] }>('/integrated-projects', { body, signal: opts.signal })
  return Array.isArray(r.entities) ? r.entities : []
}

/**
 * POST /distributors { has_integrated_project: true }：只返回拥有集成项目的经销商。
 * 只给平台账号用（经销商选择器）；经销商账号调用会返回全部 127 个（后端未按范围限定，实测记录「其他发现」4）。
 */
export async function getDistributors(opts: Opts = {}): Promise<DistributorEntity[]> {
  const r = await request<{ distributor_entities?: DistributorEntity[] }>('/distributors', { body: { has_integrated_project: true }, signal: opts.signal })
  return Array.isArray(r.distributor_entities) ? r.distributor_entities : []
}

/** POST /apps：应用列表（集成项目只有 app_id，类型名称按它查；两种账号都能调） */
export async function getApps(opts: Opts = {}): Promise<AppEntity[]> {
  const r = await request<{ app_entities?: AppEntity[] }>('/apps', { body: {}, signal: opts.signal })
  return Array.isArray(r.app_entities) ? r.app_entities : []
}

/** int64 在网关 JSON 里是字符串（实测 {"total":"3"}）；缺失、非法为 0 */
const int64 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }

export interface IntegratedProjectStat { total: number; projectTotal: number; projectOnline: number; projectOffline: number }

/**
 * POST /integrated-projects/stat：首页 4 张统计卡（接口文档 6.1）。数据权限同 /integrated-projects
 * （经销商账号限定为本级及下级）；同一项目被多个集成项目包含时只算一次。
 */
export async function getIntegratedProjectStat(opts: Opts = {}): Promise<IntegratedProjectStat> {
  const r = await request<{ total?: unknown; project_total?: unknown; project_online?: unknown; project_offline?: unknown }>('/integrated-projects/stat', { body: {}, signal: opts.signal })
  const projectTotal = int64(r.project_total), projectOnline = Math.min(int64(r.project_online), projectTotal)
  // project_offline 文档定义为 project_total - project_online；缺失时按定义算
  const projectOffline = r.project_offline === undefined ? projectTotal - projectOnline : int64(r.project_offline)
  return { total: int64(r.total), projectTotal, projectOnline, projectOffline }
}

/**
 * POST /projects/frequent { limit }：当前用户点击次数最多的项目，按次数降序（接口文档第 5 节）。
 * 没有点击记录时实测返回 {}。limit <= 0 时后端默认 4。
 */
export async function getFrequentProjects(limit: number, opts: Opts = {}): Promise<ProjectEntity[]> {
  const r = await request<{ project_entities?: ProjectEntity[] }>('/projects/frequent', { body: { limit }, signal: opts.signal })
  return Array.isArray(r.project_entities) ? r.project_entities : []
}

/** 后端实体 id 只含字母、数字、下划线和连字符（ObjectId 是 24 位十六进制）；其他值不拼进路径 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * POST /project/click/{id}，body {}：切换当前项目时上报一次点击（常用项目按它统计）。
 * 只记点击次数、不涉及设备，不是下发接口（guard.ts 的 isWritePath 不会把它判成写接口）。
 */
export async function reportProjectClick(id: string, opts: Opts = {}): Promise<void> {
  if (!SAFE_ID.test(id)) throw new ApiError('bad_request', `项目 id 不合法：${JSON.stringify(id)}`)
  await request<unknown>(`/project/click/${id}`, { body: {}, signal: opts.signal })
}
