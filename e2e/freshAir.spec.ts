// S10c 新风运行设置交互用例（演示数据模式，不截图）：改值只改草稿，下发前确认，确认后经 204 演示数据源生效；取消确认草稿保留；
// 整个过程不发任何 ctrl 请求（演示数据只改内存）。外观由 pages.spec / states.spec / overlays.spec 的截图把关。
import type { Page } from '@playwright/test'
import { expect, expectToast, settle, test } from './fixtures'

const tick = (page: Page, ms = 50) => page.clock.runFor(ms)
const panel = (page: Page) => page.getByRole('region', { name: '运行设置' })

test.describe('新风运行设置：下发', () => {
  let ctrlCalls: string[]
  test.beforeEach(async ({ page, login }) => {
    ctrlCalls = []
    page.on('request', (r) => { if (r.url().includes('/ctrl/')) ctrlCalls.push(r.url()) })
    // PRJ-10252（新风单机版）第 1 台 FA-01：露点控制，露点 12.0 °C
    await login('dealer', 'PRJ-10252')
    await page.goto('/fresh-air')
    await settle(page)
  })
  test.afterEach(() => { expect(ctrlCalls).toEqual([]) })

  test('露点 + 0.5 → 待下发条写原值与新值 → 确认弹窗写明项目、设备与值 → 确认后提示已生效并以新值显示', async ({ page }) => {
    const p = panel(page)
    await expect(p.getByRole('button', { name: '下发设置' })).toBeDisabled()
    await p.getByRole('button', { name: '露点设定升高' }).click()
    await expect(p.getByLabel('露点设定', { exact: true })).toHaveText('12.5°C')
    await expect(p.locator('[data-draft]')).toContainText('待下发：露点设定 12.0 °C → 12.5 °C')
    await p.getByRole('button', { name: '下发设置' }).click()
    await tick(page)
    const dlg = page.getByRole('alertdialog')
    await expect(dlg).toContainText('的「新风机 FA-01」下发：露点设定 12.0 °C → 12.5 °C，确定继续？')
    await dlg.getByRole('button', { name: '确认下发' }).click()
    await tick(page, 1500) // 演示接口的延时
    await expectToast(page, '新风机 FA-01 已生效：露点设定 12.5 °C')
    await expect(p.locator('[data-draft]')).toHaveCount(0)
    await expect(p.getByLabel('露点设定', { exact: true })).toHaveText('12.5°C')
  })

  test('确认弹窗点取消：不生效，草稿保留；「放弃本次改动」回到读数', async ({ page }) => {
    const p = panel(page)
    await p.getByRole('group', { name: '控制类型' }).getByRole('button', { name: '湿度控制' }).click()
    await p.getByRole('button', { name: '下发设置' }).click()
    await tick(page)
    await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click()
    await tick(page, 300)
    await expect(p.locator('[data-draft]')).toContainText('控制类型 露点控制 → 湿度控制')
    await p.getByRole('button', { name: '放弃本次改动' }).click()
    await expect(p.locator('[data-draft]')).toHaveCount(0)
    await expect(p.getByRole('group', { name: '控制类型' }).getByRole('button', { name: '露点控制' })).toHaveAttribute('aria-pressed', 'true')
  })
})
