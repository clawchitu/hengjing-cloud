// 新风运行设置（204）接入共用写锁（src/api/writeLock.ts）的核对部分：持久化的核对数据，以及用 210 + 202 的新读比对
// （src/api/writeLockVerify.ts 的 matchRunningCtrl）。读取走当前数据源（真实接口为 ctrl 202、210，演示数据为内存）。
// 核对口径（docs/plan-s10-s7.md S10c、P0；后端 11/25 答复）：
// - 只比对用户改了的字段（record204 的 target 里不是 -1 的项：control_type、dew_point、humidity_set、wind_speed、switch），
//   没改的字段不看——control_type = -1 的设备改风速 / 开关后，露点、湿度回读必然是 -1，不能拿它们判结论；
// - 210 读到 -1 / 65536（含 -100、非有限数）判无法核对；0 是有效读数，直接比对；回包 id 与设备不符（含空回包、「不支持」）全部无法核对；
// - 210 没有 is_connected：设备是否在线由同一次核对新读的 202 判断。目标设备 id 在 202 原始回包里必须恰好出现一次：
//   缺失或重复 → 改了的字段全部无法核对；出现一次但未连接 → 结果未知（matchRunningCtrl 的 connected）。
// 核对器由 src/app/writeLockSetup.ts 的 registerFreshAirVerifiersOnce 注册，这里不注册。
import type { WriteQuery } from '@/api/ctrl'
import { isDeviceId, type MatchDetail, type SentRecord, type StoredLock } from '@/api/writeLock'
import { isNoChange, matchRunningCtrl } from '@/api/writeLockVerify'
import type { Raw202, Raw210 } from './model'
import { isSettingsMismatch } from './hooks'
import { freshAirSource, type SettingsResult } from './source'

/** 204 的核对数据：设备 id 与五个可写字段（-1 = 不改，比对时跳过） */
export const record204 = (q: WriteQuery<204>): SentRecord => ({
  msg: 204,
  deviceId: q.id,
  target: { controlType: q.controlType, dewPoint: q.dewPoint, humiditySet: q.humiditySet, windSpeed: q.windSpeed, switch: q.switch },
})

/** 核对只用到 202 每条的 id 和 is_connected */
export type Units202 = { data?: ReadonlyArray<Pick<Raw202['data'][number], 'id'> & Partial<Pick<Raw202['data'][number], 'isConnected'>>> }
/** 核对用的一次读数：202 原始回包 + 210 原始回包（null = 210 回包 id 不符、空回包或「不支持」） */
export interface Verify204Read { units: Units202; settings: Raw210 | null }

/** 目标设备 id 在 202 原始回包里出现的次数 */
export const unitCount = (units: Units202, deviceId: number) => (units.data ?? []).filter((u) => u.id === deviceId).length

/** 204 写后核对（见文件头）。核对数据本身不对（消息号、设备 id、没有改动）返回 false */
export function match204(rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target'>, read: Verify204Read): MatchDetail | false {
  if (rec.msg !== 204 || !isDeviceId(rec.deviceId)) return false
  const id = rec.deviceId
  const n = unitCount(read.units, id)
  if (n !== 1) {
    const changed = Object.entries(rec.target).filter(([k, v]) => !isNoChange(204, k, v)).map(([k]) => k)
    if (!changed.length) return false
    return { verdict: 'unverifiable', fields: Object.fromEntries(changed.map((k) => [k, 'unverifiable' as const])) }
  }
  const unit = (read.units.data ?? []).find((u) => u.id === id)!
  return matchRunningCtrl(rec, read.settings, { connected: unit.isConnected === true })
}

/** SettingsResult → 核对用的 210 原始读数（「不支持」→ null） */
export const reading210 = (r: SettingsResult | null | undefined): Raw210 | null => (r?.kind === 'ok' ? r.raw : null)

/** 新读一次 202 + 210（不经查询缓存；刷新恢复的锁核对用）。210 回包 id 不符按 null，其他读取错误照常抛出（写锁记结果未知） */
export async function read204(projectId: string, deviceId: number, signal?: AbortSignal): Promise<Verify204Read> {
  const src = freshAirSource()
  const units = (await src.units(projectId, signal)).raw
  let settings: SettingsResult | null = null
  try { settings = await src.settings(projectId, deviceId, signal) } catch (e) { if (!isSettingsMismatch(e)) throw e }
  return { units, settings: reading210(settings) }
}

/** 204 的核对函数（刷新恢复、「核对」按钮在没有本次下发的核对函数时用） */
export const verifier204 = async (rec: StoredLock, signal: AbortSignal) =>
  (isDeviceId(rec.deviceId) ? match204(rec, await read204(rec.projectId, rec.deviceId, signal)) : false)
