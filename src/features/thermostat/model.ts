// 房间温控面板的视图模型：ctrl 200（RoomTemperatureDataGet）的一条房间 → 页面用的 RoomView。
// 依据：docs/api/ctrl同步消息200-210.md 4.1、docs/plan-v1.md 1.2「房间温控面板」与文末后端答复、改动文档「房间温控面板」。
// - 65536 = 未初始化 / 无数据（后端答复⑪）→ null，页面隐藏该项；
// - wind_speed：0–99 为档位（0 是有效读数，11/25 答复第 9 条），100 为自动（后端答复⑧），其他值没有含义 → null；
// - end_modes 按数量动态显示：is_selected 决定蓝 / 灰，「开 / 关」取该末端自己的 switch（改动文档）；末端 switch 是状态显示，
//   由控制屏自己控制，前端不能改（后端 11/25 答复第 3 条）；
// - 房间开关（switch）：后端 11/25 答复第 1 条，控制屏没上报房间状态，200 读到的是默认值 0。features.roomSwitchReported
//   为 false（默认）时 switchKnown = false：界面显示「未知」，不拿它禁用温度 / 节能，核对开关记无法核对；
// - set_humi 按改动文档不再显示，这里也不映射；楼层文档无，去掉。
import type { CtrlQuery, CtrlReply } from '@/api/ctrl'
import { roomSwitchReported } from '@/api/config'
import { reading, setting } from '@/api/values'

type RawRoom = CtrlReply<200>['data'][number]
type RawEndMode = RawRoom['endModes'][number]
/** 201 里的末端（与 200 同一个 WorkModeData）：没改末端传空列表；改了末端才把该房间全部末端完整传回 */
export type WireEndMode = CtrlQuery<201>['endModes'][number]

/** 风速：0–99 档位，100 自动 */
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
  /** 风速：0–99 档位、100 自动；其他为 null（显示 --） */
  windSpeed: number | null
  /** 节能模式：1 节能，0 标准；无数据为 null（不可调） */
  eco: 0 | 1 | null
  /** 房间开关：只有 switch === 1 才算开。switchKnown 为 false 时这个值不可信，不要拿来判断 */
  on: boolean
  /** 房间开关读数是否可信（features.roomSwitchReported；演示数据恒为 true） */
  switchKnown: boolean
  /** 工作模式名称（制冷 / 制热 / 通风）；未知为空串 */
  mode: string
  endModes: EndMode[]
  /**
   * 200 读到的末端原始数据（完整 WorkModeData）。201 只有在改了末端时才用它组装完整的末端列表（后端 11/25 答复第 3 条）；
   * 没改末端传空列表，所以读不到末端（为空）不影响下发
   */
  wireEndModes: WireEndMode[]
  /** 面板是否连接 */
  connected: boolean
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 风速 → 有效档位：0–99 档位（0 是有效读数，后端 11/25 答复第 9 条；<100 为对应档位，11/24 答复第 8 条）、100 自动；其他一律 null */
export function windOf(v: unknown): number | null {
  if (!finite(v) || !Number.isInteger(v)) return null
  return (v >= 0 && v <= 99) || v === WIND_AUTO ? v : null
}

/** 风速显示：「3 档」「自动」「--」 */
export const windLabel = (v: number | null) => (v === null ? '--' : v === WIND_AUTO ? '自动' : `${v} 档`)

/** 设定温度：65536（未初始化）、-100（无效数据）、-1 视为没有设定值；0 是有效读数（后端 11/25 答复第 9 条） */
function setTempOf(v: unknown): number | null {
  return setting(finite(v) ? v : null)
}

const ecoOf =(v: unknown): 0 | 1 | null => (v === 1 ? 1 : v === 0 ? 0 : null)

function toEndMode(m: RawEndMode): EndMode {
  return { name: m.optionName || END_MODE_TYPES[m.type] || '末端', type: m.type, selected: m.isSelected === true, on: m.switch === 1 }
}

export interface RoomViewOpts {
  /** 房间开关是否可信；默认取 roomSwitchReported() */
  switchReported?: boolean
}

/** ctrl 200 的一条房间 → RoomView */
export function toRoomView(r: RawRoom, opts: RoomViewOpts = {}): RoomView {
  return {
    key: String(r.id),
    equipmentId: r.id,
    name: r.name?.trim() || '未命名房间', // 不拿 ID 当名称（S13：界面不显示 id），多个未命名的由 orderRooms 加序号
    temp: reading(r.temperature),
    humidity: reading(r.humidity),
    dew: reading(r.dewPoint),
    setTemp: setTempOf(r.setTemp),
    windSpeed: windOf(r.windSpeed),
    eco: ecoOf(r.eco),
    on: r.switch === 1,
    // 开关读数只有 0 / 1 才可信（-100、65536 等无效读数不能当成「关」）
    switchKnown: (opts.switchReported ?? roomSwitchReported()) && (r.switch === 0 || r.switch === 1),
    mode: ROOM_MODES[r.mode] ?? '',
    endModes: (r.endModes ?? []).map(toEndMode),
    wireEndModes: (r.endModes ?? []).map((m) => ({ optionName: m.optionName, type: m.type, isSelected: m.isSelected, isChange: m.isChange, switch: m.switch })),
    connected: r.isConnected === true,
  }
}

/** 整个 200 回复 → 房间列表（设备 ID 无效的丢弃，避免拿 0 去下发） */
export function toRoomViews(reply: CtrlReply<200>, opts: RoomViewOpts = {}): RoomView[] {
  const o = { switchReported: opts.switchReported ?? roomSwitchReported() }
  return orderRooms((reply.data ?? []).filter((r) => Number.isSafeInteger(r.id) && r.id > 0).map((r) => toRoomView(r, o)))
}

const roomCollator = new Intl.Collator('zh-CN', { numeric: true })

/**
 * 页面上的房间顺序和名称（S13 走查）：按房间名自然排序（房间11、房间12、房间13，名称相同按设备 ID）；
 * 界面不显示房间 ID，同一项目里有同名房间时，第 2 个起在名称后加「 (2)」「 (3)」区分
 */
export function orderRooms<T extends { name: string; equipmentId: number }>(rooms: readonly T[]): T[] {
  const sorted = [...rooms].sort((a, b) => roomCollator.compare(a.name, b.name) || a.equipmentId - b.equipmentId)
  const seen = new Map<string, number>()
  return sorted.map((r) => {
    const n = (seen.get(r.name) ?? 0) + 1
    seen.set(r.name, n)
    return n > 1 ? { ...r, name: `${r.name} (${n})` } : r
  })
}

/** 房间是否确定关着：开关读数可信且为关。开关未知时一律 false（不拿它禁用任何操作） */
export const knownOff = (r: Pick<RoomView, 'on' | 'switchKnown'>) => r.switchKnown && !r.on

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

/**
 * 201（单房间设置 / 开关）的目标房间：原始 200 回包里该设备 ID 必须恰好出现一次。缺失或重复（无法确定是哪一条、末端取哪份）
 * 返回原因，不下发
 */
export function roomTargetIssue(reply: Pick<CtrlReply<200>, 'data'>, equipmentId: number): string | null {
  const n = (reply.data ?? []).filter((r) => r.id === equipmentId).length
  if (n === 0) return '房间已不在面板列表里'
  if (n > 1) return `控制屏返回的房间里设备 ID ${equipmentId} 出现了 ${n} 次，无法确定目标房间`
  return null
}

// ---------------------------------------------------------------------------
// 顶部 KPI

export interface RoomSummary {
  total: number
  connected: number
  /** 已开启的房间数；有房间开关未知时为 null（界面显示 --） */
  on: number | null
  eco: number
  /** 已开启房间的平均室温（开关未知时按全部房间）；没有有效读数为 null */
  avgTemp: number | null
  avgHumidity: number | null
  avgDew: number | null
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null)
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}

export function summarize(rooms: readonly RoomView[]): RoomSummary {
  const known = rooms.every((r) => r.switchKnown)
  const on = known ? rooms.filter((r) => r.on) : rooms
  return {
    total: rooms.length,
    connected: rooms.filter((r) => r.connected).length,
    on: known ? on.length : null,
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
      endModes: r.wireEndModes.map((m) => ({ ...m })),
    })) as unknown as CtrlReply<200>['data'],
  }
}
