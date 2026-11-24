import { expect, test as base, type Page } from '@playwright/test'

export const FIXED_NOW = new Date('2026-01-15T10:00:00+08:00')

export type Role = 'dealer' | 'admin'
const USERS = { dealer: 'cosyhome', admin: 'hjadmin' } as const

export const test = base.extend<{ login: (role: Role, project?: string) => Promise<void> }>({
  page: async ({ page }, use) => {
    // 演示数据模式：不连任何真实后端；登录接口一律拒绝，页面靠预置的本地登录态进入
    await page.route('**/api/**', (r) => r.fulfill({ json: { ok: false }, status: 401 }))
    // 固定随机数（mock 实时数据的随机游走），保证每次截图一致
    await page.addInitScript(() => {
      let s = 20260115
      Math.random = () => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s / 2 ** 32
      }
    })
    // 固定并暂停时钟：定时器、动画只在 settle() 里按固定步长推进
    await page.clock.install({ time: FIXED_NOW })
    await page.clock.pauseAt(FIXED_NOW)
    await use(page)
  },
  login: async ({ page }, use) => {
    await use(async (role, project) => {
      await page.addInitScript(
        ([user, r, pid]) => {
          if (!localStorage.getItem('hjc-auth')) localStorage.setItem('hjc-auth', JSON.stringify({ username: user, role: r }))
          if (pid) localStorage.setItem('hjc-project', pid)
        },
        [USERS[role], role, project ?? ''] as const,
      )
    })
  },
})

/** 等字体、mock 数据和 ECharts 动画完成后再截图 */
export async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.clock.runFor(3000)
  await page.evaluate(() => document.fonts.ready)
}

export async function shot(page: Page, name: string, opts: { h1?: boolean } = {}) {
  await settle(page)
  if (opts.h1 !== false) await expect(page.locator('h1').first()).toBeVisible()
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true })
}

export { expect }
