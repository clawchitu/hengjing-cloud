// Popover + Command（S3b）的交互与键盘行为：项目切换菜单、顶栏项目搜索。只做行为断言，不截图
// （打开态外观由 overlays.spec.ts / states.spec.ts 的基线锁定）。
// 共同约定：鼠标打开时没有高亮（同旧版）；上下键移动高亮、回车选中；Esc 关闭；点外部关闭。
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

/** 时钟是暂停的：每次操作后推进一点，让 Radix 的 setTimeout 焦点回收和 mock 数据跑完 */
const tick = (page: Page, ms = 100) => page.clock.runFor(ms)

const trigger = (page: Page) => page.locator('.proj-switch')
const menu = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('listbox', { name: '切换当前项目' }) })
const menuOptions = (page: Page) => page.getByRole('listbox', { name: '切换当前项目' }).getByRole('option')
const search = (page: Page) => page.getByPlaceholder('搜索项目名称 / 项目ID')
const hits = (page: Page) => page.getByRole('listbox', { name: '项目搜索结果' }).getByRole('option')
const currentName = (page: Page) => page.locator('.proj-switch .name')

/** 当前高亮项（cmdk 的 aria-selected 表示键盘高亮，不是当前项目） */
const highlighted = (list: Locator) => list.and(list.page().locator('[aria-selected="true"]'))

/** aria-activedescendant 指向的元素文字（没有该属性时返回 null） */
async function activeText(page: Page, owner: Locator) {
  const id = await owner.getAttribute('aria-activedescendant')
  if (!id) return null
  return (await page.locator(`[id="${id}"]`).textContent())?.trim() ?? ''
}

async function open(page: Page, login: (role: 'dealer' | 'admin', project?: string) => Promise<void>, role: 'dealer' | 'admin' = 'dealer', project?: string) {
  await login(role, project)
  await page.goto('/home')
  await tick(page, 1500)
}

test.describe('项目切换菜单', () => {
  test('鼠标打开：没有高亮；Esc 关闭，焦点回到触发器', async ({ page, login }) => {
    await open(page, login)
    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    await expect(menu(page)).toBeVisible()
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(highlighted(menuOptions(page))).toHaveCount(0)
    await expect(menu(page)).not.toHaveAttribute('aria-activedescendant')
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(menu(page)).toHaveCount(0)
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger(page)).toBeFocused()
  })

  test('键盘打开：高亮落在当前项目，下键移动、回车切换，焦点回到触发器', async ({ page, login }) => {
    await open(page, login)
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(menu(page)).toBeVisible()
    await expect(highlighted(menuOptions(page))).toHaveText(/朝阳壹号院 A栋/)
    expect(await activeText(page, menu(page))).toContain('朝阳壹号院 A栋')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveText(/朝阳壹号院 B栋/)
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await page.keyboard.press('ArrowUp')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveText(/朝阳壹号院 B栋/)
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(menu(page)).toHaveCount(0)
    await expect(currentName(page)).toHaveText('朝阳壹号院 B栋')
    await expect(page.locator('.toast').filter({ hasText: '已切换到「朝阳壹号院 B栋」' })).toBeVisible()
    await expect(trigger(page)).toBeFocused()
  })

  test('Tab 关闭菜单，焦点回到触发器', async ({ page, login }) => {
    await open(page, login)
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('Tab')
    await tick(page)
    await expect(menu(page)).toHaveCount(0)
    await expect(trigger(page)).toBeFocused()
  })

  test('空格、下键也能打开菜单', async ({ page, login }) => {
    await open(page, login)
    for (const key of ['Space', 'ArrowDown']) {
      await trigger(page).focus()
      await page.keyboard.press(key)
      await tick(page)
      await expect(menu(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await tick(page)
      await expect(menu(page)).toHaveCount(0)
    }
  })

  test('鼠标打开后按上下键：先高亮当前项目并滚进可视区', async ({ page, login }) => {
    // 当前项目在菜单很靠后（同 overlays 的 admin-project-menu-cur-below）
    await open(page, login, 'admin', 'PRJ-60012')
    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    const cur = menu(page).locator('[data-current]')
    await expect(cur).not.toBeInViewport()
    expect(await menu(page).evaluate((m) => m.scrollTop)).toBe(0)
    // 鼠标打开时没有高亮，回车不选任何项
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(menu(page)).toBeVisible()
    await expect(currentName(page)).toContainText('河西府 2栋')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveText(/河西府 2栋/)
    await expect(cur).toBeInViewport()
    expect(await activeText(page, menu(page))).toContain('河西府 2栋')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveText(/河西府 3栋/)
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(currentName(page)).toContainText('河西府 3栋')
  })

  test('鼠标移动清掉键盘高亮', async ({ page, login }) => {
    await open(page, login)
    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveCount(1)
    const box = (await menuOptions(page).nth(3).boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 10)
    await page.mouse.move(box.x + 30, box.y + 12)
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveCount(0)
  })

  test('点选项切换项目；点外部关闭且不抢焦点', async ({ page, login }) => {
    await open(page, login)
    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    await menuOptions(page).filter({ hasText: '朝阳壹号院 C栋' }).click()
    await tick(page)
    await expect(menu(page)).toHaveCount(0)
    await expect(currentName(page)).toHaveText('朝阳壹号院 C栋')
    // 鼠标选中后焦点回到触发器，但不出现键盘焦点环
    expect(await trigger(page).evaluate((n) => n.matches(':focus-visible'))).toBe(false)

    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    await expect(menu(page)).toBeVisible()
    // 菜单里点非选项处（分组标题）不关闭
    await menu(page).getByText('朝阳壹号院住宅组', { exact: true }).click()
    await tick(page)
    await expect(menu(page)).toBeVisible()
    await page.locator('h1').first().click()
    await tick(page)
    await expect(menu(page)).toHaveCount(0)
    await expect(trigger(page)).not.toBeFocused()
    // 再点触发器：打开；再点一次：关闭（同旧版的切换）
    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    await expect(menu(page)).toBeVisible()
    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    await expect(menu(page)).toHaveCount(0)
  })
})

test.describe('顶栏项目搜索', () => {
  test('输入后弹出结果，没有高亮；下键高亮、回车选中高亮项', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    await input.fill('朝阳壹号院')
    await tick(page)
    await expect(hits(page)).toHaveCount(8)
    await expect(input).toHaveAttribute('aria-expanded', 'true')
    await expect(highlighted(hits(page))).toHaveCount(0)
    await expect(input).not.toHaveAttribute('aria-activedescendant')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(hits(page))).toHaveText(/朝阳壹号院 A栋/)
    expect(await activeText(page, input)).toContain('朝阳壹号院 A栋')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(hits(page))).toHaveText(/朝阳壹号院 B栋/)
    expect(await activeText(page, input)).toContain('朝阳壹号院 B栋')
    await expect(input).toBeFocused()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(hits(page)).toHaveCount(0)
    await expect(currentName(page)).toHaveText('朝阳壹号院 B栋')
    await expect(page.locator('.toast').filter({ hasText: '当前项目已切换为「朝阳壹号院 B栋」' })).toBeVisible()
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  test('没有高亮时回车选第一条（同旧版）', async ({ page, login }) => {
    await open(page, login)
    await search(page).fill('河西')
    await tick(page)
    await expect(hits(page)).toHaveCount(0) // 经销商看不到南京的项目
    await search(page).fill('地库')
    await tick(page)
    const first = ((await hits(page).first().locator('b').textContent()) ?? '').trim()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(currentName(page)).toHaveText(first)
  })

  test('改输入后高亮清空，回车仍选第一条', async ({ page, login }) => {
    await open(page, login)
    await search(page).fill('朝阳')
    await tick(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(hits(page))).toHaveCount(1)
    await page.keyboard.type('壹号院 F')
    await tick(page)
    await expect(highlighted(hits(page))).toHaveCount(0)
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(currentName(page)).toHaveText('朝阳壹号院 F栋')
  })

  test('Esc 关闭，焦点留在输入框；继续输入或按下键重新打开', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    await input.fill('朝阳')
    await tick(page)
    await expect(hits(page).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(hits(page)).toHaveCount(0)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('朝阳')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(hits(page).first()).toBeVisible()
    await expect(highlighted(hits(page))).toHaveCount(0)
    await page.keyboard.press('Escape')
    await tick(page)
    await page.keyboard.type('壹')
    await tick(page)
    await expect(hits(page).first()).toBeVisible()
  })

  test('Home / End 在输入框里移动光标，不跳到首尾项', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    await input.fill('朝阳')
    await tick(page)
    await input.evaluate((n: HTMLInputElement) => n.setSelectionRange(1, 1))
    await page.keyboard.press('End')
    await tick(page)
    expect(await input.evaluate((n: HTMLInputElement) => n.selectionStart)).toBe(2)
    await expect(highlighted(hits(page))).toHaveCount(0)
    await page.keyboard.press('Home')
    await tick(page)
    expect(await input.evaluate((n: HTMLInputElement) => n.selectionStart)).toBe(0)
    await expect(highlighted(hits(page))).toHaveCount(0)
  })

  test('点结果切换项目；点输入框不关闭，点外部关闭', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    await input.fill('朝阳')
    await tick(page)
    await hits(page).filter({ hasText: '朝阳壹号院 C栋' }).click()
    await tick(page)
    await expect(currentName(page)).toHaveText('朝阳壹号院 C栋')
    await expect(input).toBeFocused()
    await input.fill('朝阳')
    await tick(page)
    await input.click()
    await tick(page)
    await expect(hits(page).first()).toBeVisible()
    await page.locator('h1').first().click()
    await tick(page)
    await expect(hits(page)).toHaveCount(0)
    // 重新聚焦输入框即重新打开（同旧版）
    await input.click()
    await tick(page)
    await expect(hits(page).first()).toBeVisible()
  })
})
