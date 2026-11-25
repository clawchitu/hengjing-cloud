// 新风页的视图模型（S10a）：ctrl 202（新风 / 除湿机状态）的一条 → UnitView；ctrl 210（运行控制参数）→ SettingsView。
// 依据：docs/api/ctrlcb.proto、docs/api/实测记录-1125-新风天气.md、docs/plan-s10-s7.md「S10a」与 2.3、后端 11/25 答复。
// - 0 是有效读数（proto3 标量为 0 时线上省略，解码为 0；后端答复第 9 条）；-100 是无效值；65536 是未初始化（无数据）；
// - 210 读到 -1：这一项不能设置（后端答复第 5 条），前端禁用这一项；control_type = -1（露点与湿度均不可控）时，
//   控制类型、露点设定、湿度设定三项不能设置（与 src/api/writeLockVerify.ts 的 settable204 一致），并且整个写入口禁用
//   （S10a 任务要求，比 plan 2.3「风速、开关照常」更严，见 docs/使用说明-规则草稿-chitu.md S10 节）；
// - 滤网两个字段的口径只在 ./filter.ts 的 filterOf 里定（filter_life 天数，filter_life_p 0–1 比例）；
// - 设备 id 只从 202 取。202 里 id 不是正整数、或同一 id 出现多次的条目，deviceId 记为 null（不能拿去读 210）。
// 这一段没有写函数，也不组装 204。
import type { CtrlReply } from '@/api/ctrl'
import { INVALID_HOURLY, NO_DATA, reading, UNCHANGED } from '@/api/values'
import { isDeviceId } from '@/api/writeLock'
import { BLOCK_204_CONTROL_TYPE, BLOCK_204_NOT_SETTABLE, FIELDS_204, type Field204 } from '@/api/writeLockVerify'
import { filterOf, type FilterView } from './filter'

export type Raw202 = Pick<CtrlReply<202>, 'data'>
export type RawUnit = CtrlReply<202>['data'][number]
export type Raw210 = Partial<CtrlReply<210>>

/** 210 的控制类型（proto 注释）：1 露点控制，0 湿度控制（-1 露点与湿度均不可控，按「不可设置」处理） */
export const CONTROL_TYPES: Readonly<Record<number, string>> = Object.freeze({ 0: '湿度控制', 1: '露点控制' })
/** 210 的设定风速（proto 注释）：0 低，1 高，2 自动。和 200 的 1–99 档 / 100 自动不是同一套（待后端第 15 条） */
export const WIND_SPEEDS_210: Readonly<Record<number, string>> = Object.freeze({ 0: '低', 1: '高', 2: '自动' })
/** 210 的开关：1 开，0 关 */
export const SWITCHES_210: Readonly<Record<number, string>> = Object.freeze({ 0: '关', 1: '开' })

/** 设定范围和步长（方案 A3，待后端确认；S10c 用）。界面上不写「范围」这行字 */
export const LIMITS = Object.freeze({
  dewPoint: Object.freeze({ min: 8, max: 16, step: 0.5 }),
  humiditySet: Object.freeze({ min: 35, max: 70, step: 1 }),
})

// ---------------------------------------------------------------------------
// 202 → UnitView

export interface UnitView {
  /** React 用的键：deviceId 的字符串；deviceId 为 null 时用条目序号（`#0`） */
  key: string
  /** 202 的设备 id（读 210、S10c 下发 204 用）；不是正整数或在回包里重复出现为 null */
  deviceId: number | null
  name: string
  /** 送风 / 回风温度；无数据为 null */
  supplyTemp: number | null
  returnTemp: number | null
  /** 风速档位（取值含义待后端，A6，显示原数字） */
  windLevel: number | null
  /** 风机转速 */
  fanSpeed: number | null
  /** 压缩机状态：0 停止、1 运行、其他原数字（A6） */
  compressorStatus: number | null
  /** 压缩机频率 */
  compressorFreq: number | null
  filter: FilterView
  /** 滤网运行时间、运行时间（单位待后端，A5，只显示数字） */
  filterRunning: number | null
  runningTime: number | null
  /** 运行模式文案；没有为空串 */
  runningMode: string
  /** 开关：只有 switch === 1 才算开 */
  on: boolean
  /** 202 的 is_connected；缺省 false */
  connected: boolean
}

/** 计量类读数：65536、-100、非有限数 → null；0 有效 */
const num = (v: unknown): number | null => (typeof v === 'number' ? reading(v) : null)

/** 202 回包 → 设备列表（保持回包顺序） */
export function toUnitViews(raw: Partial<Raw202> | null | undefined): UnitView[] {
  const list = raw?.data ?? []
  const count = new Map<number, number>()
  for (const u of list) if (isDeviceId(u.id)) count.set(u.id, (count.get(u.id) ?? 0) + 1)
  return list.map((u, i) => {
    const deviceId = isDeviceId(u.id) && count.get(u.id) === 1 ? u.id : null
    return {
      key: deviceId === null ? `#${i}` : String(deviceId),
      deviceId,
      name: u.name ?? '',
      supplyTemp: num(u.supplyTemp),
      returnTemp: num(u.returnTemp),
      windLevel: num(u.windLevel),
      fanSpeed: num(u.windSpeed),
      compressorStatus: num(u.dehumidifierStatus),
      compressorFreq: num(u.dehumidifierFreq),
      filter: filterOf(u),
      filterRunning: num(u.filterRunning),
      runningTime: num(u.runningTime),
      runningMode: u.runningMode ?? '',
      on: u.switch === 1,
      connected: u.isConnected === true,
    }
  })
}

// ---------------------------------------------------------------------------
// 210 → SettingsView

/**
 * 210 每个可设置字段的标注（给 S10b 界面用）：
 * - settable：可以设置，value 是读数（0 有效）；
 * - unsettable：读到 -1（或因 control_type = -1 连带不能设置），value 为 null，界面禁用这一项、显示 --；
 * - invalid：-100、65536、非有限数、枚举外的值，value 为 null，显示 --。
 */
export type FieldState = 'settable' | 'unsettable' | 'invalid'
export interface SettingField { state: FieldState; value: number | null }

export interface SettingsView {
  deviceId: number
  name: string
  fields: Record<Field204, SettingField>
  /** 是否可以更改控制类型（can_change，缺省 false） */
  canChange: boolean
  /** 整个写入口禁用的原因；null 表示写入口可用（逐项仍按 fields 的 state 禁用） */
  writeBlock: string | null
}

const ENUMS: Partial<Record<Field204, Readonly<Record<number, string>>>> = { controlType: CONTROL_TYPES, windSpeed: WIND_SPEEDS_210, switch: SWITCHES_210 }

/** 单个字段：-1 → unsettable；-100、65536、非有限数、枚举外 → invalid；其余 settable */
export function fieldOf(f: Field204, v: unknown): SettingField {
  const n = typeof v === 'number' ? v : 0 // proto3 缺省 = 0（真实读数）
  if (n === UNCHANGED) return { state: 'unsettable', value: null }
  if (!Number.isFinite(n) || n === NO_DATA || n === INVALID_HOURLY) return { state: 'invalid', value: null }
  const e = ENUMS[f]
  if (e && !(n in e)) return { state: 'invalid', value: null }
  return { state: 'settable', value: n }
}

/** 字段被禁用时的原因（null = 可设置）。文案沿用 writeLockVerify.ts，S10b / S10c 共用 */
export function fieldBlock(s: SettingsView, f: Field204): string | null {
  if (s.writeBlock) return s.writeBlock
  const x = s.fields[f]
  if (x.state === 'settable') return null
  return x.state === 'unsettable' ? BLOCK_204_NOT_SETTABLE : '该设备的这一项没有有效读数，不能设置'
}

/**
 * 210 回包 → 运行设置。回包的 id 必须等于请求的 deviceId（空回包、只有错误文案的回包解码后 id 为 0），
 * 不符抛 SettingsMismatch，由 hooks 归为错误，不当成读数。
 */
export class SettingsMismatch extends Error {
  readonly expected: number
  readonly got: number | undefined
  constructor(expected: number, got: number | undefined) {
    super('读到的运行设置不属于这台新风设备')
    this.name = 'SettingsMismatch'
    this.expected = expected
    this.got = got
  }
}

export function toSettingsView(raw: Raw210 | null | undefined, deviceId: number): SettingsView {
  if (!raw || !isDeviceId(deviceId) || raw.id !== deviceId) throw new SettingsMismatch(deviceId, raw?.id)
  const fields = Object.fromEntries(FIELDS_204.map((f) => [f, fieldOf(f, raw[f])])) as Record<Field204, SettingField>
  const ct = fields.controlType
  // control_type = -1：控制类型、露点、湿度连带不能设置（同 settable204）
  if (ct.state === 'unsettable') {
    fields.dewPoint = { state: 'unsettable', value: null }
    fields.humiditySet = { state: 'unsettable', value: null }
  }
  const writeBlock = ct.state === 'unsettable' ? BLOCK_204_CONTROL_TYPE
    : ct.state === 'invalid' ? '该设备的控制类型读数无效，不能设置'
    : null
  return { deviceId, name: raw.name ?? '', fields, canChange: raw.canChange === true, writeBlock }
}

// ---------------------------------------------------------------------------
// 210 的业务错误

/** 210 的「不支持」文案（11/25 实测 240829001，app_code 1）：该软件类型不支持此控制 */
export const UNSUPPORTED_210 = /不支持此控制/
export const TEXT_UNSUPPORTED = '该项目不支持新风控制'
