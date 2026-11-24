// 经销商可搜索下拉（S6b，src/components/DealerSelect.tsx）的键盘行为与触发器焦点环。只做行为断言，不截图
// （打开态外观由 states.spec.ts 的 admin-groups-dealer-* 基线锁定）。触发器是原生按钮，焦点环用浏览器默认规则：键盘关闭有外圈、鼠标点选后没有。
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const tick = (page: Page, ms = 100) => page.clock.runFor(ms)
const trigger = (page: Page) => page.getByRole('button', { name: /^经销商/ })
const list = (page: Page) => page.getByRole('listbox', { name: '经销商' })
const options = (page: Page) => list(page).getByRole('option')
const search = (page: Page) => page.getByRole('combobox', { name: '搜索经销商' })
const highlighted = (page: Page) => list(page).locator('[role=option][aria-selected="true"]')

async function open(page: Page, login: (role: 'admin') => Promise<void>) {
  await login('admin')
  await page.goto('/groups')
  await tick(page, 1500)
}
/** 键盘 Tab 到触发器（让“之前用过键盘”成立） */
async function tabToTrigger(page: Page) {
  await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    if (await trigger(page).evaluate((n) => n === document.activeElement)) return
  }
  throw new Error('Tab 没能聚焦到经销商触发器')
}
const ring = (page: Page) => trigger(page).evaluate((n) => ({ focused: n === document.activeElement, fv: n.matches(':focus-visible'), outline: getComputedStyle(n).outlineStyle }))

test('键盘：下键打开、高亮当前经销商；方向键移动，aria-activedescendant 跟随；回车选中并关闭，焦点回到触发器', async ({ page, login }) => {
  await open(page, login)
  await trigger(page).focus()
  await page.keyboard.press('ArrowDown')
  await tick(page)
  await expect(search(page)).toBeFocused()
  await expect(highlighted(page)).toHaveText(/上海恒境暖通/)
  await page.keyboard.press('ArrowDown')
  await tick(page)
  await expect(highlighted(page)).toHaveText(/杭州暖居/)
  const id = await highlighted(page).getAttribute('id')
  await expect(search(page)).toHaveAttribute('aria-activedescendant', id!)
  await expect(search(page)).toHaveAttribute('aria-controls', (await list(page).getAttribute('id'))!)
  await page.keyboard.press('Enter')
  await tick(page)
  await expect(list(page)).toHaveCount(0)
  await expect(trigger(page)).toContainText('杭州暖居')
  await expect(page.locator('.grp-card').first()).toContainText('西溪蝶园别墅组')
  await expect(trigger(page)).toBeFocused()
})

test('输入时高亮第一条命中；鼠标移动清掉高亮后回车选第一条；Home / End 留给输入框', async ({ page, login }) => {
  await open(page, login)
  await trigger(page).click()
  await tick(page)
  await search(page).pressSequentially('有限公司')
  await tick(page)
  await expect(options(page)).toHaveCount(3)
  await expect(highlighted(page)).toHaveText(/上海恒境暖通/)
  await page.keyboard.press('End')
  await tick(page)
  await expect(highlighted(page)).toHaveText(/上海恒境暖通/) // End 没有跳到最后一项
  await search(page).fill('杭州')
  await tick(page)
  await expect(highlighted(page)).toHaveText(/杭州暖居/)
  const box = (await options(page).first().boundingBox())!
  await page.mouse.move(box.x + 5, box.y + 5)
  await page.mouse.move(box.x + 15, box.y + 8)
  await tick(page)
  await expect(highlighted(page)).toHaveCount(0)
  await search(page).focus()
  await page.keyboard.press('Enter')
  await tick(page)
  await expect(trigger(page)).toContainText('杭州暖居')
})

for (const key of ['Tab', 'Shift+Tab']) {
  test(`${key} 关闭下拉，焦点回到触发器，不改选择`, async ({ page, login }) => {
    await open(page, login)
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    await tick(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press(key)
    await tick(page)
    await expect(list(page)).toHaveCount(0)
    await expect(trigger(page)).toBeFocused()
    await expect(trigger(page)).toContainText('上海恒境暖通')
  })
}

// 焦点环：先键盘 Tab 到触发器，再按打开方式 × 关闭方式操作，看关闭后触发器的外圈
const CLOSE = { 鼠标点选项: false, 鼠标再点触发器: false, 回车选中: true, Esc: true, 搜索后鼠标点选项: false } as const
for (const how of ['鼠标', '键盘'] as const) {
  for (const [close, want] of Object.entries(CLOSE)) {
    test(`焦点环：${how}打开 → ${close}关闭`, async ({ page, login }) => {
      await open(page, login)
      await tabToTrigger(page)
      expect(await ring(page)).toMatchObject({ focused: true, fv: true })
      if (how === '鼠标') await trigger(page).click()
      else await page.keyboard.press('Enter')
      await tick(page)
      await expect(list(page)).toBeVisible()
      switch (close) {
        case '鼠标点选项': await options(page).filter({ hasText: '杭州暖居' }).click(); break
        case '鼠标再点触发器': await trigger(page).click(); break
        case '回车选中': await search(page).focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); break
        case 'Esc': await page.keyboard.press('Escape'); break
        case '搜索后鼠标点选项': await search(page).pressSequentially('杭州'); await tick(page); await options(page).first().click(); break
      }
      await tick(page)
      await expect(list(page)).toHaveCount(0)
      const r = await ring(page)
      expect(r.focused).toBe(true)
      if (want) expect(r.outline).not.toBe('none')
      else expect(r.outline).toBe('none')
      // 键盘接管（非修饰键）后外圈回来
      await page.keyboard.press('x')
      await tick(page)
      expect((await ring(page)).outline).not.toBe('none')
    })
  }
}
