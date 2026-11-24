// 统一控制的下发日志（脱敏）。只记录核对需要的信息：事件、项目编号、脱敏后的项目 id、下发的值、
// 结果和错误文案；不记录令牌、user_id、回读的原始数据。所有文本过 errors.ts 的 redact()。
import { redact } from '@/api/errors'

export type UnifiedLogEvent = 'confirm' | 'cancel' | 'blocked' | 'read-before' | 'send' | 'read-after' | 'success' | 'failure'

export interface UnifiedLogEntry {
  event: UnifiedLogEvent
  /** 项目编号（如 240829001），不敏感，便于对照 PR 里的记录 */
  projectCode?: string
  /** 后端项目 id，只留首尾各 4 位 */
  projectId?: string
  /** 下发的值（203 Query，全是数字） */
  query?: Record<string, number>
  /** 错误或核对结果的文案（已脱敏） */
  message?: string
  at: string
}

export type UnifiedLogger = (entry: UnifiedLogEntry) => void

/** 长 id 只保留首尾 4 位；8 位及以下全部打码 */
export function maskId(id: string | undefined | null): string | undefined {
  if (!id) return undefined
  const s = String(id)
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-4)}`
}

/** 只保留有限数值字段，丢掉其他任何东西 */
function numbersOnly(q: object | undefined): Record<string, number> | undefined {
  if (!q) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(q)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  return out
}

export function makeEntry(event: UnifiedLogEvent, p: { projectCode?: string; projectId?: string; query?: object; message?: string } = {}, now = new Date()): UnifiedLogEntry {
  const e: UnifiedLogEntry = { event, at: now.toISOString() }
  if (p.projectCode) e.projectCode = redact(String(p.projectCode))
  const id = maskId(p.projectId)
  if (id) e.projectId = id
  const q = numbersOnly(p.query)
  if (q) e.query = q
  if (p.message) e.message = redact(String(p.message))
  return e
}

/** 默认日志：打到控制台 */
export const consoleLogger: UnifiedLogger = (entry) => { console.info('[unified-ctrl]', JSON.stringify(entry)) }
