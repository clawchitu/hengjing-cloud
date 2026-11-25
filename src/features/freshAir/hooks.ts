// 新风页的数据 hooks（TanStack Query，沿用 S4 QueryClient 默认值：网络 / 超时 / 服务器错误重试 1 次，
// 控制屏未连接 503、无权限、ctrl 业务错误不重试）。只读；这一段没有写操作。
// 不发请求的情况（docs/分工.md 第 3 节第 6 条、plan S10a）：
// - 没有当前项目、项目离线（真实接口）、账号没有该路由的权限（can()，返回 forbidden）；
// - 210 另外要求：项目 app_code == 12（独立空气系统）、设备 id 有效（来自 202，恰好出现一次）、202 里该设备在线。
// 读数口径：
// - 202 每 15 秒轮询，210 每 30 秒；上一次返回后才排下一次，标签页不可见时 TanStack 默认暂停；
// - 最近一次读取是 503（控制屏未连接）时，之前的读数作废，返回 unavailable，不把旧数据当成当前值；
// - 210 回「该软件类型不支持此控制」是 unsupported（缓存成结果，不重试、不算故障）；
// - 每次读取取递增序号，写缓存时缓存里已有更新的读数就不覆盖（putNewer，同 thermostat/hooks.ts）；
//   useFreshRead 绑定发起时的会话代次，会话变了就丢弃结果。
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { ApiError, isApiError } from '@/api/errors'
import { queryKeys } from '@/api/query'
import { can } from '@/data/session'
import type { Project } from '@/data/org'
import { isStandalone } from '@/data/org/capabilities'
import { currentSessionKey } from '@/features/thermostat/writes'
import type { SettingsView, UnitView } from './model'
import { freshAirSource, type SettingsResult, type UnitsResult } from './source'

export const UNITS_POLL_MS = 15_000
export const SETTINGS_POLL_MS = 30_000
/** 网关按 permission_paths（/v1/... 路由模板）拦截；没有就不发请求 */
export const FRESH_ROUTES = { units: '/v1/ctrl/fresh-dehumidifier-get', settings: '/v1/ctrl/running-ctrl-get' } as const

type FreshProject = Pick<Project, 'id' | 'online' | 'programCode'>
type Kind = 'real' | 'mock'

const toApiError = (e: unknown) => (isApiError(e) ? e : new ApiError('server', e instanceof Error ? e.message : '加载失败', { cause: e }))

/** 是否可以读：有项目、有 id；真实接口还要求项目在线 */
export const canRead = (project: Pick<Project, 'id' | 'online'> | null, kind: Kind) =>
  !!project?.id && (kind === 'mock' || project.online === true)
/** 是否有 210（运行设置）：只有独立空气系统（app_code 12） */
export const hasSettings = (project: Pick<Project, 'programCode'> | null) => !!project && isStandalone(project)

const unitsKey = (kind: Kind, pid: string) => (kind === 'real' ? queryKeys.ctrl(202, pid) : (['freshAir-mock', 'units', pid] as const))
const settingsKey = (kind: Kind, pid: string, deviceId: number) =>
  kind === 'real' ? queryKeys.ctrl(210, pid, { deviceId }) : (['freshAir-mock', 'settings', pid, deviceId] as const)

// ---------------------------------------------------------------------------
// 读取序号

let readSeq = 0
const startedSeq = new Map<string, number>()
const nextSeq = (key: readonly unknown[]) => { const seq = ++readSeq; startedSeq.set(JSON.stringify(key), seq); return seq }
interface Seq { seq: number }
export const putNewer = <T extends Seq>(old: T | undefined, next: T) => (old && old.seq > next.seq ? old : next)

type UnitsData = UnitsResult & Seq
type SettingsData = SettingsResult & Seq

/** 最近一次读取失败且是 503：之前的数据作废 */
const unavailableNow = (q: { error: unknown; errorUpdatedAt: number; dataUpdatedAt: number }) =>
  isApiError(q.error) && q.error.kind === 'unavailable' && q.errorUpdatedAt >= q.dataUpdatedAt

// ---------------------------------------------------------------------------
// 202

export type UnitsView =
  | { kind: 'no-project' }
  /** 项目离线（不发请求） */
  | { kind: 'offline' }
  /** 账号没有 202 的权限（不发请求） */
  | { kind: 'forbidden' }
  | { kind: 'loading' }
  /** 控制屏未连接（503）。之前的数据作废 */
  | { kind: 'unavailable'; retry: () => void }
  /** 没有可显示的数据时失败 */
  | { kind: 'error'; error: ApiError; retry: () => void }
  | { kind: 'empty'; updatedAt: number }
  /** staleError：有数据时后台刷新失败（仍显示这份数据并提示） */
  | { kind: 'ready'; units: UnitView[]; updatedAt: number; staleError: ApiError | null; retry: () => void }

/** ctrl 202：当前项目的新风 / 除湿设备 */
export function useUnits(project: FreshProject | null): UnitsView {
  const src = freshAirSource()
  const pid = project?.id ?? ''
  const permitted = can(FRESH_ROUTES.units)
  const key = unitsKey(src.kind, pid)
  const q = useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<UnitsData> => { const seq = nextSeq(key); return { ...(await src.units(pid, signal)), seq } },
    enabled: canRead(project, src.kind) && permitted,
    staleTime: src.kind === 'real' ? 10_000 : Infinity,
    refetchInterval: src.kind === 'real' ? UNITS_POLL_MS : false,
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!project || !pid) return { kind: 'no-project' }
  if (!canRead(project, src.kind)) return { kind: 'offline' }
  if (!permitted) return { kind: 'forbidden' }
  if (unavailableNow(q)) return { kind: 'unavailable', retry }
  const err = q.error ? toApiError(q.error) : null
  if (!q.data) return err ? { kind: 'error', error: err, retry } : { kind: 'loading' }
  if (q.data.list.length === 0) return { kind: 'empty', updatedAt: q.dataUpdatedAt }
  return { kind: 'ready', units: q.data.list, updatedAt: q.dataUpdatedAt, staleError: err, retry }
}

// ---------------------------------------------------------------------------
// 210

export type SettingsState =
  | { kind: 'no-project' }
  | { kind: 'offline' }
  /** 项目不是独立空气系统（app_code != 12）：没有运行设置，不发 210 */
  | { kind: 'not-applicable' }
  /** 没有选中设备，或设备 id 无效 / 在 202 里重复：不发 210 */
  | { kind: 'no-device' }
  /** 202 里该设备未连接：不发 210，不显示旧设置 */
  | { kind: 'device-offline' }
  | { kind: 'forbidden' }
  | { kind: 'loading' }
  | { kind: 'unavailable'; retry: () => void }
  /** 控制屏回「该软件类型不支持此控制」：该项目不支持新风控制（不是故障） */
  | { kind: 'unsupported'; message: string; detail: string }
  | { kind: 'error'; error: ApiError; retry: () => void }
  | { kind: 'ready'; settings: SettingsView; updatedAt: number; staleError: ApiError | null; retry: () => void }

/** ctrl 210：当前选中设备的运行设置（只对 app_code 12、在线、id 有效的设备请求） */
export function useSettings(project: FreshProject | null, unit: Pick<UnitView, 'deviceId' | 'connected'> | null | undefined): SettingsState {
  const src = freshAirSource()
  const pid = project?.id ?? ''
  const deviceId = unit?.deviceId ?? null
  const permitted = can(FRESH_ROUTES.settings)
  const active = canRead(project, src.kind) && hasSettings(project) && deviceId !== null && unit?.connected === true
  const key = settingsKey(src.kind, pid, deviceId ?? 0)
  const q = useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<SettingsData> => { const seq = nextSeq(key); return { ...(await src.settings(pid, deviceId!, signal)), seq } },
    enabled: active && permitted,
    staleTime: src.kind === 'real' ? 10_000 : Infinity,
    refetchInterval: (query) => (src.kind === 'real' && query.state.data?.kind !== 'unsupported' ? SETTINGS_POLL_MS : false),
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!project || !pid) return { kind: 'no-project' }
  if (!canRead(project, src.kind)) return { kind: 'offline' }
  if (!hasSettings(project)) return { kind: 'not-applicable' }
  if (deviceId === null) return { kind: 'no-device' }
  if (unit?.connected !== true) return { kind: 'device-offline' }
  if (!permitted) return { kind: 'forbidden' }
  if (unavailableNow(q)) return { kind: 'unavailable', retry }
  const err = q.error ? toApiError(q.error) : null
  if (!q.data) return err ? { kind: 'error', error: err, retry } : { kind: 'loading' }
  if (q.data.kind === 'unsupported') return { kind: 'unsupported', message: q.data.message, detail: q.data.detail }
  return { kind: 'ready', settings: q.data.view, updatedAt: q.dataUpdatedAt, staleError: err, retry }
}

// ---------------------------------------------------------------------------
// 新读（S10c 的确认后预检、写后回读、核对用）

/** 一次新读的 210；apply 写进缓存（已有更新的读数、或会话已变时不写）；latest：这次仍是该设备最近发起的读取 */
export type FreshRead = SettingsResult & { apply: () => void; latest: () => boolean }

/**
 * 新读一次 210：先取消该设备在途的 210，再直接发一次新请求（不经缓存去重）。默认读到后写回缓存；
 * defer = true 只返回候选读数，由调用方认可后调 apply。绑定发起时的会话代次，会话变了或已中止就抛错丢弃。
 * 不检查项目在线和 app_code（调用方已判断）；设备 id 无效直接抛错，不发请求
 */
export function useFreshRead(project: Pick<Project, 'id'> | null) {
  const qc = useQueryClient()
  const pid = project?.id ?? ''
  return useCallback(async (deviceId: number | null, signal?: AbortSignal, opts: { defer?: boolean } = {}): Promise<FreshRead> => {
    if (!pid) throw new Error('没有当前项目')
    if (deviceId === null || !Number.isSafeInteger(deviceId) || deviceId <= 0) throw new Error('没有有效的新风设备 id')
    const session = currentSessionKey()
    const src = freshAirSource()
    const key = settingsKey(src.kind, pid, deviceId)
    await qc.cancelQueries({ queryKey: key, exact: true })
    const seq = nextSeq(key)
    const r = await src.settings(pid, deviceId, signal)
    if (signal?.aborted) throw new Error('读取已中止，结果已丢弃')
    if (currentSessionKey() !== session) throw new Error('读取期间登录状态已变化，结果已丢弃')
    const apply = () => {
      if (currentSessionKey() !== session) return
      qc.setQueryData<SettingsData>(key, (old) => putNewer(old, { ...r, seq }))
    }
    if (!opts.defer) apply()
    const latest = () => startedSeq.get(JSON.stringify(key)) === seq && !((qc.getQueryData<SettingsData>(key)?.seq ?? 0) > seq)
    return { ...r, apply, latest }
  }, [qc, pid])
}
