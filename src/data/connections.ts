// 设备连接状态（S11）：ctrl 205 DeviceSummaryGet → 页面用的连接明细，以及项目的控制屏 / DTU 编号。
// 只读：只调 ctrl 205（读消息）；演示数据模式取 src/api 的演示连接数据，映射成同一视图模型。
//
// 字段依据 docs/api/ctrl同步消息200-210.md 4.6 与 docs/api/实测记录-1124.md：
// - device_id 实测全部缺省（proto3 的 0），不能当行键；缺省或非法时为 null；
// - conn_status：0 离线、1 在线、2 异常；proto3 缺省即 0（离线）；其他值（含 65536 未初始化）记为 unknown，
//   只计入「全部」，不混进三种状态；
// - device_name / model / address 缺省为空串，显示 --。
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { getConnections, type Conn, type Project } from '../api'
import { isMockMode } from '../api/config'
import type { CtrlReply } from '../api/ctrl'
import { isApiError, type ApiError } from '../api/errors'
import { ctrlQuery } from '../api/query'
import { PLACEHOLDER } from '../api/values'
import { can } from './session'

/** 连接状态每 30 秒重新读一次 205（方案 1.2「每 30 秒检测一次」、3.4 轮询） */
export const CONN_POLL_MS = 30_000
/** ctrl 205 的路由模板（permission_paths 判断用） */
export const CONN_ROUTE = '/v1/ctrl/device-summary-get'

export type ConnStatus = 'online' | 'offline' | 'error' | 'unknown'
export const CONN_STATUS_TEXT: Record<ConnStatus, string> = { online: '在线', offline: '离线', error: '通讯异常', unknown: '未知' }

export interface ConnRow {
  /** 行键：列表内序号（device_id 实测缺省，名称也可能重复） */
  key: string
  deviceId: number | null
  /** 以下三项缺省时为 --（PLACEHOLDER） */
  name: string
  /** 型号（205 的 model；演示数据为设备类型） */
  model: string
  address: string
  status: ConnStatus
}

/** conn_status → 状态。0/1/2 以外（含 65536、负数、非数值）为 unknown；缺省（undefined）按 proto3 默认值 0 即离线 */
export function toConnStatus(v: unknown): ConnStatus {
  if (v === undefined || v === null) return 'offline'
  switch (v) {
    case 0: return 'offline'
    case 1: return 'online'
    case 2: return 'error'
    default: return 'unknown'
  }
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : PLACEHOLDER)
const id = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)

type SummaryData = CtrlReply<205>['data'][number]

/** ctrl 205 的回复 → 连接明细（顺序沿用回复） */
export function toConnRows(reply: Partial<CtrlReply<205>> | null | undefined): ConnRow[] {
  const list: Partial<SummaryData>[] = Array.isArray(reply?.data) ? reply.data : []
  return list.map((d, i) => ({
    key: String(i),
    deviceId: id(d?.deviceId),
    name: text(d?.deviceName),
    model: text(d?.model),
    address: text(d?.address),
    status: toConnStatus(d?.connStatus),
  }))
}

const MOCK_STATUS: Record<Conn['state'], ConnStatus> = { 在线: 'online', 离线: 'offline', 通讯异常: 'error' }
/** 演示数据 → 连接明细：类型放进型号列，地址取总线地址的后半段（与演示版显示一致） */
export function mockConnRows(list: readonly Conn[]): ConnRow[] {
  return list.map((c, i) => ({
    key: String(i),
    deviceId: null,
    name: text(c.name),
    model: text(c.type),
    address: text(c.bus.split(' / ')[1] ?? c.bus),
    status: MOCK_STATUS[c.state] ?? 'unknown',
  }))
}

export interface ConnCounts { total: number; online: number; offline: number; error: number; unknown: number; models: number }

export function connCounts(rows: readonly ConnRow[]): ConnCounts {
  const n = (s: ConnStatus) => rows.filter((r) => r.status === s).length
  const models = new Set(rows.map((r) => r.model).filter((m) => m !== PLACEHOLDER)).size
  return { total: rows.length, online: n('online'), offline: n('offline'), error: n('error'), unknown: n('unknown'), models }
}

export type ConnFilter = '全部' | '在线' | '离线' | '异常'
const FILTER_STATUS: Record<Exclude<ConnFilter, '全部'>, ConnStatus> = { 在线: 'online', 离线: 'offline', 异常: 'error' }
export function filterConn(rows: readonly ConnRow[], f: ConnFilter): ConnRow[] {
  return f === '全部' ? [...rows] : rows.filter((r) => r.status === FILTER_STATUS[f])
}

/** 百分比（一位小数）；总数为 0 时为 null */
export const pct = (part: number, total: number) => (total > 0 ? (part / total * 100).toFixed(1) : null)

/**
 * 项目的连接端：控制屏（control_screen_id）、DTU（dtu_id），只列有值的。
 * 项目在线判定（接口文档 4）：有 DTU 且 DTU 在线，或控制屏在线。
 */
export function linksOf(p: Pick<Project, 'controlScreenId' | 'dtuId'> | null | undefined): { label: string; id: string }[] {
  const out: { label: string; id: string }[] = []
  const cs = typeof p?.controlScreenId === 'string' ? p.controlScreenId.trim() : ''
  const dtu = typeof p?.dtuId === 'string' ? p.dtuId.trim() : ''
  if (cs) out.push({ label: '控制屏', id: cs })
  if (dtu) out.push({ label: 'DTU', id: dtu })
  return out
}

export interface DeviceSummary {
  rows: ConnRow[]
  /** loading：还没拿到过数据；error：从没拿到过数据就失败了；success：有数据（可能是上一次的） */
  status: 'idle' | 'loading' | 'error' | 'success'
  /** 最近一次失败（有旧数据时也保留，页面据此提示；unavailable 时页面显示「控制屏未连接」而不是旧数据） */
  error: ApiError | null
  /** 正在请求（含轮询、手动检测） */
  fetching: boolean
  /** 账号有没有 ctrl 205 的权限（没有就不发请求） */
  permitted: boolean
  /** 最近一次成功的时间（毫秒时间戳），没有为 0 */
  updatedAt: number
  /** 立即重新读一次 205，返回这次的结果 */
  check: () => Promise<{ rows: ConnRow[] | null; error: ApiError | null }>
}

const NO_ROWS: ConnRow[] = []
const asApiError = (e: unknown): ApiError | null => (e == null ? null : isApiError(e) ? e : null)

/**
 * 当前项目的设备连接明细。只在项目存在、在线、账号有权限时请求（离线项目不请求，Layout 也不挂载设备页）；
 * 每 30 秒轮询一次，上一次没返回不会重叠（同一查询键去重），标签页不可见时 TanStack 默认暂停。
 * 控制屏离线（503 unavailable）、无权限不重试（S4 的默认重试规则）。
 */
export function useDeviceSummary(project: Pick<Project, 'id' | 'online'> | null): DeviceSummary {
  const mock = isMockMode()
  const pid = project?.id ?? ''
  const permitted = mock || can(CONN_ROUTE)
  const enabled = !!pid && project?.online === true && permitted
  const real = ctrlQuery(205, pid)
  const q = useQuery<unknown, Error, ConnRow[]>({
    ...(mock
      ? { queryKey: ['mock', 'connections', pid], queryFn: () => getConnections(pid), select: (d: unknown) => mockConnRows(d as Conn[]) }
      : { queryKey: real.queryKey, queryFn: real.queryFn as () => Promise<unknown>, select: (d: unknown) => toConnRows(d as CtrlReply<205>) }),
    enabled,
    refetchInterval: enabled ? CONN_POLL_MS : false,
  })
  const qRefetch = q.refetch
  const check = useCallback(async () => {
    const r = await qRefetch()
    return { rows: r.isSuccess ? r.data : null, error: r.isError ? asApiError(r.error) ?? null : null }
  }, [qRefetch])
  const status: DeviceSummary['status'] = !enabled ? 'idle' : q.data !== undefined ? 'success' : q.isError ? 'error' : 'loading'
  return {
    rows: enabled ? q.data ?? NO_ROWS : NO_ROWS,
    status,
    error: enabled ? asApiError(q.error) : null,
    fetching: enabled && q.isFetching,
    permitted,
    updatedAt: q.dataUpdatedAt,
    check,
  }
}
