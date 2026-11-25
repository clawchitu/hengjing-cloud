// 新风页的两个数据源，接口相同，按运行时配置 dataSource 选择（同 src/features/thermostat/source.ts）：
// - real：ctrl 202、210 走 callCtrl()（只读，callCtrl 拒绝写消息号）；project_id 用项目的后端实体 id；
// - mock：演示数据映射成同一套视图模型，同时给出 202、210 形状的原始读数（S10c 核对用）。
// 写：只有 setRunning（ctrl 204），真实接口只走 S4 的统一写入口 writeCtrl(204)（requestWrite → guard.ts 写防护，白名单按项目 code，
// 请求体用 id，不重试）；演示数据只改内存里的演示数据，不发任何请求。交付包（__HJC_MOCK__ = false）里恒为 real。
import * as api from '@/api'
import { callCtrl, writeCtrl, type WriteQuery } from '@/api/ctrl'
import { isMockMode } from '@/api/config'
import { ApiError, isApiError } from '@/api/errors'
import type { WriteProject } from '@/api/guard'
import { DEW_MODES } from '@/data/constants'
import { SettingsMismatch, TEXT_UNSUPPORTED, toSettingsView, toUnitViews, UNSUPPORTED_210, type Raw202, type Raw210, type SettingsView, type UnitView } from './model'

export interface UnitsResult { list: UnitView[]; raw: Raw202 }
/** 210 的结果：读到设置，或控制屏回「不支持」（不是故障，界面显示「该项目不支持新风控制」） */
export type SettingsResult =
  | { kind: 'ok'; view: SettingsView; raw: Raw210 }
  | { kind: 'unsupported'; message: string; detail: string }

export interface FreshAirSource {
  readonly kind: 'real' | 'mock'
  /** ctrl 202：新风 / 除湿设备列表 */
  units(projectId: string, signal?: AbortSignal): Promise<UnitsResult>
  /** ctrl 210：一台设备的运行控制参数。deviceId 来自 202 */
  settings(projectId: string, deviceId: number, signal?: AbortSignal): Promise<SettingsResult>
  /**
   * ctrl 204：运行设置下发。query 必须由 edit.ts 的 build204（buildRunningCtrlSet）组装。resolve 即 Reply success=true
   * （只算已下发，生效以 210 回读为准）；失败一律 reject。beforeSend 交给写入口，在 fetch 前同步调用，返回 false 就不发
   */
  setRunning(project: WriteProject, query: WriteQuery<204>, beforeSend?: () => boolean): Promise<void>
}

/**
 * 210 回包 → 结果：
 * - callCtrl 已把「只有 #2 文案」的回包抛成 ApiError('ctrl')；文案是「…不支持此控制」的归为 unsupported；
 * - 其他 ctrl 文案、HTTP 错误照常抛出；
 * - 回包 id 与请求的 deviceId 不符（含空回包）抛 ApiError('ctrl')，不当成读数。
 */
export async function settingsOf(read: () => Promise<Raw210>, deviceId: number): Promise<SettingsResult> {
  let raw: Raw210
  try {
    raw = await read()
  } catch (e) {
    if (isApiError(e) && e.kind === 'ctrl' && UNSUPPORTED_210.test(e.message)) return { kind: 'unsupported', message: TEXT_UNSUPPORTED, detail: e.message }
    throw e
  }
  try {
    return { kind: 'ok', view: toSettingsView(raw, deviceId), raw }
  } catch (e) {
    if (e instanceof SettingsMismatch) throw new ApiError('ctrl', e.message, { cause: e })
    throw e
  }
}

export const realFreshAirSource: FreshAirSource = {
  kind: 'real',
  units: async (projectId, signal) => {
    const raw = await callCtrl(202, projectId, {}, { signal })
    return { list: toUnitViews(raw), raw }
  },
  settings: (projectId, deviceId, signal) => settingsOf(() => callCtrl(210, projectId, { deviceId }, { signal }), deviceId),
  // writeCtrl 在 Reply success 不为 true 时抛 ApiError('ctrl')，这里不需要再判断
  setRunning: async (project, query, beforeSend) => { await writeCtrl(204, project, query, { beforeSend }) },
}

// ---------------------------------------------------------------------------
// mock：演示数据 → 202 / 210 的形状

const FAN_LEVEL: Record<string, number> = { 低: 1, 中: 2, 高: 3 }
/** 210 只有 低 / 高 / 自动；演示数据的「中」在 210 里没有对应值，按无效读数（-100） */
const FAN_210: Record<string, number> = { 低: 0, 高: 1, 自动: 2 }
const FAN_OF_210: Record<number, api.FreshAir['fan']> = { 0: '低', 1: '高', 2: '自动' }
/** 演示设备的设备 id：按列表序号（FA-01、DH-01 的数字部分会重复，不能用） */
const mockDeviceId = (i: number) => i + 1

export function mock202(list: readonly api.FreshAir[]): Raw202 {
  return {
    data: list.map((f, i) => ({
      id: mockDeviceId(i),
      name: f.name,
      supplyTemp: f.supplyTemp,
      returnTemp: f.returnTemp,
      windLevel: FAN_LEVEL[f.fan] ?? 0,
      windSpeed: f.rpm,
      dehumidifierStatus: f.compressor ? 1 : 0,
      dehumidifierFreq: f.hz,
      filterLife: f.filterDays,
      filterLifeP: f.filter / 100,
      filterRunning: f.filterHours,
      runningMode: f.on ? '运行' : '',
      runningTime: 0,
      switch: f.on ? 1 : 0,
      isConnected: true,
    })),
  }
}

export function mock210(f: api.FreshAir, deviceId: number): Raw210 {
  return {
    id: deviceId,
    name: f.name,
    controlType: f.control === 'dew' ? 1 : 0,
    dewPoint: f.dewSet,
    humiditySet: f.humSet,
    windSpeed: FAN_210[f.fan] ?? -100,
    switch: f.on ? 1 : 0,
    canChange: DEW_MODES.includes(f.mode),
  }
}

/** 演示数据也按写入口的约定在「发出」前同步调用 beforeSend，不通过就不改数据（同 thermostat/source.ts） */
function mockBeforeSend(beforeSend?: () => boolean) {
  let ok = false
  try { ok = beforeSend ? beforeSend() === true : true } catch { ok = false }
  if (!ok) throw new ApiError('write_blocked', '发送前复核未通过，未下发')
}

/** 204 Query → 演示数据的改动（-1 = 不变） */
export function mockPatch204(q: WriteQuery<204>): Partial<api.FreshAir> {
  const p: Partial<api.FreshAir> = {}
  if (q.controlType !== -1) p.control = q.controlType === 1 ? 'dew' : 'hum'
  if (q.dewPoint !== -1) p.dewSet = q.dewPoint
  if (q.humiditySet !== -1) p.humSet = q.humiditySet
  if (q.windSpeed !== -1 && FAN_OF_210[q.windSpeed]) p.fan = FAN_OF_210[q.windSpeed]
  if (q.switch !== -1) { p.on = q.switch === 1; p.status = q.switch === 1 ? 'run' : 'off' }
  return p
}

const mockFreshAirSource: FreshAirSource = {
  kind: 'mock',
  units: async (projectId) => {
    const raw = mock202(await api.getFreshAir(projectId))
    return { list: toUnitViews(raw), raw }
  },
  settings: async (projectId, deviceId) => {
    const list = await api.getFreshAir(projectId)
    return settingsOf(async () => {
      const f = list[deviceId - 1]
      return f ? mock210(f, deviceId) : {}
    }, deviceId)
  },
  setRunning: async (project, q, beforeSend) => {
    mockBeforeSend(beforeSend)
    const f = (await api.getFreshAir(project.id))[q.id - 1]
    if (!f) throw new Error('演示数据里没有这台新风设备')
    await api.applyFreshAir(project.id, f.id, mockPatch204(q))
  },
}

/** 当前数据源：演示数据模式用 mock，否则（含交付包）一律 real */
export const freshAirSource = (): FreshAirSource => (__HJC_MOCK__ && isMockMode() ? mockFreshAirSource : realFreshAirSource)
