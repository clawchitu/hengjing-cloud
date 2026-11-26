// 按应用编码（app_code）派生的项目能力。
// 负责人 11/24 答复：主要支持 1（通用版，有房间温控）与 12（独立空气系统 = 新风单机：没有房间温控面板，
// 有新风运行设置）。后端 11/26 08:34 答复：12 是 8 的替代，8 同样没有房间、也没有新风机运行控制接口 → 8 按 12 处理
// （没有房间温控面板、不读 200/201；统一控制温度禁用），但新风运行设置（210/204）仍只给 12。
// 统一控制温度可用与否另由 src/features/unified/constants.ts 的白名单决定（只放 1），这里的 roomTemp 只表示「有没有房间」。
// 演示数据的程序编码 11/21/31 都有房间，与演示版行为一致。

export const APP_CODE = {
  /** 通用版 */
  GENERAL: 1,
  /** 空气系统单机版：没有房间、没有新风运行控制（按 12 处理，后端 11/26） */
  AIR_SINGLE: 8,
  /** 独立空气系统（新风单机版） */
  STANDALONE_AIR: 12,
} as const

export interface Capabilities {
  /** 应用编码；0 表示缺失 */
  appCode: number
  /** 有房间温控面板（温控面板页、ctrl 200/201/206/209） */
  thermostat: boolean
  /** 有房间（8、12 没有）；统一控制里温度能否设定还要过白名单（unified/constants.ts TEMP_ENABLED_APP_CODES） */
  roomTemp: boolean
  /** 新风除湿机有运行设置（ctrl 210/204）：只有 12 */
  freshAirSettings: boolean
}

/** 没有房间的应用：8（空气系统单机版）、12（独立空气系统）——后端 11/26 08:34 答复 */
export const NO_ROOM_APP_CODES: readonly number[] = [APP_CODE.AIR_SINGLE, APP_CODE.STANDALONE_AIR]

/** app_code（字符串或数字）→ 数字；缺失或非法为 0 */
export function toAppCode(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : 0
}

export function capabilitiesOf(appCode: number | string | null | undefined): Capabilities {
  const code = toAppCode(appCode)
  const rooms = !NO_ROOM_APP_CODES.includes(code)
  return {
    appCode: code,
    thermostat: rooms,
    roomTemp: rooms,
    freshAirSettings: code === APP_CODE.STANDALONE_AIR,
  }
}

/** 新风单机版（app_code 12） */
export const isStandalone = (p: { programCode: number }) => capabilitiesOf(p.programCode).freshAirSettings
/** 有房间温控面板（app_code 不是 8、12） */
export const hasRooms = (p: { programCode: number }) => capabilitiesOf(p.programCode).thermostat
