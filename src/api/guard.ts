// 写操作防护。所有下发类接口（ctrl 201、203、204、206 和批量统一控制）只有一个入口：
// http.ts 的 requestWrite()，它在发送前调用这里的 assertWriteAllowed()；普通的 request()
// 遇到写接口路径直接拒绝（isWritePath），所以无法绕开。
// 规则（方案 3.6，按 S4 要求简化）：
// - writeMode='off'：全部拦截；
// - 默认 writeMode='test-only'：只在测试环境放行，生产环境一律拦截；
// - 生产环境下发必须在运行时配置里显式写 writeMode='on'（须负责人确认）；
// - writeProjectIds 非空时，只放行名单里的项目（任何环境都生效）。
// 判断不出环境时 config.ts 按生产处理，所以「不确定」等于「拦截」。
import { getConfig, type RuntimeConfig } from './config'
import { ApiError } from './errors'

/** 写接口 → 路径（相对 apiBase） */
export const WRITE_ROUTES = {
  'ctrl-201': '/ctrl/room-temperature-set',
  'ctrl-203': '/ctrl/unified-ctrl-set',
  'ctrl-204': '/ctrl/running-ctrl-set',
  'ctrl-206': '/ctrl/project-room-switch-set',
  'unified-ctrls-send': '/ctrl/unified-ctrls-send',
} as const

export type WriteOp = keyof typeof WRITE_ROUTES
export const WRITE_OPS = Object.keys(WRITE_ROUTES) as WriteOp[]

const normPath = (p: string) => ('/' + p.split(/[?#]/)[0].replace(/^\/+/, '').replace(/^v1\//, '')).replace(/\/+$/, '')
const WRITE_PATHS = new Set<string>(Object.values(WRITE_ROUTES))

/**
 * 是否写接口路径。除了已登记的 5 个，ctrl 下所有 *-set / *-send / 透传控制消息也按写处理，
 * 防止以后新增的下发接口不小心走普通请求。
 */
export function isWritePath(path: string): boolean {
  const p = normPath(path)
  return WRITE_PATHS.has(p) || /^\/ctrl\/.*(-set|-send|-ctrl-message)$/.test(p) || /^\/ctrl\/(trans|pass)-ctrl-message/.test(p)
}

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
