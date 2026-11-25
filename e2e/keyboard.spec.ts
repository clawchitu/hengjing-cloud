// 键盘可操作性（docs/plan-s1-s3.md 第 2 节 S2 验收；Button 的用例在 interactions.spec.ts）：Switch 空格切换且 aria-checked 正确；
// Select 方向键选择、Esc 关闭并回到触发器；Tabs 左右键切换。只做行为断言，不截图。
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/** 时钟是暂停的：每次按键后推进一点，让 Radix 的 setTimeout(0) 焦点回收和 mock 数据跑完 */
const tick = (page: Page, ms = 100) => page.clock.runFor(ms)

test('Switch：空格切换，aria-checked 跟随', async ({ page, login }) => {
  // 系统设置页的通知开关已按 Q12 去掉（S11）；新风运行设置在 S10b 改为只读，改用温控卡片的「节能模式」开关：它只改本地草稿，不下发
  await login('dealer')
  await page.goto('/thermostat')
  await tick(page, 1500)
  const sw = page.getByRole('switch', { name: '客厅 节能模式', exact: true })
  const before = await sw.getAttribute('aria-checked')
  const after = before === 'true' ? 'false' : 'true'
  await sw.focus()
  await page.keyboard.press('Space')
  await tick(page)
  await expect(sw).toHaveAttribute('aria-checked', after)
  await page.keyboard.press('Space')
  await tick(page)
  await expect(sw).toHaveAttribute('aria-checked', before!)
})

test('Checkbox：空格切换', async ({ page }) => {
  await page.goto('/login')
  await tick(page, 500)
  const cb = page.getByRole('checkbox', { name: '记住我' })
  await expect(cb).toHaveAttribute('aria-checked', 'true')
  await cb.focus()
  await page.keyboard.press('Space')
  await tick(page)
  await expect(cb).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Space')
  await tick(page)
  await expect(cb).toHaveAttribute('aria-checked', 'true')
})

test('Select：方向键选择，Esc 关闭并回到触发器', async ({ page, login }) => {
  await login('dealer')
  await page.goto('/thermostat')
  await tick(page, 1500)
  const trigger = page.getByRole('combobox', { name: '统计房间' })
  const first = (await trigger.textContent()) ?? ''
  expect(first).not.toBe('')
  await trigger.focus()
  // 方向键打开，高亮落在当前项；再按一次下移，回车选中
  await page.keyboard.press('ArrowDown')
  await tick(page)
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  const texts = (await page.getByRole('option').allTextContents()).map((t) => t.trim())
  const cur = texts.indexOf(first.trim())
  expect(cur).toBeGreaterThanOrEqual(0)
  expect(cur).toBeLessThan(texts.length - 1)
  const second = texts[cur + 1]
  await page.keyboard.press('ArrowDown')
  await tick(page)
  await page.keyboard.press('Enter')
  await tick(page)
  await expect(list).toHaveCount(0)
  await expect(trigger).toHaveText(second)
  await expect(trigger).toBeFocused()
  // 再打开，Esc 关闭：不改值，焦点回到触发器
  await page.keyboard.press('Enter')
  await tick(page)
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('ArrowUp')
  await tick(page)
  await page.keyboard.press('Escape')
  await tick(page)
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(trigger).toHaveText(second)
  await expect(trigger).toBeFocused()
})

test('Tabs：左右方向键切换新风设备', async ({ page, login }) => {
  await login('dealer', 'PRJ-10252')
  await page.goto('/fresh-air')
  await tick(page, 1500)
  const tabs = page.getByRole('tablist', { name: '新风设备' }).getByRole('tab')
  expect(await tabs.count()).toBeGreaterThanOrEqual(3)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  await tabs.nth(0).focus()
  await page.keyboard.press('ArrowRight')
  await tick(page)
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(1)).toBeFocused()
  await expect(tabs.nth(1)).toHaveClass(/\bon\b/)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press('ArrowRight')
  await tick(page)
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await tick(page)
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  // 面板跟随当前设备
  const name = ((await tabs.nth(1).locator('b').textContent()) ?? '').trim()
  await expect(page.getByRole('tabpanel')).toContainText(`实时数据 · ${name}`)
  // 循环：最左再按左键到最后一个
  await page.keyboard.press('ArrowLeft')
  await tick(page)
  await page.keyboard.press('ArrowLeft')
  await tick(page)
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true')
})
