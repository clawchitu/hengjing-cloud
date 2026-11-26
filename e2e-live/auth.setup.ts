// H1 登录（setup 项目）：先做不联网的闸门自检，再每个账号登录一次，登录态存成 storageState 给后面所有用例复用。
// 闸门同样生效，只额外给 1 次登录许可；登录前先核对目标是测试服。
// 账号来源：先读环境变量 H1_PLATFORM_ACCOUNT / H1_PLATFORM_PASSWORD、H1_DEALER_ACCOUNT / H1_DEALER_PASSWORD
// （CI 由 environment h1-live 的 secrets 注入），本机没设再读 macOS 钥匙串（hengjing-test-platform / hengjing-test-dealer）。
// 不打印账号、密码、令牌；不截图、不录 trace（见 playwright.live.config.ts）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { test as base, type Locator, type Page } from '@playwright/test'
import { readAccount } from '../scripts/live/keychain'
import { WRITE_PATHS } from './policy'
import { TOKEN_KEY } from '../src/api/tokens'
import { ApiLog, assertGateClean, assertTestTarget, authFile, expect, installGate, metaFile, MIN_TOKEN_LEFT_MS, newLedger, sessionFile, tokenExpiresAt, type AuthMeta, type Role } from './harness'

const ACCOUNTS: Record<Role, { env: string; keychain: string; dealer: boolean }> = {
  platform: { env: 'H1_PLATFORM', keychain: 'hengjing-test-platform', dealer: false },
  dealer: { env: 'H1_DEALER', keychain: 'hengjing-test-dealer', dealer: true },
}

function account(role: Role): { mobile: string; password: string } {
  const a = ACCOUNTS[role]
  const mobile = process.env[`${a.env}_ACCOUNT`], password = process.env[`${a.env}_PASSWORD`]
  if (mobile && password) return { mobile, password }
  if (process.env.CI) throw new Error(`CI 里缺少 ${a.env}_ACCOUNT / ${a.env}_PASSWORD`)
  return readAccount(a.keychain)
}

/** 这次要登录的账号（playwright.live.config.ts 按 --project 算好，见 cli.ts） */
const ROLES = (process.env.H1_ROLES ?? '').split(',').filter(Boolean)

/** 登录页上每一步的超时：都远短于用例超时，保证出错时一定走到 catch 先清空输入框 */
const STEP_MS = 10_000

/** 演练专用的故障注入（只在 playwright.live-dry.config.ts 下可用，见 dry/leak-check.mjs）：让登录按钮找不到，在填完账号密码后失败 */
const SUBMIT = process.env.H1_DRY === '1' && process.env.H1_DRY_BREAK === 'submit' ? '登 录（演练：故意找不到）' : '登 录'

/**
 * 填账号密码并登录。从填入到离开登录页这一段不用 expect 匹配器：匹配器失败时 Playwright 立刻抓整页快照
 * （含输入框的值，密码框也照抓）写进 error-context.md，早于任何 finally。这里只用显式短超时的操作和 waitFor*，
 * 失败时先清空输入框，再抛一条不带页面内容的错误
 */
async function loginOnce(page: Page, acct: { mobile: string; password: string }) {
  try {
    await typeSecret(page.getByPlaceholder('请输入用户名'), acct.mobile)
    await typeSecret(page.getByPlaceholder('请输入密码'), acct.password)
    // 真实接口模式没有「记住我」：令牌一律存 sessionStorage，由下面另存一份带给后面的用例（见 harness.ts 的 page 夹具）
    await page.getByRole('button', { name: SUBMIT }).click({ timeout: STEP_MS })
    await page.waitForURL(/\/sensors$/, { timeout: 30_000 })
  } catch {
    await clearInputs(page)
    throw new Error('登录未完成：检查账号配置、测试服是否可用（为不泄漏账号，这里不附页面内容）')
  }
}

const clearInputs = (page: Page) => page.locator('input').evaluateAll((els) => els.forEach((el) => { (el as HTMLInputElement).value = '' })).catch(() => {})

/**
 * 往受控输入框里填值，不用 locator.fill / keyboard：那两个会把值写进步骤标题（HTML 报告、trace 里能看到明文，已实测）。
 * evaluate 的参数不进步骤标题。用原生 setter + input 事件，React 受控组件能收到
 */
async function typeSecret(input: Locator, value: string) {
  await input.evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value, { timeout: STEP_MS })
  if (!(await input.evaluate((el) => (el as HTMLInputElement).value !== '', undefined, { timeout: STEP_MS }))) throw new Error('输入框没有填上')
}

/** 重试或重复运行 setup 就是第二次登录：一律拒绝（配置和命令行护栏之外的再一道） */
function assertSingleRun() {
  const info = base.info()
  if (info.retry !== 0 || info.repeatEachIndex !== 0) throw new Error(`H1 setup 不允许重试或重复（retry=${info.retry}，repeatEachIndex=${info.repeatEachIndex}）`)
}

/** 闸门自检用的 context：先注册本地兜底（应答一切放行的请求），再装闸门（后注册的先执行）。整个自检不联网 */
async function selfCheckContext(browser: import('@playwright/test').Browser, loginPermits = 0) {
  const context = await browser.newContext()
  const reached: string[] = []
  await context.route('**/*', (r) => {
    reached.push(new URL(r.request().url()).pathname)
    if (r.request().headers()['x-h1-probe'] === 'redirect') return r.fulfill({ status: 307, headers: { Location: 'https://h1-self-check.invalid/api/ctrl/room-temperature-set' } })
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>h1</title>' })
  })
  const ledger = newLedger()
  await installGate(context, ledger, { selfCheck: true, loginPermits })
  const page = await context.newPage()
  await page.goto('/h1-gate-self-check')
  return { context, page, ledger, reached }
}

// 串行：闸门自检失败时，后面的登录不再进行（不白白挤掉别处的会话）
base.describe.configure({ mode: 'serial' })

// 闸门自检（先于登录，不联网）
base('闸门自检：写路由、续期、作废令牌、无许可的登录都在发出前被拦', async ({ browser }) => {
  assertSingleRun()
  const { context, page, ledger, reached } = await selfCheckContext(browser)
  const probes = [...WRITE_PATHS, '/auth/refresh', '/auth/invalidate', '/auth/login', '/V1/CTRL/ROOM-TEMPERATURE-SET', '/ctrl/some-future-set']
  const results = await page.evaluate(async (paths) => {
    const out: boolean[] = []
    for (const p of paths) {
      try { await fetch('/api' + p, { method: 'POST', body: '{}' }); out.push(false) } catch { out.push(true) }
    }
    return out
  }, probes)
  expect(results, '每个探测请求都应被拦').toEqual(probes.map(() => true))
  expect(ledger.violations).toHaveLength(probes.length)
  expect(reached, '探测请求一条都没有到兜底（也就没有到网络）').toEqual(['/h1-gate-self-check'])
  await context.close()
})

base('闸门自检：登录许可只有一次，连续第二次在发出前被拦', async ({ browser }) => {
  assertSingleRun()
  const { context, page, ledger, reached } = await selfCheckContext(browser, 1)
  const results = await page.evaluate(async () => {
    const out: boolean[] = []
    for (let i = 0; i < 2; i++) {
      try { await fetch('/api/auth/login', { method: 'POST', body: '{}' }); out.push(true) } catch { out.push(false) }
    }
    return out
  })
  expect(results, '第一次放行、第二次被拦').toEqual([true, false])
  expect(reached.filter((p) => p === '/api/auth/login'), '只有一次登录到了兜底').toHaveLength(1)
  expect(ledger.logins).toBe(1)
  expect(ledger.violations).toHaveLength(1)
  await context.close()
})

base('闸门自检：并发 5 个登录请求只有一个拿到许可', async ({ browser }) => {
  assertSingleRun()
  const { context, page, ledger, reached } = await selfCheckContext(browser, 1)
  const results = await page.evaluate(() => Promise.all(Array.from({ length: 5 }, () =>
    fetch('/api/auth/login', { method: 'POST', body: '{}' }).then(() => true, () => false))))
  expect(results.filter(Boolean), '只有一个被放行').toHaveLength(1)
  expect(reached.filter((p) => p === '/api/auth/login'), '只有一次登录到了兜底').toHaveLength(1)
  expect(ledger.logins).toBe(1)
  expect(ledger.violations).toHaveLength(4)
  await context.close()
})

base('闸门自检：重定向后的请求补判违规；WebSocket 判违规并关闭', async ({ browser }) => {
  assertSingleRun()
  const { context, page, ledger, reached } = await selfCheckContext(browser)
  // GET /me 在白名单里放行，兜底回 307。route 只对重定向链的第一个地址调用，跳转后的请求不再经过 route，
  // 所以闸门在 request 事件里补判。跳转目标用 .invalid 域名（解析必然失败），即使漏判也不会联网
  await page.evaluate(() => fetch('/api/me', { headers: { 'x-h1-probe': 'redirect' } }).catch(() => null))
  await expect.poll(() => ledger.violations.length).toBe(1)
  expect(ledger.violations[0]).toContain('重定向后的请求不在白名单')
  expect(reached).toEqual(['/h1-gate-self-check', '/api/me'])
  const before = ledger.violations.length
  const closed = await page.evaluate(() => new Promise<boolean>((resolve) => {
    const ws = new WebSocket('wss://h1-self-check.invalid/ws')
    ws.onclose = () => resolve(true)
    setTimeout(() => resolve(false), 5000)
  }))
  expect(closed, 'WebSocket 应被关闭').toBe(true)
  expect(ledger.violations.length).toBe(before + 1)
  expect(ledger.violations.at(-1)).toContain('WebSocket')
  await context.close()
})

for (const role of ['platform', 'dealer'] as const) {
  base(`登录一次：${role}`, async ({ browser }) => {
    assertSingleRun()
    base.skip(!ROLES.includes(role), `本次 --project 没有选 ${role}，不登录这个账号`)
    mkdirSync('e2e-live/.auth', { recursive: true })
    const acct = account(role)
    const context = await browser.newContext()
    const ledger = newLedger()
    await installGate(context, ledger, { loginPermits: 1 })
    const page = await context.newPage()
    const api = new ApiLog(page)
    page.on('pageerror', (e) => ledger.violations.push(`前端未捕获异常：${e.name}: ${e.message.slice(0, 200)}`))
    try {
      // F3：未登录打开子路径 → 登录页；登录后回到原路径（借这唯一一次登录一起验证）
      await page.goto('/sensors')
      await assertTestTarget(page)
      await expect(page).toHaveURL(/\/login$/)
      await loginOnce(page, acct)

      expect(ledger.logins, '本账号只登录一次').toBe(1)
      const me = await api.latest('/me', (h) => h.status === 200)
      const type = (me.json as { user_entity?: { type?: unknown } }).user_entity?.type
      expect(type === 1, `${role} 账号身份（/me type）与预期不符，检查账号配置`).toBe(ACCOUNTS[role].dealer)

      const expiresAt = await tokenExpiresAt(page)
      expect(expiresAt, '令牌应存在 sessionStorage').not.toBeNull()
      const left = expiresAt! - Date.now()
      expect(left, '新登录的令牌有效期').toBeGreaterThan(MIN_TOKEN_LEFT_MS)
      base.info().annotations.push({ type: 'token', description: `${role} 令牌有效期约 ${Math.round(left / 60_000)} 分钟（不续期）` })

      // F3：刷新保持登录（会话恢复只调 GET /me，不登录、不续期）
      await page.reload()
      await expect(page).toHaveURL(/\/sensors$/)
      await expect(page.locator('.proj-switch')).toBeVisible({ timeout: 30_000 })
      expect(ledger.logins, '刷新后没有再次登录').toBe(1)

      await context.storageState({ path: authFile(role) })
      // storageState 不含 sessionStorage：令牌另存，用例的 context 启动时写回（运行结束由 teardown 删掉）
      writeFileSync(sessionFile(role), JSON.stringify(await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)))
      writeFileSync(metaFile(role), JSON.stringify({ role, loginAt: Date.now(), expiresAt: expiresAt! } satisfies AuthMeta))
    } finally {
      await clearInputs(page)
      await base.info().attach('network.txt', { body: ledger.net.join('\n'), contentType: 'text/plain' })
      await context.close()
    }
    assertGateClean(ledger)
  })
}
