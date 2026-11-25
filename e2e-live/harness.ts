// H1 真实测试服只读 e2e 的公共夹具：
// - 每个用例的 context 在 context.route 层装请求闸门（policy.ts），请求发出前就 abort，违规记账、用例结束时判失败；
// - 记录 /api 的读回包，供断言「界面结论与只读接口返回一致」；
// - 登录态来自 setup 项目保存的 storageState（每个账号每次运行只登录一次），用例里不登录、不续期；
// - 每个用例开始前核对目标是测试站、令牌剩余时间够跑完。
import { readFileSync } from 'node:fs'
import { expect, test as base, type BrowserContext, type Page, type Request } from '@playwright/test'
import { CTRL, decodeReply, type CtrlReply, type CtrlType } from '../src/api/ctrl'
import { REFRESH_LEEWAY_MS } from '../src/api/http'
import { TOKEN_KEY } from '../src/api/tokens'
import { decide } from './policy'
import { ORIGIN, TARGET } from './target'

export type Role = 'platform' | 'dealer'
export const authFile = (role: Role) => `e2e-live/.auth/${role}.json`
export const metaFile = (role: Role) => `e2e-live/.auth/${role}.meta.json`
export interface AuthMeta { role: Role; loginAt: number; expiresAt: number }

/** 令牌至少还要剩这么久才开跑一个用例（app 在到期前 REFRESH_LEEWAY_MS 内会主动续期，留出用例本身的时长） */
export const MIN_TOKEN_LEFT_MS = REFRESH_LEEWAY_MS + 10 * 60_000

/**
 * 闸门记账：违规（用例失败）、静默 abort（点击上报等）、已放行的登录次数、剩余登录许可、
 * 去敏的网络记录（只有判定、方法、路径）
 */
export interface Ledger { violations: string[]; silent: string[]; logins: number; loginPermits: number; net: string[] }
export const newLedger = (): Ledger => ({ violations: [], silent: [], logins: 0, loginPermits: 0, net: [] })

const LOGIN_PATH = '/api/auth/login'

/**
 * 装闸门（context 级：同一 context 里新开的页面、弹窗、iframe 都经过它）：
 * - 普通请求：context.route 在请求发出前按 policy.ts 判定，放行之外的 abort；
 * - 登录：opts.loginPermits 给出本 context 可放行的登录次数（只有 setup 给 1）。许可在 route.continue() 之前同步扣减，
 *   第二次（含并发的第二个）在发出前 abort 并判违规；
 * - 重定向：route 只对重定向链的第一个地址调用，所以在 request 事件里对 redirectedFrom() 非空的请求再判一次，
 *   不该放行的判违规（此时已发出，无法再拦，只能让用例失败）；
 * - WebSocket：一律关闭并判违规。唯一例外是本机目标下 vite 开发服务器自己的热更新连接（只连本机，不到测试服）。
 * opts.selfCheck 只给闸门自检用：放行的请求交给更早注册的本地兜底，整个自检不发任何网络请求
 */
export async function installGate(context: BrowserContext, ledger: Ledger, opts: { loginPermits?: number; selfCheck?: boolean } = {}) {
  ledger.loginPermits = opts.loginPermits ?? 0
  const allowLogin = ledger.loginPermits > 0
  await context.route('**/*', async (route) => {
    const req = route.request()
    const d = decide(req.method(), req.url(), { origin: ORIGIN, allowLogin })
    const u = URL.canParse(req.url()) ? new URL(req.url()) : null
    // 只记 /api 和非本站的请求（静态资源太多）；只记方法、源和路径，不记查询串、请求头、请求体
    if (u && (u.origin !== ORIGIN || u.pathname.startsWith('/api'))) ledger.net.push(`${d.action} ${req.method()} ${u.origin === ORIGIN ? '' : u.origin}${u.pathname}`)
    if (d.action === 'allow') {
      if (req.method() === 'POST' && u?.pathname === LOGIN_PATH) {
        // 同步的检查加扣减（中间没有 await），并发的两个登录请求也只有一个能拿到许可
        if (ledger.loginPermits <= 0) {
          ledger.violations.push('登录许可已用完：第二次登录在发出前被拦（每个账号每次运行只登录一次）')
          return route.abort('blockedbyclient')
        }
        ledger.loginPermits--
        ledger.logins++
      }
      return opts.selfCheck ? route.fallback() : route.continue()
    }
    if (d.action === 'abort-silent') ledger.silent.push(d.reason)
    else ledger.violations.push(d.reason)
    return route.abort('blockedbyclient')
  })
  context.on('request', (req) => {
    if (!req.redirectedFrom()) return
    const d = decide(req.method(), req.url(), { origin: ORIGIN })
    if (d.action !== 'allow') ledger.violations.push(`重定向后的请求不在白名单：${d.reason}`)
  })
  await context.routeWebSocket(/.*/, (ws) => {
    const u = new URL(ws.url())
    if (TARGET === 'local' && u.host === new URL(ORIGIN).host && (u.protocol === 'ws:' || u.protocol === 'wss:')) {
      ws.connectToServer()
      return
    }
    ledger.violations.push(`WebSocket 一律不允许：${u.protocol}//${u.host}${u.pathname}`)
    void ws.close({ code: 1008, reason: 'H1 闸门：不允许 WebSocket' })
  })
}

export function assertGateClean(ledger: Ledger) {
  expect(ledger.violations, '出现了白名单之外的请求（已在发出前 abort）').toEqual([])
}

/** 一条 /api 回包记录（不含请求头，避免令牌进日志） */
export interface ApiHit { method: string; path: string; status: number; reqBody: Record<string, unknown> | null; json: unknown }

export class ApiLog {
  readonly hits: ApiHit[] = []
  /** 已发起的 /api 请求（路由与请求体），在 request 事件里同步记，不等回包；被闸门拦下的也算 */
  readonly sent: { path: string; reqBody: Record<string, unknown> | null }[] = []
  constructor(page: Page) {
    page.on('request', (req) => {
      const u = new URL(req.url())
      if (u.origin === ORIGIN && u.pathname.startsWith('/api/')) this.sent.push({ path: u.pathname.slice(4), reqBody: bodyOf(req) })
    })
    page.on('response', async (res) => {
      const req = res.request()
      const u = new URL(req.url())
      if (u.origin !== ORIGIN || !u.pathname.startsWith('/api/')) return
      let json: unknown = null
      try { json = await res.json() } catch { /* 非 JSON（403 no permission 等纯文本） */ }
      this.hits.push({ method: req.method(), path: u.pathname.slice(4), status: res.status(), reqBody: bodyOf(req), json })
    })
  }
  /** 是否发过这个路由的请求（不论回包是否已到） */
  wasSent(path: string) { return this.sent.some((x) => x.path === path) }
  all(path: string, filter: (h: ApiHit) => boolean = () => true) { return this.hits.filter((h) => h.path === path && filter(h)) }
  /** 等到至少一条匹配的回包，返回最新一条 */
  async latest(path: string, filter?: (h: ApiHit) => boolean, timeout = 20_000): Promise<ApiHit> {
    await expect.poll(() => this.all(path, filter).length, { timeout, message: `等待接口 ${path} 的回包` }).toBeGreaterThan(0)
    const list = this.all(path, filter)
    return list[list.length - 1]
  }
  /** ctrl 读回包按 src/api/ctrl.ts 的 Reply 定义解码（只解 200 状态的） */
  async ctrl<T extends CtrlType>(type: T, projectId: string, timeout = 25_000): Promise<{ hit: ApiHit; reply: CtrlReply<T> | null }> {
    const hit = await this.latest(`/ctrl/${CTRL[type].route}`, (h) => h.reqBody?.project_id === projectId, timeout)
    if (hit.status !== 200) return { hit, reply: null }
    return { hit, reply: decodeReply(CTRL[type].reply, (hit.json as { body?: string } | null)?.body) as CtrlReply<T> }
  }
  /** 对某个项目已发起的 ctrl 请求条数（按 request 事件统计，不等回包；离线空态不应发） */
  ctrlCalls(projectId: string) { return this.sent.filter((h) => h.path.startsWith('/ctrl/') && h.path !== '/ctrl/projects' && h.reqBody?.project_id === projectId).length }
}

function bodyOf(req: Request): Record<string, unknown> | null {
  try { const v = req.postDataJSON(); return v && typeof v === 'object' ? v as Record<string, unknown> : null } catch { return null }
}

/**
 * 目标核对（每个用例打开页面后都做一次）：
 * - 页面在本次登记的被测站点上；
 * - demo：Worker 生成的运行时配置是 apiEnv=test、真实数据、相对 /api（Worker 只允许测试环境上游）；
 * - local：public/config.js 不覆盖 apiBase / apiEnv / dataSource，生效的是 webServer 注入的构建变量（/api、test、real），
 *   /api 由开发代理转发到固定的测试服。
 */
export async function assertTestTarget(page: Page) {
  expect(new URL(page.url()).origin, '页面不在被测站点上').toBe(ORIGIN)
  const cfg = await page.evaluate(() => (window as unknown as { __HJC_CONFIG__?: Record<string, unknown> }).__HJC_CONFIG__ ?? null)
  if (TARGET === 'demo') expect(cfg, '测试站运行时配置').toMatchObject({ apiEnv: 'test', apiBase: '/api', dataSource: 'real' })
  else {
    expect(cfg, '本机 public/config.js').not.toBeNull()
    for (const k of ['apiBase', 'apiEnv', 'dataSource']) expect(Object.hasOwn(cfg!, k), `本机 config.js 不应覆盖 ${k}`).toBe(false)
  }
}

/** 浏览器里存的令牌过期时间（只取数字，不读令牌本身） */
export async function tokenExpiresAt(page: Page): Promise<number | null> {
  return page.evaluate((key) => {
    try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return typeof v?.expiresAt === 'number' ? v.expiresAt : null } catch { return null }
  }, TOKEN_KEY)
}

export function readMeta(role: Role): AuthMeta {
  return JSON.parse(readFileSync(metaFile(role), 'utf8')) as AuthMeta
}

/** 项目（/ctrl/projects 的实体，只取用到的字段） */
export interface LiveProject { id: string; name: string; code: string; online: boolean }
export interface LiveGroup { id: string; projectIds: string[] }
export interface LiveOrg { projects: LiveProject[]; groups: LiveGroup[]; visible: LiveProject[] }

/** 由 /ctrl/projects 与 /integrated-projects（不带经销商筛选的那次）的原始回包得到可见范围：集成项目里的项目 */
export async function orgFromApi(log: ApiLog): Promise<LiveOrg> {
  const p = await log.latest('/ctrl/projects', (h) => h.status === 200)
  const g = await log.latest('/integrated-projects', (h) => h.status === 200 && !h.reqBody?.distributor_id)
  const projects = ((p.json as { project_entities?: Record<string, unknown>[] }).project_entities ?? []).map((e) => ({
    id: String(e.id), name: String(e.name ?? ''), code: String(e.code ?? ''), online: e.online === true,
  }))
  const groups = ((g.json as { entities?: Record<string, unknown>[] }).entities ?? []).map((e) => ({
    id: String(e.id), projectIds: Array.isArray(e.project_ids) ? e.project_ids.map(String) : [],
  }))
  const ids = new Set(groups.flatMap((x) => x.projectIds))
  return { projects, groups, visible: projects.filter((x) => ids.has(x.id)) }
}

/** 用顶部搜索切换当前项目（按 code 搜，点结果），并等侧栏显示该项目 */
export async function switchProject(page: Page, p: LiveProject) {
  const box = page.getByRole('combobox', { name: '搜索项目' })
  await box.fill(p.code)
  const results = page.getByRole('listbox', { name: '项目搜索结果' })
  await results.getByRole('option').filter({ hasText: p.name }).first().click()
  await expect(page.locator('.proj-switch .name')).toHaveText(p.name)
}

export const test = base.extend<{ role: Role; ledger: Ledger; api: ApiLog }>({
  // 由 playwright.live.config.ts 的项目配置给出（platform / dealer）
  role: ['platform', { option: true }],
  ledger: async ({ context }, use, info) => {
    const ledger = newLedger()
    await installGate(context, ledger)
    await use(ledger)
    await info.attach('network.txt', { body: ledger.net.join('\n') || '（无）', contentType: 'text/plain' })
    assertGateClean(ledger)
  },
  page: async ({ page, ledger, role }, use, info) => {
    if (info.project.name !== role) throw new Error(`项目 ${info.project.name} 与账号 ${role} 不一致`)
    // 未捕获的前端异常也记为违规（白屏、崩溃类）
    page.on('pageerror', (e) => ledger.violations.push(`前端未捕获异常：${e.name}: ${e.message.slice(0, 200)}`))
    const meta = readMeta(role)
    const left = meta.expiresAt - Date.now()
    if (left < MIN_TOKEN_LEFT_MS) throw new Error(`${role} 令牌只剩 ${Math.round(left / 60_000)} 分钟，不足以在不续期的前提下跑完；本次运行中止，不重新登录`)
    info.annotations.push({ type: 'token', description: `${role} 令牌剩余约 ${Math.round(left / 60_000)} 分钟` })
    await use(page)
  },
  api: async ({ page }, use) => { await use(new ApiLog(page)) },
})

/** 打开某页，核对目标与登录态（落在登录页说明 storageState 失效：直接失败，不重新登录） */
export async function open(page: Page, path: string) {
  await page.goto(path)
  await assertTestTarget(page)
  await expect(page.locator('.proj-switch'), '应已登录（storageState）并进入布局').toBeVisible({ timeout: 30_000 })
  await expect(page).not.toHaveURL(/\/login(\?|$)/)
}

/** 页面上不应出现无效读数 65536 */
export async function expectNo65536(page: Page) {
  await expect(page.locator('main, .page, body').first()).not.toContainText('65536')
}

export { expect }
