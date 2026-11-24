// 组织数据的读接口：经销商、集成项目、项目列表、应用。全部是只读 POST，经 http.ts 的 request()。
// 响应保持后端 snake_case，只声明用到的字段；映射成页面视图模型在 src/data/org/map.ts。
// 依据：docs/api/接口文档.md 第 4、6、7 节，docs/plan-v1.md 1.2 节与文末后端答复。
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
