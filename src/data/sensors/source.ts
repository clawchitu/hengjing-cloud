// 传感器数据的两个数据源，按运行时配置 dataSource 选择（同 src/data/org/sources.ts）：
// - real：ctrl 207 / 208（只读，callCtrl 拒绝写消息号）；project_id 用项目的后端实体 id（不是 code）；
// - mock：演示数据（e2e 截图），形状与 real 解码后相同。
import { getMockAirSensorHours, getMockAirSensors } from '../../api'
import { isMockMode } from '../../api/config'
import { callCtrl } from '../../api/ctrl'
import type { AirSensorData } from './map'
import type { HourRecord } from './stats'

export interface SensorSource {
  /** 207：项目下全部空气传感器的实时数据 */
  live(projectId: string, signal?: AbortSignal): Promise<AirSensorData[]>
  /** 208：一台传感器 [start, end]（毫秒）内的小时数据 */
  hours(projectId: string, deviceId: number, start: number, end: number, signal?: AbortSignal): Promise<Partial<HourRecord>[]>
}

export const realSensorSource: SensorSource = {
  live: async (projectId, signal) => (await callCtrl(207, projectId, {}, { signal })).data,
  hours: async (projectId, deviceId, start, end, signal) =>
    (await callCtrl(208, projectId, { deviceId, startTime: start, endTime: end }, { signal })).data,
}

const mockSensorSource: SensorSource = {
  live: async (projectId) => (await getMockAirSensors(projectId)).data,
  hours: async (projectId, deviceId, start, end) => (await getMockAirSensorHours(projectId, deviceId, start, end)).data,
}

export const sensorSource = (): SensorSource => (isMockMode() ? mockSensorSource : realSensorSource)
