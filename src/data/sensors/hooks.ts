// 室内空气传感器页的数据 hooks（TanStack Query，沿用 S4 QueryClient 默认值：网络 / 超时 / 服务器错误重试 1 次，
// 控制屏离线 503、无权限、ctrl 业务错误不重试）。查询键用 S4 的 queryKeys.ctrl（['ctrl', …]），
// 换账号时由 useResetOnAccountChange 整体清掉。
//
// 不发请求的情况（docs/分工.md 第 3 节第 6 条）：没有当前项目、项目离线、账号没有该路由权限。
// 轮询：207 每 15 秒（上一次返回后才排下一次，TanStack 不重叠；标签页不可见时暂停）；208 是小时数据，5 分钟一次。
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
export const HOURS_POLL_MS = 5 * 60_000
/** 网关按 permission_paths（/v1/... 路由模板）拦截；没有就不发请求 */
export const SENSOR_ROUTES = { live: '/v1/ctrl/air-sensor-get', hours: '/v1/ctrl/air-sensor-data-hour-get' } as const

type SensorProject = Pick<Project, 'id' | 'online'>

const toApiError = (e: unknown) => (isApiError(e) ? e : new ApiError('server', e instanceof Error ? e.message : '加载失败', { cause: e }))

export type SensorsView =
  /** 没有当前项目（不发请求） */
  | { kind: 'no-project' }
  /** 项目离线（不发请求） */
  | { kind: 'offline' }
  /** 账号没有 207 的权限（不发请求） */
  | { kind: 'forbidden' }
  | { kind: 'loading' }
  /** 207 返回控制屏未连接（503）。即使之前有数据也不再显示旧值 */
  | { kind: 'unavailable' }
  /** 首次加载失败 */
  | { kind: 'error'; error: ApiError; retry: () => void }
  /** 成功但项目下没有空气传感器 */
  | { kind: 'empty'; updatedAt: number }
  /** staleError：有旧数据时后台刷新失败（仍显示旧数据并提示） */
  | { kind: 'ready'; sensors: AirSensor[]; updatedAt: number; staleError: ApiError | null; retry: () => void }

/** ctrl 207：当前项目的空气传感器列表 */
export function useAirSensors(project: SensorProject | null): SensorsView {
  const pid = project?.id ?? ''
  const permitted = can(SENSOR_ROUTES.live)
  const enabled = !!pid && project!.online && permitted
  const q = useQuery({
    // 与 ctrlQuery(207) 的原始回复分开缓存（这里存的是映射后的视图模型）
    queryKey: queryKeys.ctrl(207, pid, { view: 'air-sensors' }),
    queryFn: async ({ signal }) => toAirSensors(await sensorSource().live(pid, signal)),
    enabled,
    refetchInterval: SENSOR_POLL_MS,
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!project || !pid) return { kind: 'no-project' }
  if (!project.online) return { kind: 'offline' }
  if (!permitted) return { kind: 'forbidden' }
  const err = q.error ? toApiError(q.error) : null
  if (err?.kind === 'unavailable') return { kind: 'unavailable' }
  if (q.data === undefined) return err ? { kind: 'error', error: err, retry } : { kind: 'loading' }
  if (q.data.length === 0) return { kind: 'empty', updatedAt: q.dataUpdatedAt }
  return { kind: 'ready', sensors: q.data, updatedAt: q.dataUpdatedAt, staleError: err, retry }
}

export interface HoursData { window: StatWindow; points: HourPoint[] }

export type HoursView =
  /** 没有可统计的传感器（项目离线、没有在线传感器等），不发请求 */
  | { kind: 'idle' }
  | { kind: 'forbidden' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; error: ApiError; retry: () => void }
  /** points 为空表示该时段没有任何小时数据 */
  | ({ kind: 'ready'; staleError: ApiError | null } & HoursData)

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
    queryFn: async ({ signal }): Promise<HoursData> => {
      const w = windowOf(range, Date.now())
      const records = await sensorSource().hours(pid, deviceId, w.start, w.end, signal)
      return { window: w, points: toHourPoints(records, deviceId, w) }
    },
    enabled: active && permitted,
    refetchInterval: HOURS_POLL_MS,
    staleTime: 60_000,
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!active) return { kind: 'idle' }
  if (!permitted) return { kind: 'forbidden' }
  const err = q.error ? toApiError(q.error) : null
  if (err?.kind === 'unavailable') return { kind: 'unavailable' }
  if (q.data === undefined) return err ? { kind: 'error', error: err, retry } : { kind: 'loading' }
  return { kind: 'ready', ...q.data, staleError: err }
}
