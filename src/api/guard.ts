// 写操作防护：所有下发类调用（ctrl 201、203、204、206 和批量统一控制）都必须经过这里。
// 规则（方案 3.6，按 S4 要求简化）：
// - writeMode='off'：全部拦截；
// - 默认 writeMode='test-only'：只在测试环境放行，生产环境一律拦截；
// - 生产环境下发必须在运行时配置里显式写 writeMode='on'（须负责人确认）；
// - writeProjectIds 非空时，只放行名单里的项目（任何环境都生效）。
// 判断不出环境时 config.ts 按生产处理，所以「不确定」等于「拦截」。
import { getConfig, type RuntimeConfig } from './config'
import { ApiError } from './errors'

export type WriteOp = 'ctrl-201' | 'ctrl-203' | 'ctrl-204' | 'ctrl-206' | 'unified-ctrls-send'
export const WRITE_OPS: readonly WriteOp[] = ['ctrl-201', 'ctrl-203', 'ctrl-204', 'ctrl-206', 'unified-ctrls-send']

export type WriteDecision = { ok: true } | { ok: false; reason: string }

export function checkWrite(op: WriteOp, projectIds: readonly string[], cfg: RuntimeConfig = getConfig()): WriteDecision {
  if (!WRITE_OPS.includes(op)) return { ok: false, reason: `未登记的写操作：${op}` }
  if (cfg.writeMode === 'off') return { ok: false, reason: '下发已关闭（writeMode=off）' }
  if (cfg.apiEnv !== 'test' && cfg.writeMode !== 'on') return { ok: false, reason: '生产环境下发未开启' }
  if (!projectIds.length) return { ok: false, reason: '未指定项目' }
  if (cfg.writeProjectIds.length) {
    const outside = projectIds.filter((id) => !cfg.writeProjectIds.includes(id))
    if (outside.length) return { ok: false, reason: `项目不在下发名单内：${outside.join('、')}` }
  }
  return { ok: true }
}

export function assertWriteAllowed(op: WriteOp, projectIds: readonly string[], cfg?: RuntimeConfig) {
  const d = checkWrite(op, projectIds, cfg)
  if (!d.ok) throw new ApiError('write_blocked', d.reason)
}

/** 统一入口：先过防护，再执行真正的下发 */
export async function guardedWrite<T>(op: WriteOp, projectIds: readonly string[], run: () => Promise<T>): Promise<T> {
  assertWriteAllowed(op, projectIds)
  return run()
}
