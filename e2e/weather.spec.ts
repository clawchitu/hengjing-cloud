// 首页天气城市选择（S7b，演示数据模式）：键盘操作（方向键、回车、Esc、焦点回收）、选城市后刷新仍在、换账号不带过去，
// 以及打开态截图 weather-city-picker。城市来自本地城市文件，默认无锡；选择存在 localStorage（hjc-weather-city:<账号键>）。
import type { Page } from '@playwright/test'
import { expect, settle, shot, test } from './fixtures'

const tick = (page: Page, ms = 100) => page.clock.runFor(ms)
const trigger = (page: Page) => page.getByRole('button', { name: /^天气城市：/ })
const search = (page: Page) => page.getByRole('combobox', { name: '搜索城市' })

test.describe('天气城市选择', () => {
  test.beforeEach(async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
  })

  test('默认无锡；打开后焦点在搜索框、高亮当前城市；方向键移动、回车选中、焦点回到触发器', async ({ page }) => {
    await expect(trigger(page)).toHaveAccessibleName('天气城市：无锡市，点击更换')
    await trigger(page).focus()
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(search(page)).toBeFocused()
    const current = page.locator('[cmdk-item][data-current]')
    await expect(current).toHaveText('无锡市')
    await expect(current).toHaveAttribute('aria-selected', 'true')
    await expect(current).toBeInViewport() // 列表滚到当前城市
    await page.keyboard.press('ArrowDown') // 无锡市的下一个：徐州市
    await tick(page)
    await expect(page.locator('[cmdk-item][aria-selected="true"]')).toHaveText('徐州市')
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(search(page)).toHaveCount(0)
    await expect(trigger(page)).toHaveAccessibleName('天气城市：徐州市，点击更换')
    await expect(trigger(page)).toBeFocused()
  })

  test('搜索「大理」命中大理白族自治州；Esc 关闭不改城市、焦点回到触发器', async ({ page }) => {
    await trigger(page).click()
    await tick(page)
    await search(page).fill('大理')
    await tick(page, 50)
    await expect(page.locator('[cmdk-item]')).toHaveText(['大理白族自治州'])
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(search(page)).toHaveCount(0)
    await expect(trigger(page)).toBeFocused()
    await expect(trigger(page)).toHaveAccessibleName('天气城市：无锡市，点击更换')
  })

  test('没有命中时显示空态，回车不选任何城市', async ({ page }) => {
    await trigger(page).click()
    await tick(page)
    await search(page).fill('不存在的城市')
    await tick(page, 50)
    await expect(page.getByText('未找到匹配的城市')).toBeVisible()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(search(page)).toBeVisible()
  })

  test('选城市后刷新页面仍是这个城市；换账号不带过去', async ({ page }) => {
    await trigger(page).click()
    await tick(page)
    await search(page).fill('苏州')
    await tick(page, 50)
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(trigger(page)).toHaveAccessibleName('天气城市：苏州市，点击更换')
    expect(await page.evaluate(() => localStorage.getItem('hjc-weather-city:mock:cosyhome'))).toBe('{"code":"320500"}')
    await page.reload()
    await settle(page)
    await expect(trigger(page)).toHaveAccessibleName('天气城市：苏州市，点击更换')
    // 换成管理员账号（另一个账号键）：回到默认无锡
    await page.evaluate(() => localStorage.setItem('hjc-auth', JSON.stringify({ username: 'hjadmin', role: 'admin' })))
    await page.reload()
    await settle(page)
    await expect(trigger(page)).toHaveAccessibleName('天气城市：无锡市，点击更换')
  })

  test('打开态截图', async ({ page }) => {
    await trigger(page).click()
    await tick(page, 300)
    await expect(search(page)).toBeFocused()
    // 当前城市贴列表底边（从顶端出发的 nearest 位置），与弹层定位、列表定高的先后无关；位置稳定后再截图
    await expect(page.locator('[cmdk-item][data-current]')).toBeInViewport({ ratio: 1 })
    await shot(page, 'weather-city-picker')
  })
})
