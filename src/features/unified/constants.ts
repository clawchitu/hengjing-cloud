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

/** 运行模式选项（不含 0「不变」）。Q6③ 还没答复开放哪些，先列全部 14 个。
 * 名称去掉末尾「模式」二字，按钮里不换行（S13 走查 C）；13 是「冷热过渡」，proto 注释写的「过度」是错字（S13 走查 P8） */
export const MODE_OPTIONS: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: Mode.OPERATION_MODE_SUMMER, label: '夏季' },
  { value: Mode.OPERATION_MODE_WINTER, label: '冬季' },
  { value: Mode.OPERATION_MODE_VENTILATION, label: '通风' },
  { value: Mode.OPERATION_MODE_DEHUMIDIFY, label: '除湿' },
  { value: Mode.OPERATION_MODE_FREE_COOLING, label: '免费制冷' },
  { value: Mode.OPERATION_MODE_HEATING_DEHUMIDIFY, label: '制热除湿' },
  { value: Mode.OPERATION_MODE_HEATING, label: '供热' },
  { value: Mode.OPERATION_MODE_HEATING_HUMIDIFY, label: '供热加湿' },
  { value: Mode.OPERATION_MODE_HUMIDIFY, label: '加湿' },
  { value: Mode.OPERATION_MODE_REFRIGERATION, label: '供冷' },
  { value: Mode.OPERATION_MODE_REFRIGERATION_HUMIDIFY, label: '供冷加湿' },
  { value: Mode.OPERATION_MODE_REFRIGERATION_DEHUMIDIFY, label: '供冷除湿' },
  { value: Mode.OPERATION_MODE_REFRIGERATION_HEATING, label: '冷热过渡' },
  { value: Mode.OPERATION_MODE_AUTO, label: '自动' },
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
  /** 下发结果口径（Fable 11/24 裁定）：控制屏 success=true 只算「已下发」，以回读为准 */
  verifying: '已下发，正在核对…',
  success: '已生效',
  unapplied: '指令已下发，设备状态暂未变化',
  sentUnknown: '已下发，结果未知',
  roomsOffline: '下发后回读时有房间离线，读数不可信，请稍后刷新确认',
  unverifiable: '该项暂无回读，无法确认',
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
  /** 温度设定的提示（后端 11/25 答复第 16 条）：房间关着时温度也会生效，房间开启后按此温度运行 */
  tempWhenRoomOn: '房间开启后生效',
  tempOffNote: '设置温度不会开启房间，房间开启后按此温度运行',
  /** 房间开关未上报（features.roomSwitchReported = false）期间，开关类下发固定判无法核对，写锁要到 2 分钟有效期才放 */
  // 「2 分钟」对应写锁默认有效期 DEFAULT_TTL_MS；改了 configureWriteLock 的 ttlMs 要同步这句
  switchUnreported: '设备暂不回报开关状态，2 分钟后可再次操作',
  badSwitch: (label: string) => `${label}取值无效`,
  badMode: '运行模式无效',
  projectChanged: '当前项目已变化，请重新确认',
  aborted: '已离开页面或切换项目，未下发',
  /** 应答结果未知（超时、断网等）：请求已发出，统一按「已下发，结果未知」 */
  unconfirmed: '已下发，结果未知，请刷新查看',
  verified: '已核对',
  readBeforeFailed: '下发前读取当前状态失败，未下发',
  readAfterFailedUnknown: '下发后回读失败，请稍后刷新核对',
  echoMismatch: '回读结果与下发值不一致，请核对',
  echoMissing: (label: string) => `${label}设备未回报，无法核对`,
  echoUnreadable: (label: string) => `${label}无法回读（未核对）`,
  echoPart: (total: number, bad: number) => `（${total} 个房间中 ${bad} 个）`,
  echoDiffer: (label: string, sent: string, got: string) => `${label}下发 ${sent}，回读 ${got}`,
  /** 逐字段结果（四种之一，Fable 11/25） */
  fieldStatus: { applied: '已生效', unchanged: '未变化', unverifiable: '无法核对', unknown: '结果未知' },
  /** 混合时标题里的计数（「1 项未生效，1 项无法核对」：计数里未变化写作「未生效」，沿用裁定原文） */
  fieldCount: (n: number, s: 'applied' | 'unchanged' | 'unverifiable' | 'unknown') =>
    `${n} 项${({ applied: '已生效', unchanged: '未生效', unverifiable: '无法核对', unknown: '结果未知' } as const)[s]}`,
} as const
