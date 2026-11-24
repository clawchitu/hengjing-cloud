// 统一控制的下发日志（脱敏）。只记：事件、固定的结果/错误码、ApiError 的 kind、字段名、项目编号、
// 首尾 4 位的项目 id。不记任何错误原文、文案、下发的值、user_id、令牌、回读内容。
// makeEntry() 对每一项按白名单过滤，调用方传了别的东西也进不了日志。
import type { ApiErrorKind } from '@/api/errors'
import { ECHO_FIELDS, type EchoField, type IssueCode } from './rules'

export type UnifiedLogEvent =
  | 'confirm' | 'cancel' | 'blocked' | 'aborted' | 'read-before' | 'send' | 'read-after' | 'success' | 'failure' | 'unknown'

/** 流程里的固定代码 */
export type FlowCode =
  | 'OK' | 'VERIFIED' | 'NOT_VERIFIED' | 'ECHO_MISMATCH' | 'READ_FAILED' | 'PROJECT_CHANGED' | 'ABORTED'
  | 'NOT_SENT' | 'REJECTED' | 'UNKNOWN'
export type LogCode = FlowCode | IssueCode

const LOG_CODES = new Set<string>([
  'OK', 'VERIFIED', 'NOT_VERIFIED', 'ECHO_MISMATCH', 'READ_FAILED', 'PROJECT_CHANGED', 'ABORTED', 'NOT_SENT', 'REJECTED', 'UNKNOWN',
  'NO_PROJECT', 'OFFLINE', 'BAD_SWITCH', 'BAD_MODE', 'TEMP_DISABLED', 'TEMP_INVALID', 'TEMP_WHILE_ROOM_OFF', 'NO_CHANGES',
] satisfies LogCode[])
const ERROR_KINDS = new Set<string>([
  'unauthenticated', 'forbidden', 'unavailable', 'timeout', 'network', 'bad_request', 'server', 'ctrl', 'write_blocked', 'aborted',
] satisfies ApiErrorKind[])
const EVENTS = new Set<string>(['confirm', 'cancel', 'blocked', 'aborted', 'read-before', 'send', 'read-after', 'success', 'failure', 'unknown'] satisfies UnifiedLogEvent[])
const FIELDS = new Set<string>(ECHO_FIELDS)
/** 项目编号：只允许数字（如 240829001），其他一律不记 */
const PROJECT_CODE = /^\d{1,20}$/

export interface UnifiedLogEntry {
  event: UnifiedLogEvent
  at: string
  projectCode?: string
  /** 后端项目 id，只留首尾 4 位 */
  projectId?: string
  codes?: LogCode[]
  /** 出错时 ApiError 的 kind；不是 ApiError 记 'other' */
  errorKind?: ApiErrorKind | 'other'
  /** 涉及的字段名（下发了哪些、哪些回读不一致） */
  fields?: EchoField[]
}

export type UnifiedLogger = (entry: UnifiedLogEntry) => void

/** 长 id 只保留首尾 4 位；8 位及以下全部打码 */
export function maskId(id: string | undefined | null): string | undefined {
  if (!id) return undefined
  const s = String(id)
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-4)}`
}

export interface EntryInput {
  projectCode?: string
  projectId?: string
  codes?: readonly string[]
  error?: unknown
  fields?: readonly string[]
}

/** 错误对象 → 只取 kind（白名单），其余丢弃 */
export function errorKindOf(e: unknown): ApiErrorKind | 'other' | undefined {
  if (e === undefined || e === null) return undefined
  const k = (e as { kind?: unknown }).kind
  return typeof k === 'string' && ERROR_KINDS.has(k) ? (k as ApiErrorKind) : 'other'
}

export function makeEntry(event: UnifiedLogEvent, p: EntryInput = {}, now = new Date()): UnifiedLogEntry {
  const e: UnifiedLogEntry = { event: EVENTS.has(event) ? event : ('blocked' as UnifiedLogEvent), at: now.toISOString() }
  if (p.projectCode && PROJECT_CODE.test(String(p.projectCode))) e.projectCode = String(p.projectCode)
  const id = maskId(p.projectId)
  if (id) e.projectId = id
  const codes = [...new Set((p.codes ?? []).filter((c) => LOG_CODES.has(c)))] as LogCode[]
  if (codes.length) e.codes = codes
  const kind = errorKindOf(p.error)
  if (kind) e.errorKind = kind
  const fields = [...new Set((p.fields ?? []).filter((f) => FIELDS.has(f)))] as EchoField[]
  if (fields.length) e.fields = fields
  return e
}

/** 默认日志：打到控制台 */
export const consoleLogger: UnifiedLogger = (entry) => { console.info('[unified-ctrl]', JSON.stringify(entry)) }
