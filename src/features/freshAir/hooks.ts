// 新风页的数据 hooks（TanStack Query，沿用 S4 QueryClient 默认值：网络 / 超时 / 服务器错误重试 1 次，
// 控制屏未连接 503、无权限、ctrl 业务错误不重试）。只读；204 下发在 writes.ts（经 source.setRunning），这里只给确认后预检、
// 写后核对用的新读（useFreshPair：新读 202 + 210）。
// 不发请求的情况（docs/分工.md 第 3 节第 6 条、plan S10a）：
// - 没有当前项目、项目离线（真实接口）、账号没有该路由的权限（can()，返回 forbidden）；
// - 210 另外要求：项目 app_code == 12（独立空气系统）、设备 id 有效（来自 202，恰好出现一次）、202 里该设备在线。
// 读数口径：
// - 202 每 15 秒轮询，210 每 30 秒；上一次返回后才排下一次，标签页不可见时 TanStack 默认暂停；
// - 读取遇到 503（控制屏未连接）后，之前的读数作废：之后有更新的成功读取才显示，之间的 500 / 超时只显示错误；
// - 210 回「该软件类型不支持此控制」是 unsupported（缓存成结果，不重试、不算故障）；
// - 每次读取取递增序号，写缓存时缓存里已有更新的读数就不覆盖（putNewer，同 thermostat/hooks.ts）；
//   useFreshRead 绑定发起时的会话代次，会话变了就丢弃结果。
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { ApiError, isApiError } from '@/api/errors'
import { queryKeys } from '@/api/query'
import { isDeviceId } from '@/api/writeLock'
import { can } from '@/data/session'
import type { Project } from '@/data/org'
import { isStandalone } from '@/data/org/capabilities'
import { currentSessionKey } from '@/features/thermostat/writes'
import { SettingsMismatch, type Raw202, type Raw210, type SettingsView, type UnitView } from './model'
import { freshAirSource, type SettingsResult, type UnitsResult } from './source'

export const UNITS_POLL_MS = 15_000
export const SETTINGS_POLL_MS = 30_000
/** 网关按 permission_paths（/v1/... 路由模板）拦截；没有就不发请求 */
export const FRESH_ROUTES = { units: '/v1/ctrl/fresh-dehumidifier-get', settings: '/v1/ctrl/running-ctrl-get', write: '/v1/ctrl/running-ctrl-set' } as const

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

/**
 * 503 之后旧数据作废（同 src/data/sensors/hooks.ts 的请求序号方案，按项目记）：202、210 的读取遇到 503，记下该项目的失效序号；
 * 只有序号更大的成功结果才显示。之间遇到 500 / 超时 / ctrl 错误只显示错误，不恢复 503 之前的读数。
 * 控制屏是项目级的，所以 202 的 503 也让该项目的 210 读数作废，反过来一样。
 * 作废的读数不主动重读（S10b：持续 503 时 202、210 会互相作废、反复重读，页面一直停在「正在读取」）：
 * 项目最近一次结束的读取是 503（down）时，没有本查询自己的错误也显示 unavailable 占位，各自按正常轮询节奏重试
 */
const invalid = new Map<string, number>()
const invalidSeq = (pid: string) => invalid.get(pid) ?? 0
const valid = (pid: string, d: Seq | undefined): boolean => d !== undefined && d.seq > invalidSeq(pid)
/** 各项目最近一次成功读取的序号 */
const okSeq = new Map<string, number>()
/** 控制屏当前视为不可用：最近的 503 晚于最近的成功读取 */
const down = (pid: string) => invalidSeq(pid) > (okSeq.get(pid) ?? 0)
/** 发起一次读取：取序号；503 时记失效序号 */
async function runSeq<T>(key: readonly unknown[], pid: string, fn: () => Promise<T>): Promise<T & Seq> {
  const seq = nextSeq(key)
  try {
    const r = await fn()
    if (seq > (okSeq.get(pid) ?? 0)) okSeq.set(pid, seq)
    return { ...r, seq }
  } catch (e) {
    if (isApiError(e) && e.kind === 'unavailable' && seq > invalidSeq(pid)) invalid.set(pid, seq)
    throw e
  }
}
/** 仅供测试 */
export const __resetFreshAirForTests = () => { invalid.clear(); okSeq.clear(); startedSeq.clear() }

/**
 * 不能显示缓存时的状态：503 → unavailable；其他错误 → error；
 * 本查询没有错误但控制屏 down（别的读取 503 作废了读数，或重试中 TanStack 清掉了上次的错误）→ unavailable；还没有结果 → loading
 */
function noData(pid: string, err: ApiError | null, retry: () => void) {
  if (err?.kind === 'unavailable' || (!err && down(pid))) return { kind: 'unavailable', retry } as const
  return err ? ({ kind: 'error', error: err, retry } as const) : ({ kind: 'loading' } as const)
}

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

/** ctrl 202：当前项目的新风 / 除湿设备。paused：写锁核对在途期间暂停轮询（核对结束恢复） */
export function useUnits(project: FreshProject | null, paused = false): UnitsView {
  const src = freshAirSource()
  const pid = project?.id ?? ''
  const permitted = can(FRESH_ROUTES.units)
  const key = unitsKey(src.kind, pid)
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }): Promise<UnitsData> => runSeq(key, pid, () => src.units(pid, signal)),
    enabled: canRead(project, src.kind) && permitted,
    staleTime: src.kind === 'real' ? 10_000 : Infinity,
    refetchInterval: src.kind === 'real' && !paused ? UNITS_POLL_MS : false,
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!project || !pid) return { kind: 'no-project' }
  if (!canRead(project, src.kind)) return { kind: 'offline' }
  if (!permitted) return { kind: 'forbidden' }
  const err = q.error ? toApiError(q.error) : null
  if (!q.data || !valid(pid, q.data)) return noData(pid, err, retry)
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
  /** raw：这份设置对应的 210 原始回包（204 组装的兜底检查 blocked204 用） */
  | { kind: 'ready'; settings: SettingsView; raw: Raw210; updatedAt: number; staleError: ApiError | null; retry: () => void }

/** ctrl 210：当前选中设备的运行设置（只对 app_code 12、在线、id 有效的设备请求）。paused 同 useUnits */
export function useSettings(project: FreshProject | null, unit: Pick<UnitView, 'deviceId' | 'connected'> | null | undefined, paused = false): SettingsState {
  const src = freshAirSource()
  const pid = project?.id ?? ''
  const deviceId = unit?.deviceId ?? null
  const permitted = can(FRESH_ROUTES.settings)
  const active = canRead(project, src.kind) && hasSettings(project) && deviceId !== null && unit?.connected === true
  const key = settingsKey(src.kind, pid, deviceId ?? 0)
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }): Promise<SettingsData> => runSeq(key, pid, () => src.settings(pid, deviceId!, signal)),
    enabled: active && permitted,
    staleTime: src.kind === 'real' ? 10_000 : Infinity,
    refetchInterval: (query) => (src.kind === 'real' && !paused && query.state.data?.kind !== 'unsupported' ? SETTINGS_POLL_MS : false),
  })
  const qRefetch = q.refetch
  const retry = useCallback(() => { void qRefetch() }, [qRefetch])
  if (!project || !pid) return { kind: 'no-project' }
  if (!canRead(project, src.kind)) return { kind: 'offline' }
  if (!hasSettings(project)) return { kind: 'not-applicable' }
  if (deviceId === null) return { kind: 'no-device' }
  if (unit?.connected !== true) return { kind: 'device-offline' }
  if (!permitted) return { kind: 'forbidden' }
  const err = q.error ? toApiError(q.error) : null
  if (!q.data || !valid(pid, q.data)) return noData(pid, err, retry)
  if (q.data.kind === 'unsupported') return { kind: 'unsupported', message: q.data.message, detail: q.data.detail }
  return { kind: 'ready', settings: q.data.view, raw: q.data.raw, updatedAt: q.dataUpdatedAt, staleError: err, retry }
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
    if (!isDeviceId(deviceId)) throw new Error('没有有效的新风设备 id')
    const session = currentSessionKey()
    const src = freshAirSource()
    const key = settingsKey(src.kind, pid, deviceId)
    await qc.cancelQueries({ queryKey: key, exact: true })
    const { seq, ...r } = await runSeq(key, pid, () => src.settings(pid, deviceId, signal))
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

/** 一次新读的 202（同 FreshRead） */
export type FreshUnits = UnitsResult & { apply: () => void; latest: () => boolean }

/** 新读一次 202（同 useFreshRead 的做法：先取消在途、直接发新请求、按序号写缓存、绑定会话；defer 只返回候选） */
export function useFreshUnits(project: Pick<Project, 'id'> | null) {
  const qc = useQueryClient()
  const pid = project?.id ?? ''
  return useCallback(async (signal?: AbortSignal, opts: { defer?: boolean } = {}): Promise<FreshUnits> => {
    if (!pid) throw new Error('没有当前项目')
    const session = currentSessionKey()
    const src = freshAirSource()
    const key = unitsKey(src.kind, pid)
    await qc.cancelQueries({ queryKey: key, exact: true })
    const { seq, ...r } = await runSeq(key, pid, () => src.units(pid, signal))
    if (signal?.aborted) throw new Error('读取已中止，结果已丢弃')
    if (currentSessionKey() !== session) throw new Error('读取期间登录状态已变化，结果已丢弃')
    const apply = () => {
      if (currentSessionKey() !== session) return
      qc.setQueryData<UnitsData>(key, (old) => putNewer(old, { ...r, seq }))
    }
    if (!opts.defer) apply()
    const latest = () => startedSeq.get(JSON.stringify(key)) === seq && !((qc.getQueryData<UnitsData>(key)?.seq ?? 0) > seq)
    return { ...r, apply, latest }
  }, [qc, pid])
}

/** 210 回包的 id 与请求的设备 id 不符（source.ts 的 settingsOf 抛出的 ApiError，cause 是 SettingsMismatch） */
export const isSettingsMismatch = (e: unknown) => isApiError(e) && e.kind === 'ctrl' && (e as { cause?: unknown }).cause instanceof SettingsMismatch

/**
 * 下发用的一次新读：202（设备在不在、出现几次、在不在线）+ 210（运行设置）。
 * settings 为 null：210 回包 id 与设备不符（含空回包），由调用方按「没有读数」处理（预检不发、核对记无法核对）；
 * 其他读取错误照常抛出（预检不发、核对记结果未知）。apply / latest 同时作用于两份读数
 */
export interface FreshPair { units: Raw202; unitList: UnitView[]; settings: SettingsResult | null; apply: () => void; latest: () => boolean }
export function useFreshPair(project: Pick<Project, 'id'> | null) {
  const units = useFreshUnits(project)
  const settings = useFreshRead(project)
  return useCallback(async (deviceId: number | null, signal?: AbortSignal, opts: { defer?: boolean } = {}): Promise<FreshPair> => {
    const u = await units(signal, opts)
    let s: FreshRead | null = null
    try { s = await settings(deviceId, signal, opts) } catch (e) { if (!isSettingsMismatch(e)) throw e }
    const result: SettingsResult | null = !s ? null : s.kind === 'ok' ? { kind: 'ok', view: s.view, raw: s.raw } : { kind: 'unsupported', message: s.message, detail: s.detail }
    return {
      units: u.raw,
      unitList: u.list,
      settings: result,
      apply: () => { u.apply(); s?.apply() },
      latest: () => u.latest() && (s ? s.latest() : true),
    }
  }, [units, settings])
}

/** 重新读当前项目的 202 和 210（写锁到期强制重读、锁放开后用；只重读启用中的查询） */
export function useRefetchFreshAir(project: Pick<Project, 'id'> | null) {
  const qc = useQueryClient()
  const pid = project?.id ?? ''
  return useCallback(() => {
    if (!pid) return
    const real = freshAirSource().kind === 'real'
    void qc.refetchQueries({ queryKey: real ? ['ctrl', 202, pid] : ['freshAir-mock', 'units', pid] })
    void qc.refetchQueries({ queryKey: real ? ['ctrl', 210, pid] : ['freshAir-mock', 'settings', pid] })
  }, [qc, pid])
}
