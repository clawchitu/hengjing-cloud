// H1 真实测试服只读 e2e 的请求放行规则（纯函数，单元测试见 policy.test.ts）。
//
// 只放行白名单里明确列出的「方法 + 路由」：这个后端的读接口大多也是 POST（ctrl 读、列表查询），
// 所以不能按「非 GET 就拦」，只能按路由白名单。白名单之外的一律在请求发出前 abort 并记为违规（用例失败）。
// ctrl 读路由和写路由都从 src/api/ctrl.ts 的 CTRL / WRITE_CTRL 与 src/api/guard.ts 的 WRITE_ROUTES 取，不手抄。
import { CTRL, WRITE_CTRL, type CtrlType } from '../src/api/ctrl'
import { isWritePath, WRITE_ROUTES } from '../src/api/guard'

/**
 * 允许的被测站点（前端所在的源；/api/* 由它转发到测试服）：
 * - local：本机 vite 开发服务器，开发代理固定指向测试服（playwright.live.config.ts 里强制 VITE_PROXY_TARGET）；
 * - demo：测试站 hvac-demo，Worker 只允许测试环境上游。
 * 其他源一律不接受（不连生产）。
 */
export const TARGET_ORIGINS = Object.freeze({ local: 'http://localhost:5174', demo: 'https://hvac-demo.haoqianglyu.com' })
export type TargetKind = keyof typeof TARGET_ORIGINS
const API_PREFIX = '/api'

const ctrlTypes = Object.keys(CTRL).map(Number) as CtrlType[]
const isWriteType = (t: number) => (WRITE_CTRL as readonly number[]).includes(t)

/** 写路由（黑名单，仅用于报告与交叉校验；白名单之外本来就全拦）：WRITE_CTRL 对应的 ctrl 路由 ∪ guard.ts 的 WRITE_ROUTES */
export const WRITE_PATHS: readonly string[] = Object.freeze([...new Set([
  ...WRITE_CTRL.map((t) => `/ctrl/${CTRL[t].route}`),
  ...Object.values(WRITE_ROUTES),
])].sort())

/** ctrl 读路由（200/202/205/207/208/209/210），从 CTRL 里去掉 WRITE_CTRL 得到 */
export const CTRL_READ_PATHS: readonly string[] = Object.freeze(ctrlTypes.filter((t) => !isWriteType(t)).map((t) => `/ctrl/${CTRL[t].route}`))

type Method = 'GET' | 'POST'

/** 只读白名单（方法 + 路由，路由相对 /api）。按被测页面实际发出的请求逐条列出 */
const READ_ROUTES: readonly (readonly [Method, string])[] = [
  ['GET', '/me'], // 会话恢复、登录后取身份
  ['POST', '/ctrl/projects'], // 项目列表（含在线状态）
  ['POST', '/integrated-projects'], // 集成项目
  ['POST', '/integrated-projects/stat'], // 首页统计卡
  ['POST', '/distributors'], // 平台账号的经销商分段
  ['POST', '/apps'], // 应用名称
  ['POST', '/projects/frequent'], // 首页常用项目
  ['POST', '/weather'], // 首页天气：实时 + 7 天（S7b）
  ['POST', '/weather24'], // 首页天气：24 小时（S7b）
  ...CTRL_READ_PATHS.map((p) => ['POST', p] as const),
]
export const READ_ALLOW: readonly string[] = Object.freeze(READ_ROUTES.map(([m, p]) => `${m} ${p}`))

/** 登录：只在 setup 项目里放行（每个账号每次运行一次），其余用例里出现即违规 */
export const LOGIN = 'POST /auth/login'

/** 有副作用的点击上报：abort（不发到服务器），但不算违规——切换项目时前端会发，失败只记日志、不影响切换 */
const SILENT_ABORT = /^\/project\/click\/[A-Za-z0-9]+$/

/** Cloudflare 给测试站自动注入的访问统计（beacon 脚本与上报）：与业务无关，abort、不算违规 */
const CF_INSIGHTS_ORIGIN = 'https://static.cloudflareinsights.com'
const CF_RUM_PATH = '/cdn-cgi/rum'

// 启动即自检：白名单与写路由交集为空；白名单里每一条都不被 guard.ts 认作写路径。不满足直接抛错，不跑任何用例。
for (const entry of READ_ALLOW) {
  const path = entry.slice(entry.indexOf(' ') + 1)
  if (WRITE_PATHS.includes(path) || isWritePath(path)) throw new Error(`只读白名单里混入了写路由：${entry}`)
}

export type Decision =
  | { action: 'allow' }
  | { action: 'abort-silent'; reason: string }
  | { action: 'abort'; reason: string }

/**
 * 判定一个请求。opts.origin 是本次运行的被测站点；opts.allowLogin 只在 setup 项目里为 true。
 * - Cloudflare 自动注入的访问统计：abort（不算违规）
 * - 非被测站点（opts.origin）：abort（违规）
 * - 被测站点的静态资源（非 /api）：只放行 GET / HEAD
 * - /api：命中写路由、/auth/refresh、/auth/invalidate、白名单之外 → abort（违规）；/project/click/{id} → abort（不算违规）
 */
export function decide(method: string, rawUrl: string, opts: { origin: string; allowLogin?: boolean }): Decision {
  if (!(Object.values(TARGET_ORIGINS) as string[]).includes(opts.origin)) return { action: 'abort', reason: `未登记的被测站点 ${opts.origin}` }
  let url: URL
  try { url = new URL(rawUrl) } catch { return { action: 'abort', reason: '无法解析的地址' } }
  const m = method.toUpperCase()
  if (url.origin === CF_INSIGHTS_ORIGIN && m === 'GET') return { action: 'abort-silent', reason: 'Cloudflare 访问统计脚本' }
  if (url.origin !== opts.origin) return { action: 'abort', reason: `非被测站点的请求 ${m} ${url.origin}` }
  const path = url.pathname
  if (path === CF_RUM_PATH && m === 'POST') return { action: 'abort-silent', reason: 'Cloudflare 访问统计上报' }
  if (path !== API_PREFIX && !path.startsWith(API_PREFIX + '/')) {
    return m === 'GET' || m === 'HEAD' ? { action: 'allow' } : { action: 'abort', reason: `静态路径上的 ${m} ${path}` }
  }
  const rest = path.slice(API_PREFIX.length)
  if (isWritePath(rest) || WRITE_PATHS.includes(rest)) return { action: 'abort', reason: `写路由 ${m} ${rest}` }
  if (/^\/auth\/refresh\/?$/i.test(rest)) return { action: 'abort', reason: `续期 ${m} ${rest}（12.6：全程不续期）` }
  if (/^\/auth\/invalidate\/?$/i.test(rest)) return { action: 'abort', reason: `作废令牌 ${m} ${rest}` }
  if (m === 'POST' && SILENT_ABORT.test(rest)) return { action: 'abort-silent', reason: `点击上报 ${rest}` }
  const key = `${m} ${rest}`
  if (key === LOGIN) return opts.allowLogin ? { action: 'allow' } : { action: 'abort', reason: '用例里出现第二次登录（只允许 setup 登录一次）' }
  // 白名单逐字比对：大小写、结尾斜杠、查询串都必须一致
  if (!url.search && READ_ALLOW.includes(key)) return { action: 'allow' }
  return { action: 'abort', reason: `白名单之外 ${key}${url.search ? '（带查询串）' : ''}` }
}
