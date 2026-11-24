// 运行时配置：默认值 ← 构建时变量（VITE_*）← public/config.js 里的 window.__HJC_CONFIG__。
// 部署时只改 config.js 即可换后端；测试里用 setConfig() 覆盖。

export type ApiEnv = 'test' | 'prod'
export type DataSource = 'mock' | 'real'
export type WriteMode = 'test-only' | 'off' | 'on'

export interface RuntimeConfig {
  /** 接口基址，不带结尾斜杠。相对路径（'/api'）或完整地址（'https://…/v1'） */
  apiBase: string
  /** 后端所在环境。完整地址时由域名决定；相对路径时取配置，未配置按生产处理 */
  apiEnv: ApiEnv
  /** 'mock' 演示数据（现有页面）；'real' 真实接口 */
  dataSource: DataSource
  /** 写操作（下发）开关，见 guard.ts */
  writeMode: WriteMode
  /** 非空时只允许对这些项目下发 */
  writeProjectIds: string[]
  /** 普通请求超时（毫秒） */
  requestTimeoutMs: number
  /** ctrl 同步消息超时（毫秒）：服务端等控制屏 10 秒，前端多留 2 秒 */
  ctrlTimeoutMs: number
}

/** 测试环境（开发、联调默认连这里） */
export const TEST_API_ORIGIN = 'https://test.cosyhome.com.cn:9443/v1'
const TEST_HOSTS = new Set(['test.cosyhome.com.cn'])

declare global {
  interface Window { __HJC_CONFIG__?: Partial<RuntimeConfig> }
}
// vite.config.ts 注入：开发服务器 /api 代理的目标地址（构建产物里为空串）
declare const __HJC_DEV_PROXY_TARGET__: string | undefined

const isAbsolute = (u: string) => /^https?:\/\//i.test(u)

/** 按域名判断完整地址属于哪个环境；不认识的域名一律当生产 */
export function envOfUrl(url: string): ApiEnv {
  try { return TEST_HOSTS.has(new URL(url).hostname) ? 'test' : 'prod' } catch { return 'prod' }
}

type Input = Partial<Omit<RuntimeConfig, 'apiEnv'>> & { apiEnv?: string }

/** 合并各层配置并推导 apiEnv。导出供测试使用 */
export function resolveConfig(layers: Input[], devProxyTarget = ''): RuntimeConfig {
  const m: Input = Object.assign({}, ...layers.filter(Boolean))
  const apiBase = String(m.apiBase || '/api').replace(/\/+$/, '')
  let apiEnv: ApiEnv
  if (isAbsolute(apiBase)) apiEnv = envOfUrl(apiBase)
  else if (m.apiEnv === 'test' || m.apiEnv === 'prod') apiEnv = m.apiEnv
  else if (devProxyTarget) apiEnv = envOfUrl(devProxyTarget)
  else apiEnv = 'prod'
  const writeMode: WriteMode = m.writeMode === 'off' || m.writeMode === 'on' ? m.writeMode : 'test-only'
  return {
    apiBase,
    apiEnv,
    dataSource: m.dataSource === 'real' ? 'real' : 'mock',
    writeMode,
    writeProjectIds: Array.isArray(m.writeProjectIds) ? m.writeProjectIds.map(String) : [],
    requestTimeoutMs: Number(m.requestTimeoutMs) > 0 ? Number(m.requestTimeoutMs) : 10_000,
    ctrlTimeoutMs: Number(m.ctrlTimeoutMs) > 0 ? Number(m.ctrlTimeoutMs) : 12_000,
  }
}

function buildTimeLayer(): Input {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
  const out: Input = {}
  if (env.VITE_API_BASE) out.apiBase = env.VITE_API_BASE
  if (env.VITE_API_ENV) out.apiEnv = env.VITE_API_ENV
  if (env.VITE_DATA_SOURCE) out.dataSource = env.VITE_DATA_SOURCE as DataSource
  if (env.VITE_WRITE_MODE) out.writeMode = env.VITE_WRITE_MODE as WriteMode
  return out
}

let current: RuntimeConfig | null = null

export function getConfig(): RuntimeConfig {
  if (!current) {
    const runtime = typeof window !== 'undefined' ? window.__HJC_CONFIG__ ?? {} : {}
    const proxy = typeof __HJC_DEV_PROXY_TARGET__ === 'string' ? __HJC_DEV_PROXY_TARGET__ : ''
    current = resolveConfig([buildTimeLayer(), runtime], proxy)
  }
  return current
}

/** 测试与手动联调脚本用：在默认值之上覆盖（不读 window 与构建变量） */
export function setConfig(patch: Input | null): RuntimeConfig {
  current = patch ? resolveConfig([patch]) : null
  return getConfig()
}

export const isMockMode = () => getConfig().dataSource === 'mock'
