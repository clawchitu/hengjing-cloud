// 首页天气城市选择（S7b，演示数据模式）：省 → 市两级（打开定位到当前省、返回省份列表、直辖市直接选中、搜索平铺带省名、
// 高度上限 360px），键盘操作（方向键、回车、退格返回、Esc、焦点回收）、选城市后刷新仍在、换账号不带过去，
// 以及打开态截图 weather-city-picker（江苏省城市列表）、weather-city-provinces（省份列表）。城市来自本地城市文件，默认无锡；选择存在 localStorage（hjc-weather-city:<账号键>）。
import type { Page } from '@playwright/test'
import { expect, settle, shot, test } from './fixtures'

const tick = (page: Page, ms = 100) => page.clock.runFor(ms)
const trigger = (page: Page) => page.getByRole('button', { name: /^天气城市：/ })
const search = (page: Page) => page.getByRole('combobox', { name: '搜索城市' })
const back = (page: Page) => page.getByRole('option', { name: /^返回省份列表/ })
const option = (page: Page, name: string) => page.getByRole('option', { name, exact: true })

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
    await expect(page.locator('[cmdk-item]')).toHaveText(['大理白族自治州 · 云南省'])
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

  test('打开后列表变高 / 变矮：当前城市仍整行可见（位置与定高先后无关）；方向键离开再回来不再按打开时的位置滚', async ({ page }) => {
    await trigger(page).click()
    await tick(page, 300)
    const cur = page.locator('[cmdk-item][data-current]')
    await expect(cur).toBeInViewport({ ratio: 1 })
    const list = page.locator('[cmdk-list]')
    for (const h of ['160px', '420px']) {
      await list.evaluate((el, v) => { (el as HTMLElement).style.maxHeight = v }, h)
      await tick(page, 100)
      await expect(cur).toBeInViewport({ ratio: 1 })
    }
    await page.keyboard.press('ArrowDown')
    await tick(page, 100)
    const top = await list.evaluate((el) => el.scrollTop)
    await page.keyboard.press('ArrowUp')
    await tick(page, 100)
    await expect(cur).toBeInViewport({ ratio: 1 })
    expect(await list.evaluate((el) => el.scrollTop)).toBe(top)
  })

  test('两级：打开在江苏省城市列表；返回到省份列表、江苏省可见；点上海市直接选中；高度不超过 360px', async ({ page }) => {
    await trigger(page).click()
    await tick(page, 300)
    await expect(page.locator('[cmdk-list]')).toHaveAccessibleName('江苏省')
    await expect(back(page)).toBeInViewport()
    const box = await page.getByRole('dialog', { name: '选择天气城市' }).boundingBox()
    expect(box!.height).toBeLessThanOrEqual(360)
    await back(page).click()
    await tick(page, 300)
    await expect(page.locator('[cmdk-list]')).toHaveAccessibleName('省份')
    await expect(page.locator('[cmdk-item]')).toHaveCount(31)
    await expect(page.locator('[cmdk-item][data-current-province]')).toHaveText('江苏省')
    await expect(page.locator('[cmdk-item][data-current-province]')).toBeInViewport({ ratio: 1 })
    await expect(search(page)).toBeFocused()
    await option(page, '上海市').click()
    await tick(page)
    await expect(search(page)).toHaveCount(0)
    await expect(trigger(page)).toHaveAccessibleName('天气城市：上海市，点击更换')
  })

  test('两级键盘：退格回到省份列表，方向键 + 回车进入浙江省，回车选中第一个市', async ({ page }) => {
    await trigger(page).focus()
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await page.keyboard.press('Backspace')
    await tick(page)
    await expect(page.locator('[cmdk-item][aria-selected="true"]')).toHaveText('江苏省')
    await page.keyboard.press('ArrowDown') // 江苏省的下一个：浙江省
    await tick(page)
    await page.keyboard.press('Enter')
    await tick(page, 100)
    await expect(page.locator('[cmdk-list]')).toHaveAccessibleName('浙江省')
    await expect(search(page)).toBeFocused()
    await expect(page.locator('[cmdk-item][aria-selected="true"]')).toHaveText('杭州市')
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(trigger(page)).toHaveAccessibleName('天气城市：杭州市，点击更换')
    await expect(trigger(page)).toBeFocused()
  })

  /** 把当前城市换成凉山彝族自治州（四川省列表靠后，打开时必须滚动才可见） */
  const useLiangshan = async (page: Page) => {
    await page.evaluate(() => localStorage.setItem('hjc-weather-city:mock:cosyhome', '{"code":"513400"}'))
    await page.reload()
    await settle(page)
    await expect(trigger(page)).toHaveAccessibleName('天气城市：凉山彝族自治州，点击更换')
  }

  test('需要滚动的城市（凉山）：打开后高亮直接到位，没有平滑滚动的中间帧', async ({ page }) => {
    await useLiangshan(page)
    await trigger(page).click()
    await tick(page, 50)
    const list = page.locator('[cmdk-list]')
    const cur = page.locator('[cmdk-item][data-current]')
    expect(await list.evaluate((el) => getComputedStyle(el).scrollBehavior)).toBe('auto')
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await expect(cur).toHaveText('凉山彝族自治州')
    await expect(cur).toBeInViewport({ ratio: 1 })
    const early = await list.evaluate((el) => el.scrollTop)
    expect(early).toBeGreaterThan(0)
    await tick(page, 500)
    await expect(cur).toBeInViewport({ ratio: 1 })
    expect(await list.evaluate((el) => el.scrollTop)).toBe(early)
  })

  test('需要滚动的城市（凉山）：顶部固定的返回行不遮挡高亮；向上走到第一个市也不被挡', async ({ page }) => {
    await useLiangshan(page)
    await trigger(page).click()
    await tick(page, 300)
    const sel = page.locator('[cmdk-item][aria-selected="true"]')
    const clear = async () => {
      const head = (await back(page).boundingBox())!
      const box = (await sel.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
    }
    await expect(sel).toHaveText('凉山彝族自治州')
    await clear()
    const n = await page.locator('[cmdk-item]').count()
    for (let i = 0; i < n - 2; i++) {
      await page.keyboard.press('ArrowUp')
      await tick(page, 50)
      await clear()
    }
    await expect(sel).toHaveText('成都市')
    await expect(sel).toBeInViewport({ ratio: 1 })
  })

  test('当前城市是直辖市：打开直接显示省份列表并高亮它；省份项标明直接选中 / 进入下一级；搜索后清空高亮恢复', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('hjc-weather-city:mock:cosyhome', '{"code":"310000"}'))
    await page.reload()
    await settle(page)
    await trigger(page).click()
    await tick(page, 300)
    await expect(page.locator('[cmdk-list]')).toHaveAccessibleName('省份')
    const sel = page.locator('[cmdk-item][aria-selected="true"]')
    await expect(sel).toHaveText('上海市')
    await expect(sel).toBeInViewport({ ratio: 1 })
    await expect(option(page, '上海市')).toHaveAccessibleDescription('直接选中')
    await expect(option(page, '江苏省')).toHaveAccessibleDescription('进入城市列表')
    await search(page).fill('苏州')
    await tick(page, 50)
    await expect(sel).toHaveText('苏州市 · 江苏省')
    await search(page).fill('')
    await tick(page, 100)
    await expect(page.locator('[cmdk-list]')).toHaveAccessibleName('省份')
    await expect(sel).toHaveText('上海市')
    await expect(sel).toBeInViewport({ ratio: 1 })
  })

  test('搜索「苏州」平铺显示「苏州市 · 江苏省」', async ({ page }) => {
    await trigger(page).click()
    await tick(page)
    await search(page).fill('苏州')
    await tick(page, 50)
    await expect(page.locator('[cmdk-item]')).toHaveText(['苏州市 · 江苏省'])
    await expect(back(page)).toHaveCount(0)
  })

  test('省份列表截图：江苏省按「从顶端出发」直接滚到位', async ({ page }) => {
    await trigger(page).click()
    await tick(page, 300)
    await back(page).click()
    await page.mouse.move(0, 0) // 鼠标移出弹层，截图里没有悬停底色
    await tick(page, 300)
    await expect(search(page)).toBeFocused()
    await expect(page.locator('[cmdk-item][aria-selected="true"]')).toHaveText('江苏省') // 鼠标在弹层外移动不清高亮
    await expect(page.locator('[cmdk-item][data-current-province]')).toBeInViewport({ ratio: 1 })
    await shot(page, 'weather-city-provinces')
  })

  test('打开态截图', async ({ page }) => {
    await trigger(page).click()
    await tick(page, 300)
    await expect(search(page)).toBeFocused()
    // 江苏省 13 个市都在可见区内时不滚动；位置由「从顶端出发」的绝对位置决定，与弹层定位、列表定高的先后无关
    await expect(page.locator('[cmdk-item][data-current]')).toBeInViewport({ ratio: 1 })
    await shot(page, 'weather-city-picker')
  })
})
