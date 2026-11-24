// 按应用编码（app_code）派生的项目能力。
// 负责人 11/24 答复：主要支持 1（通用版，有房间温控）与 12（独立空气系统 = 新风单机：没有房间温控面板，
// 有新风运行设置）；8 暂不用本平台。统一控制按所选集成项目组的 app_code 决定温度设定是否可用（12 不可用，
// 房间开关仍可用）。演示数据的程序编码 11/21/31 都按「非 12」处理，与演示版行为一致。

export const APP_CODE = {
  /** 通用版 */
  GENERAL: 1,
  /** 空气系统单机版：暂不用本平台 */
  AIR_SINGLE: 8,
  /** 独立空气系统（新风单机版） */
  STANDALONE_AIR: 12,
} as const

export interface Capabilities {
  /** 应用编码；0 表示缺失 */
  appCode: number
  /** 有房间温控面板（温控面板页、ctrl 200/201/206/209） */
  thermostat: boolean
  /** 统一控制里房间温度设定可用 */
  roomTemp: boolean
  /** 新风除湿机有运行设置（ctrl 210/204） */
  freshAirSettings: boolean
  /** 平台正式支持的应用（1、12）；其他编码页面照常显示，但未经联调 */
  supported: boolean
}

/** app_code（字符串或数字）→ 数字；缺失或非法为 0 */
export function toAppCode(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : 0
}

export function capabilitiesOf(appCode: number | string | null | undefined): Capabilities {
  const code = toAppCode(appCode)
  const standalone = code === APP_CODE.STANDALONE_AIR
  return {
    appCode: code,
    thermostat: !standalone,
    roomTemp: !standalone,
    freshAirSettings: standalone,
    supported: code === APP_CODE.GENERAL || code === APP_CODE.STANDALONE_AIR,
  }
}

/** 新风单机版（app_code 12） */
export const isStandalone = (p: { programCode: number }) => capabilitiesOf(p.programCode).freshAirSettings
/** 有房间温控面板（app_code 不是 12） */
export const hasRooms = (p: { programCode: number }) => capabilitiesOf(p.programCode).thermostat
