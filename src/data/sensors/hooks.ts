// 室内空气传感器页的数据 hooks（TanStack Query，沿用 S4 QueryClient 默认值：网络 / 超时 / 服务器错误重试 1 次，
// 控制屏离线 503、无权限、ctrl 业务错误不重试）。查询键用 S4 的 queryKeys.ctrl（['ctrl', …]），
// 换账号时由 useResetOnAccountChange 整体清掉。
//
// 不发请求的情况（docs/分工.md 第 3 节第 6 条）：没有当前项目、项目离线、账号没有该路由权限。
// 轮询（上一次返回后才排下一次，TanStack 不重叠；标签页不可见时暂停）：
// - 207 每 15 秒；控制屏未连接（503）期间降到 60 秒继续探测，恢复成功后回到 15 秒（与 S11 一致，赤兔 11/24 确认）；
// - 208 是小时数据，5 分钟一次（503 期间不变）。
// 503 之后旧数据作废（同 S11 src/data/connections.ts 的请求序号方案）：每次真正发出的请求（含重试）分配递增序号，
// 503 记下该项目的失效序号，只有序号更大的成功结果才显示；之间遇到 500 / 超时只显示错误，不恢复 503 之前的读数。
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { ApiError, isApiError } from '../../api/errors'
import { queryKeys } from '../../api/query'
import { can } from '../session'
import type { Project } from '../org/types'
import { toAirSensors, type AirSensor } from './map'
import { sensorSource } from './source'
import { toHourPoints, windowOf, type HourPoint, type SensorRange, type StatWindow } from './stats'

export const SENSOR_POLL_MS = 15_000
/** 207 返回 503 后的探测间隔 */
export const SENSOR_UNAVAILABLE_POLL_MS = 60_000
export const HOURS_POLL_MS = 5 * 60_000
/** 网关按 permission_paths（/v1/... 路由模板）拦截；没有就不发请求 */
export const SENSOR_ROUTES = { live: '/v1/ctrl/air-sensor-get', hours: '/v1/ctrl/air-sensor-data-hour-get' } as const

type SensorProject = Pick<Project, 'id' | 'online'>

const toApiError = (e: unknown) => (isApiError(e) ? e : new ApiError('server', e instanceof Error ? e.message : '加载失败', { cause: e }))

// ---------------------------------------------------------------------------
// 请求序号（模块级：页面卸载再进入、缓存里仍是旧数据时也成立）

let seqCounter = 0
/** 项目 id → 最近一次 503 的请求序号（207、208 分开记） */
const invalid = { live: new Map<string, number>(), hours: new Map<string, number>() }
type Channel = keyof typeof invalid
interface Seq<T> { seq: number; value: T }

async function runSeq<T>(ch: Channel, pid: string, fn: () => Promise<T>): Promise<Seq<T>> {
  const seq = ++seqCounter
  try {
    return { seq, value: await fn() }
  } catch (e) {
    if (isApiError(e) && e.kind === 'unavailable' && seq > (invalid[ch].get(pid) ?? 0)) invalid[ch].set(pid, seq)
    throw e
  }
}
const invalidSeq = (ch: Channel, pid: string) => invalid[ch].get(pid) ?? 0
/** 该结果是否在最近一次 503 之后取得（可以显示） */
const valid = (ch: Channel, pid: string, d: Seq<unknown> | undefined) => d !== undefined && d.seq > invalidSeq(ch, pid)

/** 仅供测试 */
export const __resetSensorsForTests = () => { invalid.live.clear(); invalid.hours.clear(); seqCounter = 0 }

export type SensorsView =
  /** 没有当前项目（不发请求） */
  | { kind: 'no-project' }
  /** 项目离线（不发请求） */
  | { kind: 'offline' }
  /** 账号没有 207 的权限（不发请求） */
  | { kind: 'forbidden' }
  | { kind: 'loading' }
  /** 207 返回控制屏未连接（503）。之前的数据作废，不再显示 */
  | { kind: 'unavailable' }
  /** 没有可显示的数据时失败（首次加载失败，或 503 之后又遇到其他错误） */
  | { kind: 'error'; error: ApiError; retry: () => void }
  /** 成功但项目下没有空气传感器 */
  | { kind: 'empty'; updatedAt: number }
  /** staleError：有数据时后台刷新失败（仍显示这份数据并提示） */
  | { kind: 'ready'; sensors: AirSensor[]; updatedAt: number; staleError: ApiError | null; retry: () => void }

/** ctrl 207：当前项目的空气传感器列表 */
export function useAirSensors(project: SensorProject | null): SensorsView {
  const pid = project?.id ?? ''
  const permitted = can(SENSOR_ROUTES.live)
  const enabled = !!pid && project!.online && permitted
  const q = useQuery({
    // 与 ctrlQuery(207) 的原始回复分开缓存（这里存的是带序号的视图模型）
    queryKey: queryKeys.ctrl(207, pid, { view: 'air-sensors' }),
    queryFn: ({ signal }) => runSeq('live', pid, async () => toAirSensors(await sensorSource().live(pid, signal))),
    enabled,
    // 503 之后（还没有更新的成功）降频探测
    refetchInterval: (query) => (valid('live', pid, query.state.data) || invalidSeq('live', pid) === 0 ? SENSOR_POLL_MS : SENSOR_UNAVAILABLE_POLL_MS),
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!project || !pid) return { kind: 'no-project' }
  if (!project.online) return { kind: 'offline' }
  if (!permitted) return { kind: 'forbidden' }
  const err = q.error ? toApiError(q.error) : null
  if (!valid('live', pid, q.data)) {
    if (err?.kind === 'unavailable') return { kind: 'unavailable' }
    return err ? { kind: 'error', error: err, retry } : { kind: 'loading' }
  }
  const d = q.data!
  if (d.value.length === 0) return { kind: 'empty', updatedAt: q.dataUpdatedAt }
  return { kind: 'ready', sensors: d.value, updatedAt: q.dataUpdatedAt, staleError: err, retry }
}

export interface HoursData { window: StatWindow; points: HourPoint[] }

export type HoursView =
  /** 没有可统计的传感器（项目离线、没有在线传感器等），不发请求 */
  | { kind: 'idle' }
  | { kind: 'forbidden' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; error: ApiError; retry: () => void }
  /** points 为空表示该时段没有任何小时数据；staleError：后台刷新失败，显示的是 window.end 时刻取的数据 */
  | ({ kind: 'ready'; staleError: ApiError | null; retry: () => void } & HoursData)

/**
 * ctrl 208：一台传感器在所选范围内的小时数据。取数窗口在每次请求时按当时的时刻算（毫秒），
 * 查询键只含 项目 / 设备 / 范围，所以轮询会自动滚动窗口，切换范围或设备不会串数据（各自一个键，不沿用上一个键的结果）。
 */
export function useSensorHours(project: SensorProject | null, sensor: Pick<AirSensor, 'id' | 'online'> | undefined, range: SensorRange): HoursView {
  const pid = project?.id ?? ''
  const deviceId = sensor?.id ?? 0
  const permitted = can(SENSOR_ROUTES.hours)
  const active = !!pid && !!project?.online && !!sensor?.online
  const q = useQuery({
    queryKey: queryKeys.ctrl(208, pid, { deviceId, range }),
    queryFn: ({ signal }) => runSeq('hours', pid, async (): Promise<HoursData> => {
      const w = windowOf(range, Date.now())
      const records = await sensorSource().hours(pid, deviceId, w.start, w.end, signal)
      return { window: w, points: toHourPoints(records, deviceId, w) }
    }),
    enabled: active && permitted,
    refetchInterval: HOURS_POLL_MS,
    staleTime: 60_000,
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!active) return { kind: 'idle' }
  if (!permitted) return { kind: 'forbidden' }
  const err = q.error ? toApiError(q.error) : null
  if (!valid('hours', pid, q.data)) {
    if (err?.kind === 'unavailable') return { kind: 'unavailable' }
    return err ? { kind: 'error', error: err, retry } : { kind: 'loading' }
  }
  return { kind: 'ready', ...q.data!.value, staleError: err, retry }
}
