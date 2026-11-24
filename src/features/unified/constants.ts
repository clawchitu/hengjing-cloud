// 统一控制（ctrl 203 UnifiedCtrlSet）的常量与文案。依据 docs/plan-v1.md S12、文末后端答复，
// docs/api/ctrl同步消息200-210.md 4.4。
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'

/**
 * 设定温度范围（°C）。后端以后会在接口里给设定范围字段，缺失时回退到这里（负责人 11/24 09:49）。
 * 见 resolveTempRange()。
 */
export const TEMP_MIN = 16
export const TEMP_MAX = 30
export const TEMP_STEP = 0.5

export interface TempRange { min: number; max: number; step: number }
export const DEFAULT_TEMP_RANGE: Readonly<TempRange> = Object.freeze({ min: TEMP_MIN, max: TEMP_MAX, step: TEMP_STEP })

/** 应用类型（项目的 app_code） */
export const APP_CODE = {
  /** 通用版：温度设定可用 */
  GENERAL: 1,
  /** 空气系统单机版：温度设定不可用 */
  AIR_STANDALONE: 8,
  /** 独立空气系统：温度设定不可用，房间开关仍可用（Q6①） */
  AIR_INDEPENDENT: 12,
} as const

/** 温度设定可用的 app_code（白名单；没列出的一律不可用，宁可少开不误开） */
export const TEMP_ENABLED_APP_CODES: readonly number[] = [APP_CODE.GENERAL]
/** 明确禁用温度设定的 app_code（文案不同于「未知应用类型」） */
export const TEMP_DISABLED_APP_CODES: readonly number[] = [APP_CODE.AIR_STANDALONE, APP_CODE.AIR_INDEPENDENT]

/** 开关取值（203 的 system_switch / room_switch）：-1 不变由组装函数填，这里只给可选值 */
export const SWITCH_ON = 1
export const SWITCH_OFF = 0
export type SwitchValue = typeof SWITCH_ON | typeof SWITCH_OFF

/** 运行模式选项（不含 0「不变」）。Q6③ 还没答复开放哪些，先列全部 14 个 */
export const MODE_OPTIONS: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: Mode.OPERATION_MODE_SUMMER, label: '夏季模式' },
  { value: Mode.OPERATION_MODE_WINTER, label: '冬季模式' },
  { value: Mode.OPERATION_MODE_VENTILATION, label: '通风模式' },
  { value: Mode.OPERATION_MODE_DEHUMIDIFY, label: '除湿' },
  { value: Mode.OPERATION_MODE_FREE_COOLING, label: '免费制冷模式' },
  { value: Mode.OPERATION_MODE_HEATING_DEHUMIDIFY, label: '制热除湿模式' },
  { value: Mode.OPERATION_MODE_HEATING, label: '供热模式' },
  { value: Mode.OPERATION_MODE_HEATING_HUMIDIFY, label: '供热加湿模式' },
  { value: Mode.OPERATION_MODE_HUMIDIFY, label: '加湿模式' },
  { value: Mode.OPERATION_MODE_REFRIGERATION, label: '供冷模式' },
  { value: Mode.OPERATION_MODE_REFRIGERATION_HUMIDIFY, label: '供冷加湿模式' },
  { value: Mode.OPERATION_MODE_REFRIGERATION_DEHUMIDIFY, label: '供冷除湿模式' },
  { value: Mode.OPERATION_MODE_REFRIGERATION_HEATING, label: '冷热过度模式' },
  { value: Mode.OPERATION_MODE_AUTO, label: '自动模式' },
]

/** 页面文案 */
export const TEXT = {
  title: '统一控制',
  systemSwitch: '系统开关',
  systemMode: '运行模式',
  roomSwitch: '房间开关',
  roomTemp: '房间温度',
  on: '开启',
  off: '关闭',
  unchanged: '不变',
  tempUnit: '°C',
  confirmTitle: '确认下发',
  confirmBody: (projectName: string) => `将对项目「${projectName}」下发以下设置：`,
  confirmOk: '确认下发',
  confirmCancel: '取消',
  sending: '正在下发…',
  success: '下发成功，已生效',
  failure: '下发失败',
  retryHint: '未自动重试，请核对设备状态后再决定是否重新下发',
  // 校验
  noProject: '未选择项目',
  offline: '项目离线，不能下发',
  noChanges: '没有要下发的设置',
  tempDisabledByApp: '该应用类型不支持温度设定',
  tempDisabledUnknownApp: '应用类型未知，温度设定不可用',
  tempNotNumber: '设定温度无效',
  tempOutOfRange: (r: TempRange) => `设定温度须在 ${r.min}–${r.max}°C 之间`,
  tempBadStep: (r: TempRange) => `设定温度须按 ${r.step}°C 步进`,
  tempWhileRoomOff: '关闭房间时不能同时设定温度',
  badSwitch: (label: string) => `${label}取值无效`,
  badMode: '运行模式无效',
  projectChanged: '当前项目已变化，请重新确认',
  readBeforeFailed: '下发前读取当前状态失败，未下发',
  readAfterFailed: '下发已生效，但回读失败，请稍后刷新核对',
  readAfterFailedUnknown: '下发后回读失败，请稍后刷新核对',
  echoMismatch: '回读结果与下发值不一致，请核对',
  verifyFailed: '核对出错',
  echoMissing: (label: string) => `${label}未回读到`,
  echoDiffer: (label: string, sent: string, got: string) => `${label}下发 ${sent}，回读 ${got}`,
} as const
