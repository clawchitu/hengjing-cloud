// H1 登录（setup 项目）：每个账号每次运行只登录这一次，登录态存成 storageState 给后面所有用例复用。
// 闸门同样生效，只额外放行 POST /auth/login；登录前先核对目标是测试站。
// 账号来源：环境变量（CI 用 repo secrets 注入），没有就读 macOS 钥匙串（hengjing-test-platform / hengjing-test-dealer）。
// 不打印账号、密码、令牌；不截图、不录 trace（见 playwright.live.config.ts）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { test as base, type Locator, type Page } from '@playwright/test'
import { readAccount } from '../scripts/live/keychain'
import { WRITE_PATHS } from './policy'
import { ApiLog, assertGateClean, assertTestTarget, authFile, expect, installGate, metaFile, MIN_TOKEN_LEFT_MS, newLedger, tokenExpiresAt, type AuthMeta, type Role } from './harness'

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

/**
 * 填账号密码并登录。从填入到离开登录页这一段不用 expect 匹配器：匹配器失败时 Playwright 立刻抓整页快照
 * （含输入框的值，密码框也照抓）写进 error-context.md，早于任何 finally。这里只用 waitFor*，失败时先清空输入框，
 * 再抛一条不带页面内容的错误
 */
async function loginOnce(page: Page, acct: { mobile: string; password: string }) {
  try {
    await typeSecret(page.getByPlaceholder('请输入用户名'), acct.mobile)
    await typeSecret(page.getByPlaceholder('请输入密码'), acct.password)
    // 「记住我」：令牌存 localStorage，storageState 才能带给后面的用例
    await page.getByRole('checkbox', { name: '记住我' }).check()
    await page.getByRole('button', { name: '登 录' }).click()
    await page.waitForURL(/\/sensors$/, { timeout: 30_000 })
  } catch {
    await clearInputs(page)
    throw new Error('登录未完成（30 秒内没有回到 /sensors）：检查账号配置、测试服是否可用')
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
  }, value)
  if (!(await input.evaluate((el) => (el as HTMLInputElement).value !== ''))) throw new Error('输入框没有填上')
}

// 串行：闸门自检失败时，后面的登录不再进行（不白白挤掉别处的会话）
base.describe.configure({ mode: 'serial' })

// 闸门自检（先于登录，不联网）：在被测站点的源上从页面里对每条写路由、续期、作废令牌、第二次登录各发一次，
// 必须全部在发出前被 abort 并记为违规。放行的请求（打开页面）由先注册的本地兜底应答，不到网络
base('闸门自检：写路由、续期、作废令牌、额外登录都在发出前被拦（不联网）', async ({ browser }) => {
  const context = await browser.newContext()
  let reachedNet = 0
  await context.route('**/*', (r) => { reachedNet++; return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>h1</title>' }) })
  const ledger = newLedger()
  await installGate(context, ledger, { selfCheck: true })
  const page = await context.newPage()
  await page.goto('/h1-gate-self-check')
  expect(reachedNet, '打开页面应只经过本地兜底').toBe(1)
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
  expect(reachedNet, '探测请求一条都没有到兜底（也就没有到网络）').toBe(1)
  await context.close()
})

for (const role of ['platform', 'dealer'] as const) {
  base(`登录一次：${role}`, async ({ browser }) => {
    mkdirSync('e2e-live/.auth', { recursive: true })
    const acct = account(role)
    const context = await browser.newContext()
    const ledger = newLedger()
    await installGate(context, ledger, { allowLogin: true })
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
    expect(expiresAt, '令牌应存在 localStorage（记住我）').not.toBeNull()
    const left = expiresAt! - Date.now()
    expect(left, '新登录的令牌有效期').toBeGreaterThan(MIN_TOKEN_LEFT_MS)
    base.info().annotations.push({ type: 'token', description: `${role} 令牌有效期约 ${Math.round(left / 60_000)} 分钟（不续期）` })

    // F3：刷新保持登录（会话恢复只调 GET /me，不登录、不续期）
    await page.reload()
    await expect(page).toHaveURL(/\/sensors$/)
    await expect(page.locator('.proj-switch')).toBeVisible({ timeout: 30_000 })
    expect(ledger.logins, '刷新后没有再次登录').toBe(1)

    await context.storageState({ path: authFile(role) })
    writeFileSync(metaFile(role), JSON.stringify({ role, loginAt: Date.now(), expiresAt: expiresAt! } satisfies AuthMeta))
    } finally {
      await clearInputs(page)
      await base.info().attach('network.txt', { body: ledger.net.join('\n'), contentType: 'text/plain' })
      await context.close()
    }
    assertGateClean(ledger)
  })
}
