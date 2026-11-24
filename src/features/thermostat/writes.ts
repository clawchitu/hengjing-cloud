// 温控面板的下发状态（模块级，页面卸载后仍存活）。
// - 按项目串行化：同一项目同一时间只允许一条 201 / 206 在途（含下发后的回读核对）。离开页面或切项目再回来，
//   在途期间页面照样禁用，不会与原请求并发；
// - 结果记录按「项目 + 目标（房间键或 all）」保存：失败、结果未知（含回读进行中 / 成功 / 失败），以及完成时
//   已不在原项目的成功结果，回到原项目时在对应位置显示；
// - 提示（toast）只在完成时仍是原项目才弹，避免在另一个项目里弹出误导性的「已下发」。
// 这里不发请求：send / readback 由调用方传入（send 走 source.setRoom / setAll → writeCtrl 统一写入口）。
import { useSyncExternalStore } from 'react'
import { isApiError } from '@/api/errors'
import { getStoredProjectId } from '@/data/org/current'

export type Outcome = 'ok' | 'fail' | 'unknown'
/** 回读核对：进行中 / 已读到 / 读取失败 */
export type Readback = 'pending' | 'ok' | 'fail'

export interface WriteResult {
  outcome: Outcome
  /** 失败原因或未知原因（ok 时是成功文案） */
  text: string
  /** 只有结果未知时有：回读核对的状态 */
  readback?: Readback
}

export const ALL = 'all'

let inflight = new Map<string, string>() // projectId → 目标
let results = new Map<string, WriteResult>() // `${projectId}\n${target}` → 结果
let version = 0
const subs = new Set<() => void>()
const emit = () => { version += 1; for (const fn of subs) fn() }
const rk = (projectId: string, target: string) => `${projectId}\n${target}`

export const busyTarget = (projectId: string) => inflight.get(projectId) ?? null
export const getResult = (projectId: string, target: string) => results.get(rk(projectId, target)) ?? null
export function clearResult(projectId: string, target: string) {
  if (results.delete(rk(projectId, target))) emit()
}

/** 完成时用户是否仍在原项目（存储里的当前项目；为空表示还没选过，按未切换处理） */
const stillCurrent = (projectId: string) => {
  const s = getStoredProjectId()
  return !s || s === projectId
}

export interface RunWrite {
  projectId: string
  /** 房间键或 ALL */
  target: string
  /** 真正的下发（经统一写入口）；resolve 即 success=true */
  send: () => Promise<void>
  /** 下发后回读 200；返回是否读到 */
  readback: () => Promise<boolean>
  okText: string
  /** 失败 / 未知提示的前缀，如「客厅」「全部开启」 */
  subject: string
  toast: (text: string, err?: boolean) => void
}

/**
 * 下发失败的分类。确定没有生效的才算「失败」：写防护拦截、参数错误、未登录 / 无权限、控制屏未连接（503，消息没发出去）、
 * 控制屏明确回复 success=false。其余（超时、断网、服务器错误 500、回复无法解析、请求被中止）指令都可能已到控制屏，
 * 一律按「结果未知」处理，不说「下发失败」
 */
const DEFINITE_FAIL = new Set(['write_blocked', 'bad_request', 'unauthenticated', 'forbidden', 'unavailable', 'ctrl'])
export function classify(e: unknown): { outcome: 'fail' | 'unknown'; text: string } {
  const err = isApiError(e) ? e : null
  const msg = err?.message || (e instanceof Error ? e.message : '') || '未知错误'
  if (err && DEFINITE_FAIL.has(err.kind)) return { outcome: 'fail', text: err.kind === 'write_blocked' ? `未下发：${msg}` : `下发失败：${msg}` }
  return { outcome: 'unknown', text: msg }
}

/**
 * 执行一次下发。项目已有在途下发时直接返回 'busy'（不发请求）。
 * 成功 / 失败 / 未知之后都回读一次；未知结果的回读状态记进结果里，回读结束才释放项目锁。
 */
export async function runWrite(o: RunWrite): Promise<Outcome | 'busy'> {
  if (inflight.has(o.projectId)) return 'busy'
  inflight.set(o.projectId, o.target)
  results.delete(rk(o.projectId, o.target))
  emit()
  let outcome: Outcome
  try {
    await o.send()
    outcome = 'ok'
    if (stillCurrent(o.projectId)) o.toast(o.okText)
    else results.set(rk(o.projectId, o.target), { outcome: 'ok', text: o.okText })
  } catch (e) {
    const c = classify(e)
    outcome = c.outcome
    if (c.outcome === 'unknown') {
      results.set(rk(o.projectId, o.target), { outcome: 'unknown', text: c.text, readback: 'pending' })
      if (stillCurrent(o.projectId)) o.toast(`${o.subject} 下发结果未知：${c.text}`, true)
    } else {
      results.set(rk(o.projectId, o.target), { outcome: 'fail', text: c.text })
      if (stillCurrent(o.projectId)) o.toast(`${o.subject} ${c.text}`, true)
    }
  }
  emit()
  let read = false
  try { read = await o.readback() } catch { read = false }
  const k = rk(o.projectId, o.target)
  const r = results.get(k)
  if (r?.outcome === 'unknown') results.set(k, { ...r, readback: read ? 'ok' : 'fail' })
  inflight.delete(o.projectId)
  emit()
  return outcome
}

/** 订阅某个项目的下发状态（busy 目标；version 变化时组件重渲染再读结果） */
export function useWrites(projectId: string): { busy: string | null; result: (target: string) => WriteResult | null } {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return { busy: busyTarget(projectId), result: (t) => getResult(projectId, t) }
}
function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }
const getVersion = () => version

/** 仅供测试 */
export function __resetWritesForTests() {
  inflight = new Map()
  results = new Map()
  emit()
}
