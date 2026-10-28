// Async data-access layer. Every page reads through here, so swapping the mock
// for real endpoints means replacing these function bodies with fetch() calls.
import * as M from '../mock/data'

const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms))

export type { Project, Group, Room, FreshAir, Meter, Alarm, Sensor, Param, Conn, DeviceNode } from '../mock/data'

// auth ---------------------------------------------------------------
export async function login(username: string, _password: string) {
  return delay({ token: 'demo-' + Date.now(), user: { ...M.user, username } }, 400)
}

// projects -----------------------------------------------------------
export const getUser = () => delay(M.user, 0)
export const getGroups = () => delay(M.groups)
export const getProjects = () => delay(M.projects)
export const getProject = (id: string) => delay(M.projects.find((p) => p.id === id) ?? M.projects[0])

// rooms ----------------------------------------------------------------
let roomState = structuredClone(M.rooms)
export const getRooms = (_projectId: string) => delay(roomState)
export async function setRoomPower(_projectId: string, ids: string[], on: boolean) {
  roomState = roomState.map((r) => (ids.includes(r.id) ? { ...r, on } : r))
  return delay(roomState, 200)
}

// fresh air ------------------------------------------------------------
let faState = structuredClone(M.freshAirUnits)
export const getFreshAir = (_projectId: string) => delay(faState)
export async function applyFreshAir(id: string, patch: Partial<M.FreshAir>) {
  faState = faState.map((f) => (f.id === id ? { ...f, ...patch } : f))
  return delay(faState, 300)
}
export function freshAirHistory(range: '24h' | '7d' | '30d') {
  const n = range === '24h' ? 25 : range === '7d' ? 7 * 8 : 30
  const labels = Array.from({ length: n }, (_, i) =>
    range === '24h' ? `${String(i).padStart(2, '0')}:00` : range === '7d' ? `06-${12 + Math.floor(i / 8)} ${String((i % 8) * 3).padStart(2, '0')}时` : `05-${String(20 + i).padStart(2, '0')}`.replace(/05-(3\d|5\d|4\d)/, (m) => m))
  const fix = (s: string, i: number) => (range === '30d' ? (i < 12 ? `05-${20 + i}` : `06-${String(i - 11).padStart(2, '0')}`) : s)
  const temp = labels.map((_, i) => +(18.6 + 0.5 * Math.sin(i / 4) - 0.25 * Math.cos(i / 2.3)).toFixed(1))
  const dew = labels.map((_, i) => +(11.3 + 0.25 * Math.sin(i / 5 + 1)).toFixed(1))
  const hum = labels.map((_, i) => +(63 - 2.5 * Math.sin(i / 4.5) + Math.cos(i / 1.7)).toFixed(0))
  return delay({ labels: labels.map(fix), temp, dew, hum })
}

// meters -----------------------------------------------------------------
export const getMeters = (_projectId: string) => delay(M.meters)
export const getUsage = (_projectId: string, _range: '日' | '月' | '年') =>
  delay({ days: M.usageDays, series: M.usageSeries, share: M.todayShare })

// device realtime ----------------------------------------------------------
export const getDeviceTree = (_projectId: string) => delay(M.deviceTree)
export const getHeatPump = (_id: string) => delay(M.heatPump)

// params ---------------------------------------------------------------------
export const getParams = (_deviceId: string) => delay(M.paramTabs)
export const getParamLog = (_deviceId: string) => delay(M.paramLog)
export async function writeParams(_deviceId: string, changes: { code: string; value: string }[]) {
  return delay({ ok: true, count: changes.length }, 600)
}

// connections ------------------------------------------------------------------
export const getConnections = (_projectId: string) => delay(M.connections)
export const getConnHourly = (_projectId: string) => delay(M.connHourly)
export const reconnect = (name: string) => delay({ ok: true, name }, 900)

// alarms ---------------------------------------------------------------------
let alarmState = structuredClone(M.alarms)
export const getAlarms = (_projectId: string) => delay(alarmState)
export const getAlarmStats = (_projectId: string) => delay({ trend: M.alarmTrend, types: M.alarmTypes })
export async function ackAlarms(ids: string[], _note?: string) {
  alarmState = alarmState.map((a) => (ids.includes(a.id) && a.status === '未处理' ? { ...a, status: '已确认' as const } : a))
  return delay(alarmState, 250)
}
export const unprocessedAll = () => M.unprocessedAllProjects - (M.alarms.filter((a) => a.status === '未处理').length - alarmState.filter((a) => a.status === '未处理').length)
export const unprocessedCurrent = () => alarmState.filter((a) => a.status === '未处理').length

// unified control ----------------------------------------------------------------
export const getLastRun = () => delay(M.lastRun)
export const sendUnified = (payload: unknown) => delay({ ok: true, payload, id: 'CMD-20250618-0316' }, 700)

// home -----------------------------------------------------------------------
export const getWeather = (_city: string) => delay(M.weather)

// sensors ----------------------------------------------------------------------
export const getSensors = (_projectId: string) => delay(M.sensors)
export function sensorTrend(metric: string) {
  const base: Record<string, [number, number, number[]]> = {
    温度: [25.3, 0.7, [24, 27]], 湿度: [52, 4, [40, 60]], 露点: [15, 1.2, [13, 17]], 'PM2.5': [11, 5, [0, 35]], 'CO₂': [640, 160, [400, 1000]],
  }
  const [b, a, band] = base[metric]
  const xs = Array.from({ length: 49 }, (_, i) => i / 2)
  const ys = xs.map((x) => +(b + a * (0.55 * Math.sin((x - 8) / 3.6) + 0.25 * Math.sin(x * 1.3) + 0.15 * Math.cos(x * 2.1))).toFixed(metric === '温度' || metric === '露点' ? 2 : 0))
  return delay({ xs, ys, band })
}

// live ticking ---------------------------------------------------------------
export const walk = (v: number, step: number, min: number, max: number, digits = 1) =>
  +Math.min(max, Math.max(min, v + (Math.random() - 0.5) * 2 * step)).toFixed(digits)

/** Subscribe to a value that random-walks every `ms`. Returns unsubscribe. */
export function subscribe<T>(initial: T, next: (prev: T) => T, cb: (v: T) => void, ms = 2000) {
  let cur = initial
  const t = setInterval(() => { cur = next(cur); cb(cur) }, ms)
  return () => clearInterval(t)
}
