// 组织数据的视图模型：经销商 → 集成项目 → 项目。页面只认这里的类型，mock 与真实接口都映射成它。
// 字段名沿用演示版（页面现有代码直接可用），真实接口特有的字段为可选。

export type Role = 'dealer' | 'admin'
export interface User { username: string; name: string; org: string; role: Role; roleLabel: string; dealerId?: string }

export interface Dealer {
  id: string
  name: string
  /** 简称（abbreviation，缺失时用全称） */
  short: string
  /** 演示数据为大区名；真实接口为行政区划码 */
  region: string
  code?: string
}

export interface Group {
  id: string
  /** 界面上显示的集成项目编码；演示数据与 id 相同 */
  code: string
  /** 所属经销商；平台创建的集成项目可能为空串 */
  dealerId: string
  name: string
  /** 应用类型名称；真实接口只有 app_id，名称用 useApps() 查（S6b），映射时为空串 */
  type: string
  typeColor: 'cyan' | 'blue' | 'purple' | 'orange'
  desc: string
  created: string
  appId?: string
  /** 关联项目 ID（项目可能同时属于多个集成项目，按它判断归属，不要用 Project.groupId） */
  projectIds: string[]
  /** 任一关联项目在线 */
  online?: boolean
}

export interface Project {
  /** 后端实体 ID，用于 ctrl 请求的 project_id */
  id: string
  /** 界面上的「项目 ID」显示 code（Q9）；演示数据与 id 相同 */
  code: string
  name: string
  /** 第一个包含它的集成项目（只用于侧栏分组展示）；判断归属用 Group.projectIds */
  groupId: string
  /** 演示数据的城市 / 区县名；真实接口只有行政区划码（region），这里为空串，名称见 area */
  city: string
  district: string
  /**
   * 「区域」列显示的文字：真实接口由 region 的区划码转成「市 区县」（map.ts toProject），
   * 码查不到为「原码（未知）」；演示数据为「城市 区县」。空串表示没有设置区域
   */
  area: string
  kind: string
  /** 后端 online 只在 true 时出现，缺失即离线 */
  online: boolean
  version: string
  devices: number
  /** 应用编码 app_code（演示版叫「程序编码」）。1 通用版，12 独立空气系统（新风单机），8 暂不用；缺失为 0 */
  programCode: number
  appName?: string
  /** 行政区划码 customer_region，如 "320000/320500/320506" */
  region?: string
  distributorId?: string
  distributorName?: string
  controlScreenId?: string
  dtuId?: string
  // 以下只有演示数据有
  temp?: number
  humidity?: number
  co2?: number
  lastOnline?: string
  lastOnlineAgo?: string
}

export interface Scope { dealers: Dealer[]; groups: Group[]; projects: Project[] }

/** 数据层三态：页面据此显示加载、失败、空数据 */
export type LoadStatus = 'loading' | 'error' | 'success'
