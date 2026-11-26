// 令牌存 sessionStorage：关浏览器要重新登录；多标签页之间要令牌、续期广播、一起退出；旧 localStorage 令牌清除。
// 真实接口模式（config.js 改成 dataSource: 'real'），后端全部由 context.route 假装，不连任何真实后端。
// 同一个 context 里的多个 page = 同一浏览器的多个标签页；关掉 context 再新开 = 关浏览器再打开。
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const TOKEN_KEY = 'hjc-session'
const jwt = (sub: string, n: number) => `h.${Buffer.from(JSON.stringify({ sub, n })).toString('base64url')}.s`

/** 假后端：记每个接口的调用；refresh 会轮换令牌，旧 refresh_token 立即作废（同测试服） */
interface Backend { calls: Record<string, number>; staleRefresh: number; ttl: number; n: number; valid: string; invalidated: number }

async function realMode(context: BrowserContext, opts: { ttl?: number } = {}): Promise<Backend> {
  const be: Backend = { calls: {}, staleRefresh: 0, ttl: opts.ttl ?? 7200, n: 0, valid: '', invalidated: 0 }
  await context.route('**/config.js', (r) => r.fulfill({
    contentType: 'application/javascript',
    body: "window.__HJC_CONFIG__ = { dataSource: 'real', apiBase: '/api', apiEnv: 'test', writeMode: 'off' }",
  }))
  const issue = (ttl: number) => {
    be.n++
    be.valid = `R${be.n}`
    return { access_token: jwt('u1', be.n), refresh_token: be.valid, expires_in: ttl }
  }
  await context.route('**/api/**', async (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/api/, '')
    be.calls[path] = (be.calls[path] ?? 0) + 1
    const body = r.request().postDataJSON() as Record<string, unknown> | null
    if (path === '/auth/login') return r.fulfill({ json: issue(be.ttl) })
    if (path === '/auth/refresh') {
      if (body?.refresh_token !== be.valid) { be.staleRefresh++; return r.fulfill({ status: 401, json: { code: 16, message: 'invalid refresh_token' } }) }
      return r.fulfill({ json: issue(7200) })
    }
    if (path === '/auth/invalidate') { be.invalidated++; be.valid = ''; return r.fulfill({ json: {} }) }
    if (path === '/me') return r.fulfill({ json: { user_entity: { id: 'u1', name: '测试', type: 1 }, permission_paths: [] } })
    return r.fulfill({ json: {} })
  })
  return be
}

const loginForm = (page: Page) => page.getByPlaceholder('请输入用户名')
const tokenIn = (page: Page) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? 'null') as { refreshToken: string } | null, TOKEN_KEY)

async function expectLoggedIn(page: Page) {
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(loginForm(page)).toHaveCount(0)
}

async function login(page: Page) {
  await page.goto('/home')
  await expect(page).toHaveURL(/\/login$/)
  await loginForm(page).fill('dealer')
  await page.getByPlaceholder('请输入密码').fill('pw')
  await page.getByRole('button', { name: '登 录' }).click()
  await expectLoggedIn(page)
}

test.describe('令牌存 sessionStorage（真实接口模式）', () => {
  test('登录后令牌只在 sessionStorage；没有「记住我」', async ({ context, page }) => {
    await realMode(context)
    await page.goto('/login')
    await expect(page.getByRole('checkbox', { name: '记住我' })).toHaveCount(0)
    await login(page)
    expect(await tokenIn(page)).toMatchObject({ refreshToken: 'R1' })
    expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBeNull()
  })

  test('关浏览器模拟：清空 sessionStorage 后刷新 → 登录页', async ({ context, page }) => {
    await realMode(context)
    await login(page)
    await page.evaluate(() => sessionStorage.clear())
    await page.reload()
    await expect(page).toHaveURL(/\/login$/)
    await expect(loginForm(page)).toBeVisible()
  })

  test('关掉 context 再重新打开 → 要求重新登录', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    await realMode(ctx1)
    await login(await ctx1.newPage())
    await ctx1.close()
    const ctx2 = await browser.newContext()
    const be2 = await realMode(ctx2)
    const page = await ctx2.newPage()
    await page.goto('/home')
    await expect(page).toHaveURL(/\/login$/)
    expect(be2.calls['/me']).toBeUndefined()
    await ctx2.close()
  })

  test('已登录时新开标签页：从已登录的标签页拿到令牌，不用再登录', async ({ context, page }) => {
    const be = await realMode(context)
    await login(page)
    const tab2 = await context.newPage()
    await tab2.goto('/sensors')
    await expectLoggedIn(tab2)
    await expect(tab2).toHaveURL(/\/sensors$/)
    expect(be.calls['/auth/login']).toBe(1)
    expect(await tokenIn(tab2)).toEqual(await tokenIn(page))
  })

  test('没有已登录的标签页：新开标签页跳到登录页', async ({ context, page }) => {
    const be = await realMode(context)
    const tab2 = await context.newPage()
    await page.goto('/login')
    await tab2.goto('/sensors')
    await expect(tab2).toHaveURL(/\/login$/)
    expect(be.calls['/me']).toBeUndefined()
  })

  test('两个标签页同时到期：只续期一次，广播后两个标签页都用新令牌', async ({ context, page }) => {
    // 61 秒有效期：进入续期窗口（提前 60 秒）后约 6 秒两个标签页的定时器几乎同时触发
    const be = await realMode(context, { ttl: 61 })
    await login(page)
    const tab2 = await context.newPage()
    await tab2.goto('/sensors')
    await expectLoggedIn(tab2)
    expect((await tokenIn(tab2))?.refreshToken).toBe('R1')
    await expect.poll(() => be.calls['/auth/refresh'] ?? 0, { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(async () => [(await tokenIn(page))?.refreshToken, (await tokenIn(tab2))?.refreshToken], { timeout: 10_000 }).toEqual(['R2', 'R2'])
    await page.waitForTimeout(1000)
    expect(be.calls['/auth/refresh']).toBe(1)
    expect(be.staleRefresh).toBe(0)
    await expectLoggedIn(page)
    await expectLoggedIn(tab2)
  })

  test('一个标签页退出登录 → 所有标签页一起退出', async ({ context, page }) => {
    const be = await realMode(context)
    await login(page)
    const tab2 = await context.newPage()
    await tab2.goto('/sensors')
    await expectLoggedIn(tab2)
    await page.locator('.sidebar').getByText('退出登录', { exact: true }).click()
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(tab2).toHaveURL(/\/login$/)
    expect(await tokenIn(tab2)).toBeNull()
    expect(be.invalidated).toBe(1)
    // 退出后再开新标签页，也不会从谁那里拿到令牌
    const tab3 = await context.newPage()
    await tab3.goto('/home')
    await expect(tab3).toHaveURL(/\/login$/)
  })

  test('旧版本 localStorage 里的令牌被清掉、不拿来登录；账号偏好保留', async ({ context, page }) => {
    const be = await realMode(context)
    await context.addInitScript(([k, legacy]) => {
      if (sessionStorage.getItem('e2e-seeded')) return
      sessionStorage.setItem('e2e-seeded', '1')
      localStorage.setItem(k, legacy)
      localStorage.setItem('hjc-weather-city:user:u1', '{"code":"110000"}')
      localStorage.setItem('hjc-recent-projects:user:u1', '["p1"]')
    }, [TOKEN_KEY, JSON.stringify({ accessToken: jwt('u1', 0), refreshToken: 'R0', expiresAt: Date.now() + 3600_000 })] as const)
    await page.goto('/home')
    await expect(page).toHaveURL(/\/login$/)
    expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('hjc-weather-city:user:u1'))).toBe('{"code":"110000"}')
    expect(await page.evaluate(() => localStorage.getItem('hjc-recent-projects:user:u1'))).toBe('["p1"]')
    expect(be.calls['/me']).toBeUndefined()
    expect(be.calls['/auth/refresh']).toBeUndefined()
  })
})

test.describe('8 小时无操作需重新登录（真实接口模式）', () => {
  const ACTIVITY_KEY = 'hjc-last-activity'
  const idleToast = (page: Page) => page.getByText('长时间未操作，请重新登录')

  test('启动时（Chrome 恢复会话、刷新）最后操作已超过 8 小时 → 登录页并提示，不取 /me', async ({ context, page }) => {
    const be = await realMode(context)
    await login(page)
    const me = be.calls['/me']
    // sessionStorage 里的令牌还在（Chrome「继续浏览上次打开的网页」会恢复它），最后操作在 8 小时 1 分前
    await page.evaluate((k) => localStorage.setItem(k, String(Date.now() - 8 * 3600_000 - 60_000)), ACTIVITY_KEY)
    await page.reload()
    await expect(page).toHaveURL(/\/login$/)
    await expect(idleToast(page)).toBeVisible()
    expect(await tokenIn(page)).toBeNull()
    expect(be.calls['/me']).toBe(me)
    await expect.poll(() => be.invalidated).toBe(1)
  })

  test('启动时最后操作在 7 小时 59 分前：照常恢复', async ({ context, page }) => {
    await realMode(context)
    await login(page)
    // 10 小时前登录，7 小时 59 分前最后一次操作
    await page.evaluate(([k, tk]) => {
      const t = JSON.parse(sessionStorage.getItem(tk)!) as { loginAt: number }
      sessionStorage.setItem(tk, JSON.stringify({ ...t, loginAt: Date.now() - 10 * 3600_000 }))
      localStorage.setItem(k, String(Date.now() - 7 * 3600_000 - 59 * 60_000))
    }, [ACTIVITY_KEY, TOKEN_KEY] as const)
    await page.reload()
    await expectLoggedIn(page)
  })

  test('运行中 8 小时没有操作 → 回登录页并提示；另一个标签页也退出', async ({ context, page }) => {
    const be = await realMode(context)
    await page.clock.install()
    await login(page)
    const tab2 = await context.newPage()
    await tab2.goto('/sensors')
    await expectLoggedIn(tab2)
    await page.clock.fastForward('08:01:00')
    await expect(page).toHaveURL(/\/login$/)
    await expect(idleToast(page)).toBeVisible()
    await expect(tab2).toHaveURL(/\/login$/)
    await expect(idleToast(tab2)).toBeVisible()
    expect(await tokenIn(tab2)).toBeNull()
    // 假时钟装在整个 context 上，两个标签页的每分钟检查同时到点，各调一次 invalidate（尽力调用，重复无害）
    await expect.poll(() => be.invalidated).toBeGreaterThanOrEqual(1)
  })
})
