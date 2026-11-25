// Async data-access layer. Every page reads through here, so swapping the mock
// for real endpoints means replacing these function bodies with fetch() calls.
// Each function documents the endpoint it stands in for.
import * as M from '../mock/data'
import * as O from '../mock/org'
import * as G from '../mock/gen'
import { isMockMode } from './config'

// 演示数据（src/mock）只经由本文件进入页面。生产交付包（__HJC_MOCK__ = false，见 src/build-flags.d.ts）里，
// 下面每处读演示数据的地方都先判断 __HJC_MOCK__，打包时整段剔除，只剩空结果；其他构建行为不变。

const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms))

export type { Room, FreshAir, Sensor, Conn } from '../mock/data'
// 组织数据的视图模型与按 app_code 派生的能力在数据层（src/data/org），这里转出供现有页面沿用
export type { Project, Group, Dealer, User, Role, Scope } from '../data/org/types'
export type { HourPoint, DayPoint, Agg, MetricKey } from '../mock/gen'
export { hasRooms, isStandalone } from '../data/org/capabilities'
export { PROGRAMS, gatewayOf, DEW_MODES } from '../data/constants'

// auth ---------------------------------------------------------------
/** POST /api/login (real, Cloudflare Worker) → { ok, role, username } */
export async function login(username: string, password: string): Promise<{ username: string; role: O.Role }> {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  if (!r.ok) throw new Error('bad credentials')
  const j = (await r.json()) as { ok: boolean; role?: O.Role; username?: string }
  if (!j.ok || !j.role || !j.username) throw new Error('bad credentials')
  return { username: j.username, role: j.role }
}
/** 未登录 / 交付包里的占位用户（不含演示账号信息） */
const NO_USER: O.User = Object.freeze({ username: '', name: '', org: '', role: 'dealer', roleLabel: '' })
/** 演示账号资料；不认识的用户名回退到第一个演示账号。交付包里恒为空占位 */
export const profile = (username: string): O.User => {
  if (!__HJC_MOCK__) return NO_USER
  return O.users[username] ?? Object.values(O.users)[0]
}

// org scope ------------------------------------------------------------
interface MockScope { dealers: O.Dealer[]; groups: O.Group[]; projects: O.Project[] }
/** 演示数据的组织范围：dealer sees only its own 集成项目; admin sees every dealer's（真实接口见 src/data/org） */
export function scopeOf(user: O.User): MockScope {
  if (!__HJC_MOCK__) return { dealers: [], groups: [], projects: [] }
  const dealers = user.role === 'admin' ? O.dealers : O.dealers.filter((d) => d.id === user.dealerId)
  const ids = new Set(dealers.map((d) => d.id))
  const groups = O.groups.filter((g) => ids.has(g.dealerId))
  const gids = new Set(groups.map((g) => g.id))
  return { dealers, groups, projects: O.projects.filter((p) => gids.has(p.groupId)) }
}
export const getScope = (user: O.User) => delay(scopeOf(user))
export const findProject = (id: string) => (__HJC_MOCK__ ? O.projects.find((p) => p.id === id) : undefined)

// 常用项目 ---------------------------------------------------------------
// Mock backend: per-user select counters persisted in localStorage.
const CK = 'hjc-mock-select-counts'
type Counts = Record<string, Record<string, number>>
const readCounts = (): Counts => { try { return JSON.parse(localStorage.getItem(CK) || '{}') } catch { return {} } }
const writeCounts = (c: Counts) => localStorage.setItem(CK, JSON.stringify(c))
/** 演示账号首次使用时的初始计数：管理员 2 个常用项目，经销商 5 个（首页显示前 4 个） */
const seedOf = (u: O.User): Record<string, number> =>
  u.role === 'admin' ? { 'PRJ-50101': 6, 'PRJ-60014': 3 } : { 'PRJ-10241': 18, 'PRJ-10242': 11, 'PRJ-20117': 7, 'PRJ-30056': 5, 'PRJ-10252': 3 }
function userCounts(u: O.User): Record<string, number> {
  if (!__HJC_MOCK__) return {}
  const c = readCounts()
  if (!c[u.username]) { c[u.username] = seedOf(u); writeCounts(c) }
  return c[u.username]
}
/** POST /api/projects/select { projectId } — backend increments the user's counter */
export async function reportProjectSelect(u: O.User, projectId: string) {
  if (!__HJC_MOCK__) return { ok: true, count: 0 }
  const c = readCounts()
  const mine = { ...userCounts(u) }
  mine[projectId] = (mine[projectId] ?? 0) + 1
  writeCounts({ ...c, [u.username]: mine })
  return delay({ ok: true, count: mine[projectId] }, 40)
}
/**
 * 演示数据的常用项目：本地计数最多的 4 个可见项目 { id, count }（可能不足 4 个或为空）。
 * 只用于演示数据模式；真实接口模式返回空列表（真实的 POST /projects/frequent 见 src/api/pcfg.ts，
 * 由 src/data/org 的 useFrequentProjects 调用），不把演示项目混进真实账号。
 */
export function getFrequentProjects(u: O.User): Promise<{ id: string; count: number }[]> {
  if (!__HJC_MOCK__ || !isMockMode()) return delay([])
  const visible = new Set(scopeOf(u).projects.map((p) => p.id))
  const list = Object.entries(userCounts(u))
    .filter(([id, n]) => n > 0 && visible.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id, count]) => ({ id, count }))
  return delay(list)
}

// rooms ----------------------------------------------------------------
const roomState: Record<string, M.Room[]> = {}
const roomsOf = (pid: string): M.Room[] => (roomState[pid] ??= __HJC_MOCK__ ? structuredClone(G.roomsFor(pid)) : [])
/** GET /api/projects/:id/rooms */
export const getRooms = (projectId: string) => delay(roomsOf(projectId))
/** POST /api/projects/:id/rooms/power */
export async function setRoomPower(projectId: string, ids: string[], on: boolean) {
  roomState[projectId] = roomsOf(projectId).map((r) => (ids.includes(r.id) ? { ...r, on } : r))
  return delay(roomState[projectId], 200)
}
/**
 * 演示用的单房间设置：按 201 Query 的语义改演示数据（-1 = 不变）。交付包里直接拒绝，不能出现假成功
 * （真实下发走 src/features/thermostat/source.ts → src/api/ctrl.ts 的 writeCtrl）
 */
export async function applyRoomSet(projectId: string, roomId: string, q: { temperature: number; eco: number; switch: number }) {
  if (!__HJC_MOCK__) return Promise.reject(new Error('演示数据已剔除，未下发'))
  roomState[projectId] = roomsOf(projectId).map((r) => (r.id !== roomId ? r : {
    ...r,
    ...(q.temperature !== -1 ? { setTemp: q.temperature } : {}),
    ...(q.eco !== -1 ? { mode: q.eco === 1 ? '节能' as const : '标准' as const } : {}),
    ...(q.switch !== -1 ? { on: q.switch === 1 } : {}),
  }))
  return delay(roomState[projectId], 200)
}
/** GET /api/projects/:id/rooms/:roomId/stats/24h — hourly temp/hum/dew for today */
export function getRoomStats24h(projectId: string, roomId: string) {
  const r = roomsOf(projectId).find((x) => x.id === roomId)
  return delay(__HJC_MOCK__ && r ? G.series24h(`${projectId}/${roomId}`, { temp: r.temp, hum: r.humidity, dew: r.dew }) : [])
}
/** GET /api/projects/:id/rooms/:roomId/stats/daily?days=7|30 — per-day avg/max/min */
export function getRoomStatsDaily(projectId: string, roomId: string, days: 7 | 30) {
  const r = roomsOf(projectId).find((x) => x.id === roomId)
  return delay(__HJC_MOCK__ && r ? G.seriesDaily(`${projectId}/${roomId}`, { temp: r.temp, hum: r.humidity, dew: r.dew }, days) : [])
}

// fresh air ------------------------------------------------------------
const faState: Record<string, M.FreshAir[]> = {}
const faOf = (pid: string): M.FreshAir[] => (faState[pid] ??= __HJC_MOCK__ ? structuredClone(G.freshAirFor(pid)) : [])
/** GET /api/projects/:id/fresh-air */
export const getFreshAir = (projectId: string) => delay(faOf(projectId))
/** POST /api/projects/:id/fresh-air/:unitId/settings (新风单机版 only) */
export async function applyFreshAir(projectId: string, id: string, patch: Partial<M.FreshAir>) {
  faState[projectId] = faOf(projectId).map((f) => (f.id === id ? { ...f, ...patch } : f))
  return delay(faState[projectId], 300)
}

// connections ------------------------------------------------------------
/** 演示数据的设备连接明细；真实接口是 ctrl 205（src/data/connections.ts useDeviceSummary），不经过这里 */
export const getConnections = (projectId: string): Promise<M.Conn[]> => delay(__HJC_MOCK__ ? G.connectionsFor(projectId) : [])
// 网关 IP / 延迟 / 运行时长接口无此字段（方案 1.2），演示版的 getGateway 已去掉；控制屏 / DTU 编号不上屏（S13 走查 P6）

// unified control ----------------------------------------------------------------
/** 最近一次执行结果（演示数据）。改动文档第 6 条：只有项目、项目 ID、状态、操作时间 */
export const getLastRun = (): Promise<typeof M.lastRun | null> => delay(__HJC_MOCK__ && isMockMode() ? M.lastRun : null)

// 演示数据模式下统一控制的回读与下发：只改内存里的演示状态，不发任何请求。交付包里直接拒绝（真实下发走 src/api/ctrl.ts）
const mockUnified = new Map<string, { roomSwitch: number; roomTemp: number }>()
const mockUnifiedOf = (id: string) => {
  let s = mockUnified.get(id)
  if (!s) mockUnified.set(id, (s = { roomSwitch: 1, roomTemp: 26 }))
  return s
}
/** 演示：回读（对应 ctrl 200 整理后的快照）。新风单机版（12）没有房间 */
export const mockUnifiedRead = (projectId: string): Promise<{ rooms: number; roomSwitch: number | null; roomTemp: number | null }> => {
  if (!__HJC_MOCK__) return Promise.reject(new Error('回读不可用'))
  const p = O.projects.find((x) => x.id === projectId)
  if (!p || p.programCode === 12) return delay({ rooms: 0, roomSwitch: null, roomTemp: null }, 200)
  const s = mockUnifiedOf(projectId)
  return delay({ rooms: p.devices, roomSwitch: s.roomSwitch, roomTemp: s.roomTemp }, 200)
}
/** 演示：下发（对应 ctrl 203）。-1 为不变 */
export const mockUnifiedSend = (project: { id: string }, q: { roomSwitch: number; roomTemp: number }): Promise<{ success: boolean; msg: string }> => {
  if (!__HJC_MOCK__) return Promise.reject(new Error('统一控制尚未接入真实接口，未下发'))
  const s = mockUnifiedOf(project.id)
  if (q.roomSwitch !== -1) s.roomSwitch = q.roomSwitch
  if (q.roomTemp !== -1) s.roomTemp = q.roomTemp
  return delay({ success: true, msg: '' }, 500)
}
export const __resetMockUnifiedForTests = () => { mockUnified.clear() }

// home -----------------------------------------------------------------------

// sensors ----------------------------------------------------------------------
// 室内空气传感器页的演示数据源（真实接口是 ctrl 207 / 208，见 src/data/sensors/source.ts）。
// 返回与 callCtrl 解码后相同的形状：无探头的字段为 65536，时间是毫秒，页面走同一套映射与统计。
/** ctrl 207 AirSensorGet 的演示回复 */
export const getMockAirSensors = (projectId: string): Promise<{ data: ReturnType<typeof G.airSensorsFor> }> =>
  delay({ data: __HJC_MOCK__ ? G.airSensorsFor(projectId) : [] })
/** ctrl 208 AirSensorDataHourGet 的演示回复：[start, end]（毫秒）内每个整点一条 */
export const getMockAirSensorHours = (projectId: string, deviceId: number, start: number, end: number): Promise<{ data: ReturnType<typeof G.airSensorHoursFor> }> =>
  delay({ data: __HJC_MOCK__ ? G.airSensorHoursFor(projectId, deviceId, start, end) : [] })

// live ticking ---------------------------------------------------------------
export const walk = (v: number, step: number, min: number, max: number, digits = 1) =>
  +Math.min(max, Math.max(min, v + (Math.random() - 0.5) * 2 * step)).toFixed(digits)
