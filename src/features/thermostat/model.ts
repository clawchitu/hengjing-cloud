// 房间温控面板的视图模型：ctrl 200（RoomTemperatureDataGet）的一条房间 → 页面用的 RoomView。
// 依据：docs/api/ctrl同步消息200-210.md 4.1、docs/plan-v1.md 1.2「房间温控面板」与文末后端答复、改动文档「房间温控面板」。
// - 65536 = 未初始化 / 无数据（后端答复⑪）→ null，页面隐藏该项；
// - wind_speed：1–99 为档位，100 为自动（后端答复⑧），其他值（含缺省 0）没有含义 → null；
// - end_modes 按数量动态显示：is_selected 决定蓝 / 灰，「开 / 关」取该末端自己的 switch（改动文档）；
// - set_humi 按改动文档不再显示，这里也不映射；楼层文档无，去掉。
import type { CtrlQuery, CtrlReply } from '@/api/ctrl'
import { reading, setting } from '@/api/values'

type RawRoom = CtrlReply<200>['data'][number]
type RawEndMode = RawRoom['endModes'][number]
/** 201 里的末端（与 200 同一个 WorkModeData）：下发时把最新读到的原样传回 */
export type WireEndMode = CtrlQuery<201>['endModes'][number]

/** 风速：1–99 档位，100 自动 */
export const WIND_AUTO = 100
/** 末端类型（文档 4.1）：仅用于说明，显示一律用 option_name */
export const END_MODE_TYPES: Record<number, string> = { 0: '风盘', 1: '顶辐射', 2: '地暖', 3: '地冷', 4: '全空气' }
/** 工作模式（文档 4.1） */
export const ROOM_MODES: Record<number, string> = { 0: '制冷', 1: '制热', 2: '通风' }

export interface EndMode {
  name: string
  type: number
  /** 选中：蓝色；未选中：灰色 */
  selected: boolean
  /** 后面的「开 / 关」：switch === 1 为开，其他为关 */
  on: boolean
}

export interface RoomView {
  /** 界面与 React 用的键（真实接口为设备 ID 的字符串；演示数据为 TP-01 这类编号） */
  key: string
  /** 201 的 equipment_id（设备 ID） */
  equipmentId: number
  name: string
  /** 室内温度 / 湿度 / 露点：无数据为 null（页面隐藏） */
  temp: number | null
  humidity: number | null
  dew: number | null
  /** 设定温度；无数据为 null（不可调） */
  setTemp: number | null
  /** 风速：1–99 档位、100 自动；其他为 null（显示 --） */
  windSpeed: number | null
  /** 节能模式：1 节能，0 标准；无数据为 null（不可调） */
  eco: 0 | 1 | null
  /** 房间开关：只有 switch === 1 才算开 */
  on: boolean
  /** 工作模式名称（制冷 / 制热 / 通风）；未知为空串 */
  mode: string
  endModes: EndMode[]
  /**
   * 200 读到的末端原始数据（完整 WorkModeData），201 下发时原样传回（11/24 群里决定：不传空列表）。
   * 为空表示没读到末端，不允许下发
   */
  wireEndModes: WireEndMode[]
  /** 面板是否连接 */
  connected: boolean
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 风速 → 有效档位；不是 1–99 或 100 的一律 null */
export function windOf(v: unknown): number | null {
  if (!finite(v) || !Number.isInteger(v)) return null
  return (v >= 1 && v <= 99) || v === WIND_AUTO ? v : null
}

/** 风速显示：「3 档」「自动」「--」 */
export const windLabel = (v: number | null) => (v === null ? '--' : v === WIND_AUTO ? '自动' : `${v} 档`)

/** 设定温度：65536、-1 视为没有设定值；0（proto3 缺省，即控制屏没给）也按没有处理 */
function setTempOf(v: unknown): number | null {
  const s = setting(finite(v) ? v : null)
  return s !== null && s > 0 ? s : null
}

const ecoOf =(v: unknown): 0 | 1 | null => (v === 1 ? 1 : v === 0 ? 0 : null)

function toEndMode(m: RawEndMode): EndMode {
  return { name: m.optionName || END_MODE_TYPES[m.type] || '末端', type: m.type, selected: m.isSelected === true, on: m.switch === 1 }
}

/** ctrl 200 的一条房间 → RoomView */
export function toRoomView(r: RawRoom): RoomView {
  return {
    key: String(r.id),
    equipmentId: r.id,
    name: r.name || `房间 ${r.id}`,
    temp: reading(r.temperature),
    humidity: reading(r.humidity),
    dew: reading(r.dewPoint),
    setTemp: setTempOf(r.setTemp),
    windSpeed: windOf(r.windSpeed),
    eco: ecoOf(r.eco),
    on: r.switch === 1,
    mode: ROOM_MODES[r.mode] ?? '',
    endModes: (r.endModes ?? []).map(toEndMode),
    wireEndModes: (r.endModes ?? []).map((m) => ({ optionName: m.optionName, type: m.type, isSelected: m.isSelected, isChange: m.isChange, switch: m.switch })),
    connected: r.isConnected === true,
  }
}

/** 整个 200 回复 → 房间列表（设备 ID 无效的丢弃，避免拿 0 去下发） */
export function toRoomViews(reply: CtrlReply<200>): RoomView[] {
  return (reply.data ?? []).filter((r) => Number.isSafeInteger(r.id) && r.id > 0).map(toRoomView)
}

/** 设备 ID 能可靠标识一个房间：正的安全整数（0 是 proto3 缺省，不是真实 ID） */
export const validRoomId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

/**
 * 206（全部房间开关）的目标房间集合：基于原始 200 回包的完整房间列表（不是过滤后的页面列表）。206 控制项目全部房间，
 * 不按集合限制范围，所以只要有房间无法可靠标识（ID 为 0 / 无效）或 ID 重复，就无法逐个核对每个被控制的房间 → 拒绝下发并说明原因
 */
export function allRoomsTarget(reply: Pick<CtrlReply<200>, 'data'>): { ok: true; roomIds: number[] } | { ok: false; reason: string } {
  const data = reply.data ?? []
  if (!data.length) return { ok: false, reason: '没有读到任何房间' }
  const bad = data.filter((r) => !validRoomId(r.id)).length
  if (bad) return { ok: false, reason: `控制屏返回的房间里有 ${bad} 个设备 ID 无效，无法逐个核对全部房间` }
  const ids = data.map((r) => r.id)
  const dup = ids.length - new Set(ids).size
  if (dup) return { ok: false, reason: `控制屏返回的房间里有重复的设备 ID，无法逐个核对全部房间` }
  return { ok: true, roomIds: ids }
}

// ---------------------------------------------------------------------------
// 顶部 KPI

export interface RoomSummary {
  total: number
  connected: number
  on: number
  eco: number
  /** 已开启房间的平均室温；没有有效读数为 null */
  avgTemp: number | null
  avgHumidity: number | null
  avgDew: number | null
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null)
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}

export function summarize(rooms: readonly RoomView[]): RoomSummary {
  const on = rooms.filter((r) => r.on)
  return {
    total: rooms.length,
    connected: rooms.filter((r) => r.connected).length,
    on: on.length,
    eco: on.filter((r) => r.eco === 1).length,
    avgTemp: avg(on.map((r) => r.temp)),
    avgHumidity: avg(rooms.map((r) => r.humidity)),
    avgDew: avg(rooms.map((r) => r.dew)),
  }
}

/**
 * 页面用的房间读数 → 200 Reply 的形状（只填比对用到的字段）。演示数据核对用；读不到的值填 NaN（比对时按无效读数，无法核对）
 */
export function roomsAsReply(list: readonly RoomView[]): Pick<CtrlReply<200>, 'data'> {
  return {
    data: list.map((r) => ({
      id: r.equipmentId, setTemp: r.setTemp ?? Number.NaN, eco: r.eco ?? Number.NaN, switch: r.on ? 1 : 0, isConnected: r.connected,
    })) as unknown as CtrlReply<200>['data'],
  }
}
