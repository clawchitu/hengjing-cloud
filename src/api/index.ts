// Async data-access layer. Every page reads through here, so swapping the mock
// for real endpoints means replacing these function bodies with fetch() calls.
// Each function documents the endpoint it stands in for.
import * as M from '../mock/data'
import * as O from '../mock/org'
import * as G from '../mock/gen'
import { gatewayOf } from '../data/constants'
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
type Seed = Record<string, number>
const SEEDS: Record<'0' | '2' | '4+', (u: O.User) => Seed> = {
  '0': () => ({}),
  '2': (u): Seed => (u.role === 'admin' ? { 'PRJ-50101': 6, 'PRJ-60014': 3 } : { 'PRJ-10241': 6, 'PRJ-10252': 2 }),
  '4+': (u): Seed => (u.role === 'admin' ? { 'PRJ-50101': 9, 'PRJ-10241': 7, 'PRJ-60014': 4, 'PRJ-50103': 3, 'PRJ-20117': 1 } : { 'PRJ-10241': 18, 'PRJ-10242': 11, 'PRJ-20117': 7, 'PRJ-30056': 5, 'PRJ-10252': 3 }),
}
function userCounts(u: O.User): Record<string, number> {
  if (!__HJC_MOCK__) return {}
  const c = readCounts()
  if (!c[u.username]) { c[u.username] = SEEDS[u.role === 'admin' ? '2' : '4+'](u); writeCounts(c) }
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
 * GET /api/projects/frequent → top 4 most-selected visible projects (may be fewer, or empty)。
 * 只是演示数据：真实接口模式下返回空列表（首页显示「暂无常用项目」），不把演示项目混进真实账号；
 * 真实的 POST /projects/frequent 由 S6b 接上，并按当前可见组织范围过滤。
 */
export function getFrequentProjects(u: O.User): Promise<{ project: O.Project; count: number }[]> {
  if (!__HJC_MOCK__ || !isMockMode()) return delay([])
  const visible = new Set(scopeOf(u).projects.map((p) => p.id))
  const list = Object.entries(userCounts(u))
    .filter(([id, n]) => n > 0 && visible.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id, count]) => ({ project: findProject(id)!, count }))
  return delay(list)
}
/** demo only: reset the mock counters to a preset */
export function seedFrequent(u: O.User, preset: '0' | '2' | '4+') {
  if (!__HJC_MOCK__) return
  writeCounts({ ...readCounts(), [u.username]: SEEDS[preset](u) })
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
/** GET /api/projects/:id/connections */
export const getConnections = (projectId: string): Promise<M.Conn[]> => delay(__HJC_MOCK__ ? G.connectionsFor(projectId) : [])
type Gateway = ReturnType<typeof G.gateway>
/** GET /api/projects/:id/gateway */
export const getGateway = (projectId: string): Promise<Gateway> =>
  delay(__HJC_MOCK__ ? G.gateway(projectId) : { id: gatewayOf(projectId), online: false, ip: '—', uptime: '—', latency: '—', lastOnline: undefined })

// unified control ----------------------------------------------------------------
export const getLastRun = (): Promise<typeof M.lastRun | null> => delay(__HJC_MOCK__ ? M.lastRun : null)
/** POST /api/control/unified */
/** 演示用的假下发。交付包里直接拒绝，不能出现「已下发」的假成功（真实下发走 src/api/ctrl.ts） */
export const sendUnified = (payload: unknown): Promise<{ ok: boolean; payload: unknown; id: string }> =>
  __HJC_MOCK__ ? delay({ ok: true, payload, id: 'CMD-20250618-0316' }, 700) : Promise.reject(new Error('统一控制尚未接入真实接口，未下发'))

// home -----------------------------------------------------------------------
type Weather = typeof M.weather
/** 天气（演示数据）。交付包里没有天气接口，返回 null，首页显示「暂无天气数据」 */
export const getWeather = (_city: string): Promise<Weather | null> => delay(__HJC_MOCK__ ? M.weather : null)

// sensors ----------------------------------------------------------------------
/** GET /api/projects/:id/sensors — pm25 / co2 absent when the sensor has no such probe */
export const getSensors = (projectId: string): Promise<M.Sensor[]> => delay(__HJC_MOCK__ ? G.sensorsFor(projectId) : [])
const sensorBase = (projectId: string, sensorId: string) => {
  const s = __HJC_MOCK__ ? G.sensorsFor(projectId).find((x) => x.id === sensorId) : undefined
  return s && { temp: s.temp, hum: s.hum, dew: s.dew, pm25: s.pm25, co2: s.co2 }
}
/** GET /api/projects/:id/sensors/:sensorId/stats/24h — hourly points for today (its own endpoint) */
export function getSensorStats24h(projectId: string, sensorId: string) {
  const b = sensorBase(projectId, sensorId)
  return delay(__HJC_MOCK__ && b ? G.series24h(`${projectId}/${sensorId}`, b) : [])
}
/** GET /api/projects/:id/sensors/:sensorId/stats/daily?days=7|30 — shared by 7日 and 30日, per-day avg/max/min */
export function getSensorStatsDaily(projectId: string, sensorId: string, days: 7 | 30) {
  const b = sensorBase(projectId, sensorId)
  return delay(__HJC_MOCK__ && b ? G.seriesDaily(`${projectId}/${sensorId}`, b, days) : [])
}

// live ticking ---------------------------------------------------------------
export const walk = (v: number, step: number, min: number, max: number, digits = 1) =>
  +Math.min(max, Math.max(min, v + (Math.random() - 0.5) * 2 * step)).toFixed(digits)
