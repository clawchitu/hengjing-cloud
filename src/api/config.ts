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
  /** 下发白名单（项目 code，不是实体 id）。只允许对名单里的项目下发；为空则拒绝所有写操作 */
  writeProjectCodes: readonly string[]
  /** 普通请求超时（毫秒） */
  requestTimeoutMs: number
  /** ctrl 同步消息超时（毫秒）：服务端等控制屏 10 秒，前端多留 2 秒 */
  ctrlTimeoutMs: number
  /** 功能开关（S10 新风、S7 天气里等后端答复的点），见 FEATURE_DEFAULTS 与 docs/plan-s10-s7.md 2.1 */
  features: Readonly<Features>
}

/** 功能开关。后端答复后只改默认值，不改代码路径 */
export interface Features {
  /** 'off'：新风运行设置面板只读（写防护照常生效，这个开关只管界面） */
  freshAirWrite: 'on' | 'off'
  /** 滤网寿命的红、橙色和「请尽快更换」提示（阈值按 filter_life_p 的比例算，见 src/features/freshAir/filter.ts） */
  freshAirFilterWarn: boolean
  /**
   * 200 里的房间开关是否可信（后端 11/25 答复第 1 条：控制屏没上报房间状态，读到的是默认值 0，后端会修；修好后改成 true）。
   * false 时：房间开关显示「未知」、核对开关一律无法核对、不拿它禁用温度和节能（温控「房间关着只能开房间」、统一控制「房间全关」）。
   * 只管真实接口；演示数据的房间开关是真实的，按 true 处理（见 roomSwitchReported()）
   */
  roomSwitchReported: boolean
  /** 候选城市是否用 /wx/city-list 过滤：'auto' 调用成功且非空才取交集；'intersect' 严格取交集；'none' 不调 */
  weatherCityFilter: 'auto' | 'intersect' | 'none'
  /** /weather 失败时用 /weather24 最近一小时顶替实时数据 */
  weatherNowFallback: boolean
}

export const FEATURE_DEFAULTS: Readonly<Features> = Object.freeze({
  freshAirWrite: 'on',
  freshAirFilterWarn: true,
  roomSwitchReported: false,
  weatherCityFilter: 'auto',
  weatherNowFallback: true,
})

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const oneOf = <T extends string>(...xs: T[]) => (v: unknown): v is T => typeof v === 'string' && (xs as string[]).includes(v)
const FEATURE_VALID: { [K in keyof Features]: (v: unknown) => v is Features[K] } = {
  freshAirWrite: oneOf('on', 'off'),
  freshAirFilterWarn: isBool,
  roomSwitchReported: isBool,
  weatherCityFilter: oneOf('auto', 'intersect', 'none'),
  weatherNowFallback: isBool,
}

/**
 * 功能开关按键合并：每个键取最后一个写了它的层；那一层的值不合法就用默认值（不报错、不回退到更早的层）。
 * 不是对象的 features、不认识的键都忽略。结果冻结。
 */
function parseFeatures(layers: Input[]): Readonly<Features> {
  const out: Record<string, unknown> = { ...FEATURE_DEFAULTS }
  for (const l of layers) {
    const f = l?.features
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue
    for (const k of Object.keys(FEATURE_VALID) as (keyof Features)[]) {
      if (!Object.prototype.hasOwnProperty.call(f, k)) continue
      const v = (f as Record<string, unknown>)[k]
      out[k] = FEATURE_VALID[k](v) ? v : FEATURE_DEFAULTS[k]
    }
  }
  return Object.freeze(out as unknown as Features)
}

/** 测试环境（开发、联调默认连这里） */
export const TEST_API_ORIGIN = 'https://test.cosyhome.com.cn:9443/v1'
const TEST_HOSTS = new Set(['test.cosyhome.com.cn'])

declare global {
  interface Window { __HJC_CONFIG__?: Partial<Omit<RuntimeConfig, 'features'>> & { features?: Partial<Features> } }
}
// vite.config.ts 注入：开发服务器 /api 代理的目标地址（构建产物里为空串）
declare const __HJC_DEV_PROXY_TARGET__: string | undefined

/** 下发白名单默认值（测试项目 code） */
export const DEFAULT_WRITE_PROJECT_CODES: readonly string[] = Object.freeze(['260911001', '240829001'])

/**
 * 白名单解析：各层都没有写这个键才用默认值；写了就以最后一层为准（写成 undefined / null 也算写了，按空名单）。
 * 数组只留非空字符串；逗号分隔字符串（环境变量）拆开；其他类型按空名单（全拒）。结果冻结，运行中不能改。
 */
function parseCodes(layers: Input[]): readonly string[] {
  const set = layers.filter((l) => l && Object.prototype.hasOwnProperty.call(l, 'writeProjectCodes'))
  if (!set.length) return DEFAULT_WRITE_PROJECT_CODES
  const v = set[set.length - 1].writeProjectCodes
  const list: unknown[] = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : []
  return Object.freeze(list.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean))
}

const isAbsolute = (u: string) => /^(https?:)?\/\//i.test(u)

/** 按域名判断完整地址属于哪个环境；不认识的域名一律当生产 */
export function envOfUrl(url: string): ApiEnv {
  try { return TEST_HOSTS.has(new URL(url.startsWith('//') ? 'https:' + url : url).hostname) ? 'test' : 'prod' } catch { return 'prod' }
}

type Input = Partial<Omit<RuntimeConfig, 'apiEnv' | 'writeProjectCodes' | 'features'>> & { apiEnv?: string; writeProjectCodes?: unknown; features?: unknown }

/**
 * 合并各层配置并推导 apiEnv。导出供测试使用。
 * mockAllowed 默认取构建期常量 __HJC_MOCK__（见 src/build-flags.d.ts）；为 false（生产交付包）时 dataSource 一律为 'real'，config.js 里写 'mock' 也无效。
 */
export function resolveConfig(layers: Input[], devProxyTarget = '', mockAllowed = __HJC_MOCK__): RuntimeConfig {
  const m: Input = Object.assign({}, ...layers.filter(Boolean))
  const apiBase = String(m.apiBase || '/api').replace(/\/+$/, '')
  let apiEnv: ApiEnv
  if (isAbsolute(apiBase)) apiEnv = envOfUrl(apiBase)
  else if (m.apiEnv === 'test' || m.apiEnv === 'prod') apiEnv = m.apiEnv
  // 开发代理只转发 /api，其他相对路径不知道指向哪里
  else if (devProxyTarget && apiBase === '/api') apiEnv = envOfUrl(devProxyTarget)
  else apiEnv = 'prod'
  const writeMode: WriteMode = m.writeMode === 'off' || m.writeMode === 'on' ? m.writeMode : 'test-only'
  return {
    apiBase,
    apiEnv,
    dataSource: !mockAllowed || m.dataSource === 'real' ? 'real' : 'mock',
    writeMode,
    writeProjectCodes: parseCodes(layers),
    requestTimeoutMs: Number(m.requestTimeoutMs) > 0 ? Number(m.requestTimeoutMs) : 10_000,
    ctrlTimeoutMs: Number(m.ctrlTimeoutMs) > 0 ? Number(m.ctrlTimeoutMs) : 12_000,
    features: parseFeatures(layers),
  }
}

function buildTimeLayer(): Input {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
  const out: Input = {}
  if (env.VITE_API_BASE) out.apiBase = env.VITE_API_BASE
  if (env.VITE_API_ENV) out.apiEnv = env.VITE_API_ENV
  if (env.VITE_DATA_SOURCE) out.dataSource = env.VITE_DATA_SOURCE as DataSource
  if (env.VITE_WRITE_MODE) out.writeMode = env.VITE_WRITE_MODE as WriteMode
  // 逗号分隔；设为空串即「名单为空，拒绝所有写操作」
  if (env.VITE_WRITE_PROJECT_CODES !== undefined) out.writeProjectCodes = env.VITE_WRITE_PROJECT_CODES
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

/**
 * 200 的房间开关能不能用（features.roomSwitchReported；演示数据模式恒为 true）。核对、禁用规则、界面显示都只认这一个判断
 */
export const roomSwitchReported = () => isMockMode() || getConfig().features.roomSwitchReported === true

/** 演示数据模式。交付包里恒为 false；需要在打包时剔除的演示代码另用 __HJC_MOCK__ 直接判断（函数调用不会被常量折叠） */
export const isMockMode = () => __HJC_MOCK__ && getConfig().dataSource === 'mock'
