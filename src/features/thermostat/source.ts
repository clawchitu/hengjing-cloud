// 温控面板的两个数据源，接口相同，按运行时配置 dataSource 选择（与 src/data/org/sources.ts 同样的做法）：
// - real：读 ctrl 200 / 209 走 callCtrl()；写 201 / 206 只走 S4 的统一写入口 writeCtrl()
//   （requestWrite → guard.ts 写防护，白名单按项目 code，请求体用 id，不重试）；
// - mock：演示数据（e2e 截图全走这里），写操作只改内存里的演示数据，不发任何请求。
// 交付包（__HJC_MOCK__ = false）里 thermostatSource() 恒为 real，演示分支在打包时剔除。
import * as api from '@/api'
import { buildProjectRoomSwitchSet, callCtrl, writeCtrl, type WriteQuery } from '@/api/ctrl'
import { isMockMode } from '@/api/config'
import type { WriteProject } from '@/api/guard'
import { WIND_AUTO, toRoomViews, type RoomView } from './model'
import { statsWindow, toChartData, type ChartData, type StatsRange } from './stats'

export interface ThermostatSource {
  readonly kind: 'real' | 'mock'
  /** ctrl 200：房间列表 */
  rooms(projectId: string, signal?: AbortSignal): Promise<RoomView[]>
  /** ctrl 209：统计图 */
  stats(projectId: string, room: RoomView, range: StatsRange, signal?: AbortSignal): Promise<ChartData>
  /** ctrl 201：单房间设置。resolve 即 Reply success=true（面板已生效，后端答复⑥）；失败一律 reject */
  setRoom(project: WriteProject, query: WriteQuery<201>): Promise<void>
  /** ctrl 206：全部房间开 / 关 */
  setAll(project: WriteProject, on: boolean): Promise<void>
}

export const realSource: ThermostatSource = {
  kind: 'real',
  rooms: async (projectId, signal) => toRoomViews(await callCtrl(200, projectId, {}, { signal })),
  stats: async (projectId, room, range, signal) => {
    const now = Date.now()
    const w = statsWindow(range, now)
    const reply = await callCtrl(209, projectId, { deviceId: room.equipmentId, startTime: w.startTime, endTime: w.endTime }, { signal })
    return toChartData(reply, range, now)
  },
  // writeCtrl 在 Reply success 不为 true 时抛 ApiError('ctrl')，这里不需要再判断
  setRoom: async (project, query) => { await writeCtrl(201, project, query) },
  setAll: async (project, on) => { await writeCtrl(206, project, buildProjectRoomSwitchSet(on)) },
}

// ---------------------------------------------------------------------------
// mock：演示数据的 Room → RoomView

const FAN: Record<string, number> = { 低速: 1, 中速: 2, 高速: 3, 自动: WIND_AUTO }
const mockEquipmentId = (id: string) => Number(id.replace(/\D/g, '')) || 0

export function fromMockRoom(r: api.Room): RoomView {
  const ends: [string, number, boolean][] = [['顶辐射', 1, r.radiant], ['地冷', 3, r.floorHeat], ['风盘', 0, r.fanCoil]]
  return {
    key: r.id,
    equipmentId: mockEquipmentId(r.id),
    name: r.name,
    temp: r.temp,
    humidity: r.humidity,
    dew: r.dew,
    setTemp: r.setTemp,
    windSpeed: FAN[r.fan] ?? null,
    eco: r.mode === '节能' ? 1 : 0,
    on: r.on,
    mode: '制冷',
    endModes: ends.map(([name, type, sel]) => ({ name, type, selected: sel, on: r.on && sel })),
    wireEndModes: ends.map(([optionName, type, sel]) => ({ optionName, type, isSelected: sel, isChange: true, switch: r.on && sel ? 1 : 0 })),
    connected: true,
  }
}

const mockSource: ThermostatSource = {
  kind: 'mock',
  rooms: async (projectId) => (await api.getRooms(projectId)).map(fromMockRoom),
  stats: async (projectId, room, range) => {
    if (range === '24小时') {
      const hours = await api.getRoomStats24h(projectId, room.key)
      return { xs: hours.map((h) => h.t), rows: hours.map((h) => [h.temp, h.dew, h.hum]), hourly: true }
    }
    const days = await api.getRoomStatsDaily(projectId, room.key, range === '7日' ? 7 : 30)
    return { xs: days.map((d) => d.date), rows: days.map((d) => [d.temp.avg, d.dew.avg, d.hum.avg]), hourly: false }
  },
  setRoom: async (project, q) => {
    const room = (await api.getRooms(project.id)).find((r) => mockEquipmentId(r.id) === q.equipmentId)
    if (!room) throw new Error('演示数据里没有这个房间')
    await api.applyRoomSet(project.id, room.id, q)
  },
  setAll: async (project, on) => {
    const rooms = await api.getRooms(project.id)
    await api.setRoomPower(project.id, rooms.map((r) => r.id), on)
  },
}

/** 当前数据源：演示数据模式用 mock，否则（含交付包）一律 real */
export const thermostatSource = (): ThermostatSource => (__HJC_MOCK__ && isMockMode() ? mockSource : realSource)
