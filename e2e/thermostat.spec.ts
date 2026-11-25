// S9 温控面板交互用例（演示数据模式，不截图）：卡片内调温 / 节能只改草稿，下发前确认，确认后才生效；
// 房间关闭时不能设置；整个过程不发任何 ctrl 请求（演示数据只改内存）。外观由 pages.spec / overlays.spec 的截图把关。
import type { Page } from '@playwright/test'
import { expect, expectToast, settle, test } from './fixtures'

const tick = (page: Page, ms = 50) => page.clock.runFor(ms)
const card = (page: Page, name: string) => page.locator('[data-room]').filter({ has: page.locator('.room-name', { hasText: name }) })

test.describe('温控面板：卡片内修改', () => {
  let ctrlCalls: string[]
  test.beforeEach(async ({ page, login }) => {
    ctrlCalls = []
    page.on('request', (r) => { if (r.url().includes('/ctrl/')) ctrlCalls.push(r.url()) })
    await login('dealer')
    await page.goto('/thermostat')
    await settle(page)
  })
  test.afterEach(() => { expect(ctrlCalls).toEqual([]) })

  test('− 两次 → 待下发条显示原值与新值；下发 → 确认弹窗写明项目、房间与值 → 确认后提示成功并以新值显示', async ({ page }) => {
    const c = card(page, '客厅')
    await c.getByRole('button', { name: '客厅 设定温度降低' }).click()
    await c.getByRole('button', { name: '客厅 设定温度降低' }).click()
    await expect(c.getByLabel('客厅 设定温度', { exact: true })).toHaveText('25.0°C')
    await expect(c.locator('.te-bar.pending')).toContainText('待下发：设定温度 26.0 → 25.0°C')
    await expect(c.locator('.te-old')).toContainText('原 26.0')
    await c.getByRole('button', { name: '下发', exact: true }).click()
    await tick(page)
    const dlg = page.getByRole('alertdialog')
    await expect(dlg).toContainText('将向 朝阳壹号院 A栋的「客厅」下发：设定温度 26.0 → 25.0°C，确定继续？')
    await dlg.getByRole('button', { name: '确认下发' }).click()
    await tick(page, 1000) // 演示接口的延时
    await expectToast(page, '客厅 已生效：设定温度 25.0°C')
    await expect(c.locator('.te-bar')).toHaveCount(0)
    await expect(c.getByLabel('客厅 设定温度', { exact: true })).toHaveText('25.0°C')
  })

  test('确认弹窗点取消：不生效，草稿保留；草稿条点取消：回到面板当前值', async ({ page }) => {
    const c = card(page, '客厅')
    await c.getByRole('switch', { name: '客厅 节能模式' }).click()
    await expect(c.locator('.te-bar.pending')).toContainText('节能模式 标准 → 节能')
    await c.getByRole('button', { name: '下发', exact: true }).click()
    await tick(page)
    await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click()
    await tick(page, 1000)
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    await expect(c.locator('.te-bar.pending')).toBeVisible()
    await c.locator('.te-bar.pending').getByRole('button', { name: '取消' }).click()
    await expect(c.locator('.te-bar')).toHaveCount(0)
    await expect(c.getByRole('switch', { name: '客厅 节能模式' })).toHaveAttribute('aria-checked', 'false')
  })

  test('房间关闭（客卧）：设定温度与节能控件禁用', async ({ page }) => {
    const c = card(page, '客卧')
    await expect(c.getByRole('button', { name: '客卧 设定温度降低' })).toBeDisabled()
    await expect(c.getByRole('button', { name: '客卧 设定温度升高' })).toBeDisabled()
    await expect(c.getByRole('switch', { name: '客卧 节能模式' })).toBeDisabled()
    await expect(c.getByRole('switch', { name: '客卧 开关' })).toBeEnabled()
  })

  test('改另一个房间时先确认放弃原草稿', async ({ page }) => {
    await card(page, '客厅').getByRole('button', { name: '客厅 设定温度升高' }).click()
    await card(page, '主卧').getByRole('button', { name: '主卧 设定温度升高' }).click()
    await tick(page)
    const dlg = page.getByRole('alertdialog')
    await expect(dlg).toContainText('「客厅」还有未下发的修改')
    await dlg.getByRole('button', { name: '放弃修改' }).click()
    await tick(page)
    await expect(card(page, '客厅').locator('.te-bar')).toHaveCount(0)
    await expect(card(page, '主卧').locator('.te-bar.pending')).toContainText('设定温度 25.5 → 26.0°C')
  })

  test('节能房间（次卧）：温度步进禁用，提示由系统设定；开节能会去掉已改的温度', async ({ page }) => {
    const eco = card(page, '次卧')
    await expect(eco.getByRole('button', { name: '次卧 设定温度升高' })).toBeDisabled()
    await expect(eco.getByRole('button', { name: '次卧 设定温度升高' })).toHaveAttribute('title', '节能模式下温度由系统设定')
    const c = card(page, '客厅')
    await c.getByRole('button', { name: '客厅 设定温度升高' }).click()
    await c.getByRole('switch', { name: '客厅 节能模式' }).click()
    await expect(c.locator('.te-bar.pending')).toHaveText(/待下发：节能模式 标准 → 节能/)
    await expect(c.locator('.te-bar.pending')).not.toContainText('设定温度')
    await expect(c.getByRole('button', { name: '客厅 设定温度升高' })).toBeDisabled()
  })

  test('房间开关：确认后生效并提示', async ({ page }) => {
    const c = card(page, '书房')
    await c.getByRole('switch', { name: '书房 开关' }).click()
    await tick(page)
    const dlg = page.getByRole('alertdialog')
    await expect(dlg).toContainText('「书房」下发「关闭」指令')
    await dlg.getByRole('button', { name: '确认下发' }).click()
    await tick(page, 1000) // 演示接口的延时
    await expectToast(page, '书房 已关闭')
    await expect(c.getByRole('switch', { name: '书房 开关' })).toHaveAttribute('aria-checked', 'false')
    await expect(c.getByRole('button', { name: '书房 设定温度升高' })).toBeDisabled()
  })
})
