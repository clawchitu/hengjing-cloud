// 登录跳转（演示数据模式，假的 /api/login 响应；不连真实后端，不截图）
import { expect, test } from './fixtures'

test.describe('登录跳转', () => {
  test.beforeEach(async ({ page }) => {
    // 覆盖 fixtures 里一律 401 的 /api/**：演示账号登录成功
    await page.route('**/api/login', (r) => r.fulfill({ json: { ok: true, role: 'dealer', username: 'cosyhome' } }))
  })

  const submit = async (page: import('@playwright/test').Page) => {
    await page.getByPlaceholder('请输入用户名').fill('cosyhome')
    await page.getByPlaceholder('请输入密码').fill('pw')
    await page.getByRole('button', { name: '登 录' }).click()
  }

  test('未登录打开设备页 → 登录页；登录后回到原页面（state.from）', async ({ page }) => {
    await page.goto('/sensors')
    await expect(page).toHaveURL(/\/login$/)
    await submit(page)
    await expect(page).toHaveURL(/\/sensors$/)
    await expect(page.locator('.toasts')).toContainText('登录成功，欢迎回来')
  })

  test('直接打开登录页 → 登录后去首页', async ({ page }) => {
    await page.goto('/login')
    await submit(page)
    await expect(page).toHaveURL(/\/home$/)
  })

  test('空提交：提示原文案，不发请求', async ({ page }) => {
    let calls = 0
    await page.route('**/api/login', (r) => { calls++; return r.fulfill({ json: { ok: false }, status: 401 }) })
    await page.goto('/login')
    await page.getByRole('button', { name: '登 录' }).click()
    await expect(page.locator('.toasts')).toContainText('请输入用户名和密码')
    expect(calls).toBe(0)
  })

  test('密码错误：提示并停留在登录页', async ({ page }) => {
    await page.route('**/api/login', (r) => r.fulfill({ json: { ok: false }, status: 401 }))
    await page.goto('/login')
    await submit(page)
    await expect(page.locator('.toasts')).toContainText('用户名或密码错误')
    await expect(page).toHaveURL(/\/login$/)
  })
})
