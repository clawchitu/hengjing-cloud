// Async data-access layer. Every page reads through here, so swapping the mock
// for real endpoints means replacing these function bodies with fetch() calls.
// Each function documents the endpoint it stands in for.
import * as M from '../mock/data'
import * as O from '../mock/org'
import * as G from '../mock/gen'

const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms))

export type { Room, FreshAir, Sensor, Conn } from '../mock/data'
// 组织数据的视图模型与按 app_code 派生的能力在数据层（src/data/org），这里转出供现有页面沿用
export type { Project, Group, Dealer, User, Role, Scope } from '../data/org/types'
export type { HourPoint, DayPoint, Agg, MetricKey } from '../mock/gen'
export { hasRooms, isStandalone } from '../data/org/capabilities'
export { PROGRAMS, gatewayOf } from '../mock/org'
export { DEW_MODES } from '../mock/gen'

// auth ---------------------------------------------------------------
/** POST /api/login (real, Cloudflare Worker) → { ok, role, username } */
export async function login(username: string, password: string): Promise<{ username: string; role: O.Role }> {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  if (!r.ok) throw new Error('bad credentials')
  const j = (await r.json()) as { ok: boolean; role?: O.Role; username?: string }
  if (!j.ok || !j.role || !j.username) throw new Error('bad credentials')
  return { username: j.username, role: j.role }
}
export const profile = (username: string): O.User => O.users[username] ?? O.users.cosyhome

// org scope ------------------------------------------------------------
interface MockScope { dealers: O.Dealer[]; groups: O.Group[]; projects: O.Project[] }
/** 演示数据的组织范围：dealer sees only its own 集成项目; admin sees every dealer's（真实接口见 src/data/org） */
export function scopeOf(user: O.User): MockScope {
  const dealers = user.role === 'admin' ? O.dealers : O.dealers.filter((d) => d.id === user.dealerId)
  const ids = new Set(dealers.map((d) => d.id))
  const groups = O.groups.filter((g) => ids.has(g.dealerId))
  const gids = new Set(groups.map((g) => g.id))
  return { dealers, groups, projects: O.projects.filter((p) => gids.has(p.groupId)) }
}
export const getScope = (user: O.User) => delay(scopeOf(user))
export const findProject = (id: string) => O.projects.find((p) => p.id === id)

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
  const c = readCounts()
  if (!c[u.username]) { c[u.username] = SEEDS[u.role === 'admin' ? '2' : '4+'](u); writeCounts(c) }
  return c[u.username]
}
/** POST /api/projects/select { projectId } — backend increments the user's counter */
export async function reportProjectSelect(u: O.User, projectId: string) {
  const c = readCounts()
  const mine = { ...userCounts(u) }
  mine[projectId] = (mine[projectId] ?? 0) + 1
  writeCounts({ ...c, [u.username]: mine })
  return delay({ ok: true, count: mine[projectId] }, 40)
}
/** GET /api/projects/frequent → top 4 most-selected visible projects (may be fewer, or empty) */
export function getFrequentProjects(u: O.User) {
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
  writeCounts({ ...readCounts(), [u.username]: SEEDS[preset](u) })
}

// rooms ----------------------------------------------------------------
const roomState: Record<string, M.Room[]> = {}
const roomsOf = (pid: string) => (roomState[pid] ??= structuredClone(G.roomsFor(pid)))
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
  return delay(r ? G.series24h(`${projectId}/${roomId}`, { temp: r.temp, hum: r.humidity, dew: r.dew }) : [])
}
/** GET /api/projects/:id/rooms/:roomId/stats/daily?days=7|30 — per-day avg/max/min */
export function getRoomStatsDaily(projectId: string, roomId: string, days: 7 | 30) {
  const r = roomsOf(projectId).find((x) => x.id === roomId)
  return delay(r ? G.seriesDaily(`${projectId}/${roomId}`, { temp: r.temp, hum: r.humidity, dew: r.dew }, days) : [])
}

// fresh air ------------------------------------------------------------
const faState: Record<string, M.FreshAir[]> = {}
const faOf = (pid: string) => (faState[pid] ??= structuredClone(G.freshAirFor(pid)))
/** GET /api/projects/:id/fresh-air */
export const getFreshAir = (projectId: string) => delay(faOf(projectId))
/** POST /api/projects/:id/fresh-air/:unitId/settings (新风单机版 only) */
export async function applyFreshAir(projectId: string, id: string, patch: Partial<M.FreshAir>) {
  faState[projectId] = faOf(projectId).map((f) => (f.id === id ? { ...f, ...patch } : f))
  return delay(faState[projectId], 300)
}

// connections ------------------------------------------------------------
/** GET /api/projects/:id/connections */
export const getConnections = (projectId: string) => delay(G.connectionsFor(projectId))
/** GET /api/projects/:id/gateway */
export const getGateway = (projectId: string) => delay(G.gateway(projectId))

// unified control ----------------------------------------------------------------
export const getLastRun = () => delay(M.lastRun)
/** POST /api/control/unified */
export const sendUnified = (payload: unknown) => delay({ ok: true, payload, id: 'CMD-20250618-0316' }, 700)

// home -----------------------------------------------------------------------
export const getWeather = (_city: string) => delay(M.weather)

// sensors ----------------------------------------------------------------------
/** GET /api/projects/:id/sensors — pm25 / co2 absent when the sensor has no such probe */
export const getSensors = (projectId: string) => delay(G.sensorsFor(projectId))
const sensorBase = (projectId: string, sensorId: string) => {
  const s = G.sensorsFor(projectId).find((x) => x.id === sensorId)
  return s && { temp: s.temp, hum: s.hum, dew: s.dew, pm25: s.pm25, co2: s.co2 }
}
/** GET /api/projects/:id/sensors/:sensorId/stats/24h — hourly points for today (its own endpoint) */
export function getSensorStats24h(projectId: string, sensorId: string) {
  const b = sensorBase(projectId, sensorId)
  return delay(b ? G.series24h(`${projectId}/${sensorId}`, b) : [])
}
/** GET /api/projects/:id/sensors/:sensorId/stats/daily?days=7|30 — shared by 7日 and 30日, per-day avg/max/min */
export function getSensorStatsDaily(projectId: string, sensorId: string, days: 7 | 30) {
  const b = sensorBase(projectId, sensorId)
  return delay(b ? G.seriesDaily(`${projectId}/${sensorId}`, b, days) : [])
}

// live ticking ---------------------------------------------------------------
export const walk = (v: number, step: number, min: number, max: number, digits = 1) =>
  +Math.min(max, Math.max(min, v + (Math.random() - 0.5) * 2 * step)).toFixed(digits)
