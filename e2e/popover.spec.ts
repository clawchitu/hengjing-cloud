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

/**
 * 当前焦点元素（读屏实际读取的那个）的角色，以及它的 aria-activedescendant 指向的元素文字（没有该属性时为 null；
 * 指向的元素不存在时为 'MISSING'）
 */
async function focusedActive(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement
    const id = el?.getAttribute('aria-activedescendant')
    const target = id ? document.getElementById(id) : null
    return { role: el?.getAttribute('role') ?? el?.tagName, active: id ? (target ? (target.textContent ?? '').trim() : 'MISSING') : null }
  })
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
    // 弹层是有名称的 dialog，触发器声明的弹出类型与之一致；焦点在列表上，没有活动项
    await expect(page.getByRole('dialog', { name: '切换当前项目' })).toBeVisible()
    await expect(trigger(page)).toHaveAttribute('aria-haspopup', 'dialog')
    expect(await trigger(page).getAttribute('aria-controls')).toBe(await menu(page).getAttribute('id'))
    expect(await focusedActive(page)).toEqual({ role: 'listbox', active: null })
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
    expect(await focusedActive(page)).toEqual({ role: 'listbox', active: expect.stringContaining('朝阳壹号院 A栋') })
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveText(/朝阳壹号院 B栋/)
    expect(await focusedActive(page)).toEqual({ role: 'listbox', active: expect.stringContaining('朝阳壹号院 B栋') })
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

  for (const key of ['Tab', 'Shift+Tab']) {
    test(`${key} 关闭菜单，焦点回到触发器`, async ({ page, login }) => {
      await open(page, login)
      await trigger(page).focus()
      await page.keyboard.press('Enter')
      await tick(page)
      await expect(menu(page)).toBeVisible()
      await page.keyboard.press(key)
      await tick(page)
      await expect(menu(page)).toHaveCount(0)
      await expect(trigger(page)).toBeFocused()
    })
  }

  // 触发器焦点环的状态表（与 Layout.tsx ProjectSwitch 注释里的表一一对应）。每格都先用键盘 Tab 到触发器，
  // 让“之前用过键盘”成立（这是 Chromium 把脚本还焦点算作 :focus-visible 的前提），再按打开方式 × 关闭方式操作，
  // 检查关闭后的外圈、“直接按键”与“Tab 回来”。外圈一律断言计算样式 outline-style，不只断言聚焦
  const CLOSE = {
    鼠标点选项: { focus: 'trigger', ring: false },
    鼠标再点触发器: { focus: 'trigger', ring: false },
    回车选中: { focus: 'trigger', ring: true },
    Esc: { focus: 'trigger', ring: true },
    Tab: { focus: 'trigger', ring: true },
    'Shift+Tab': { focus: 'trigger', ring: true },
    点外部: { focus: 'elsewhere', ring: false },
  } as const
  const ringOf = (page: Page) => trigger(page).evaluate((n) => ({ fv: n.matches(':focus-visible'), outline: getComputedStyle(n).outlineStyle }))
  const expectRing = async (page: Page, on: boolean) => {
    await expect(trigger(page)).toBeFocused()
    const r = await ringOf(page)
    if (on) expect(r).toEqual({ fv: true, outline: expect.not.stringMatching(/^none$/) })
    else expect(r.outline).toBe('none')
  }
  const tabToTrigger = async (page: Page) => {
    // 侧栏里触发器前面的最后一个链接
    await page.locator('.sidebar .nav-item', { hasText: '统一控制' }).focus()
    await page.keyboard.press('Tab')
    await tick(page)
  }
  for (const how of ['鼠标', '键盘'] as const) {
    for (const [close, want] of Object.entries(CLOSE)) {
      test(`焦点环：${how}打开 → ${close}关闭`, async ({ page, login }) => {
        await open(page, login)
        await tabToTrigger(page)
        await expectRing(page, true)
        if (how === '鼠标') await page.getByText('当前项目', { exact: true }).click()
        else await page.keyboard.press('Enter')
        await tick(page)
        await expect(menu(page)).toBeVisible()
        switch (close) {
          case '鼠标点选项': await menuOptions(page).filter({ hasText: '朝阳壹号院 B栋' }).click(); break
          case '鼠标再点触发器': await page.getByText('当前项目', { exact: true }).click(); break
          case '回车选中':
            await page.keyboard.press(how === '鼠标' ? 'ArrowDown' : 'ArrowUp') // 鼠标打开：先高亮当前项；键盘打开：已在当前项
            await page.keyboard.press('ArrowDown')
            await page.keyboard.press('Enter')
            break
          case '点外部': await page.locator('h1').first().click(); break
          case 'Esc': await page.keyboard.press('Escape'); break
          default: await page.keyboard.press(close)
        }
        await tick(page)
        await expect(menu(page)).toHaveCount(0)
        if (close === '鼠标点选项' || close === '回车选中') await expect(currentName(page)).toHaveText('朝阳壹号院 B栋')
        if (want.focus === 'trigger') {
          await expectRing(page, want.ring)
          // 直接按键（非修饰键，对触发器无副作用）：键盘接管，外圈出现
          await page.keyboard.press('Shift') // 单按修饰键不算
          await expectRing(page, want.ring)
          await page.keyboard.press('x')
          await tick(page)
          await expectRing(page, true)
        } else {
          await expect(trigger(page)).not.toBeFocused()
        }
        // Tab 回来：外圈一定出现
        await tabToTrigger(page)
        await expectRing(page, true)
        // Shift+Tab 回来同样
        await page.keyboard.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await tick(page)
        await expectRing(page, true)
      })
    }
  }

  for (const height of [560, 420]) {
    test(`矮窗口（高 ${height}）：菜单整个在屏内，能滚到最后一项`, async ({ page, login }) => {
      await page.setViewportSize({ width: 1440, height })
      await open(page, login, 'admin')
      await page.getByText('当前项目', { exact: true }).click()
      await tick(page)
      const box = (await menu(page).boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(height)
      const last = menuOptions(page).last()
      await expect(last).not.toBeInViewport()
      await menu(page).evaluate((m) => { m.scrollTop = m.scrollHeight })
      await expect(last).toBeInViewport({ ratio: 1 })
      // 键盘 End 也能到最后一项
      await page.keyboard.press('Home')
      await page.keyboard.press('End')
      await tick(page)
      await expect(highlighted(menuOptions(page))).toHaveText(await last.textContent() ?? '')
    })
  }

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
    expect(await focusedActive(page)).toEqual({ role: 'listbox', active: expect.stringContaining('河西府 2栋') })
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
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveText(/朝阳壹号院 B栋/)
    expect(await focusedActive(page)).toEqual({ role: 'listbox', active: expect.stringContaining('朝阳壹号院 B栋') })
    const box = (await menuOptions(page).nth(3).boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 10)
    await page.mouse.move(box.x + 30, box.y + 12)
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveCount(0)
    expect(await focusedActive(page)).toEqual({ role: 'listbox', active: null })
    // 再按方向键：从当前项目重新开始，焦点元素上的活动项与高亮一致（不残留清除前的旧值）
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(menuOptions(page))).toHaveText(/朝阳壹号院 A栋/)
    expect(await focusedActive(page)).toEqual({ role: 'listbox', active: expect.stringContaining('朝阳壹号院 A栋') })
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
    // aria-controls 指向结果 listbox（不是外层 dialog）
    const listId = await page.getByRole('listbox', { name: '项目搜索结果' }).getAttribute('id')
    expect(listId).toBeTruthy()
    await expect(input).toHaveAttribute('aria-controls', listId!)
    await expect(page.getByRole('dialog', { name: '项目搜索结果' })).toBeVisible()
    await expect(highlighted(hits(page))).toHaveCount(0)
    await expect(input).not.toHaveAttribute('aria-activedescendant')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(hits(page))).toHaveText(/朝阳壹号院 A栋/)
    expect(await focusedActive(page)).toEqual({ role: 'combobox', active: expect.stringContaining('朝阳壹号院 A栋') })
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(hits(page))).toHaveText(/朝阳壹号院 B栋/)
    expect(await focusedActive(page)).toEqual({ role: 'combobox', active: expect.stringContaining('朝阳壹号院 B栋') })
    await expect(input).toBeFocused()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(hits(page)).toHaveCount(0)
    await expect(currentName(page)).toHaveText('朝阳壹号院 B栋')
    await expect(page.locator('.toast').filter({ hasText: '当前项目已切换为「朝阳壹号院 B栋」' })).toBeVisible()
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('aria-expanded', 'false')
    await expect(input).not.toHaveAttribute('aria-controls')
    await expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  test('无结果时：aria-controls 仍指向（空的）结果列表，没有活动项', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    await input.fill('西溪')
    await tick(page)
    await expect(page.getByText('未找到匹配的项目（仅搜索您可见的集成项目内的项目）')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await tick(page)
    const listId = await page.getByRole('listbox', { name: '项目搜索结果' }).getAttribute('id')
    await expect(input).toHaveAttribute('aria-controls', listId!)
    await expect(input).not.toHaveAttribute('aria-activedescendant')
    // 点“未找到”文字不让输入框失焦
    await page.getByText('未找到匹配的项目（仅搜索您可见的集成项目内的项目）').click()
    await tick(page)
    await expect(input).toBeFocused()
  })

  test('高亮后关闭再打开：高亮清空，回车选第一条而不是旧高亮项', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    const reopenAndCheck = async () => {
      await expect(hits(page).first()).toBeVisible()
      await expect(highlighted(hits(page))).toHaveCount(0)
      await expect(input).not.toHaveAttribute('aria-activedescendant')
    }
    const highlightThird = async () => {
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
      await tick(page)
      await expect(highlighted(hits(page))).toHaveText(/朝阳壹号院 C栋/)
    }
    await input.fill('朝阳')
    await tick(page)
    // Esc → 下键重开
    await highlightThird()
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(input).not.toHaveAttribute('aria-activedescendant')
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await reopenAndCheck()
    // 点外部 → 点输入框重开
    await highlightThird()
    await page.locator('h1').first().click()
    await tick(page)
    await expect(hits(page)).toHaveCount(0)
    await input.click()
    await tick(page)
    await reopenAndCheck()
    // Tab 离开（关闭）→ 回到输入框重开
    await highlightThird()
    await page.keyboard.press('Tab')
    await tick(page)
    await expect(hits(page)).toHaveCount(0)
    await expect(input).not.toBeFocused()
    await input.focus()
    await tick(page)
    await reopenAndCheck()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(currentName(page)).toHaveText('朝阳壹号院 A栋')
  })

  test('一次性改掉输入、高亮项被筛掉：不自动高亮新的第一项', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    await input.fill('朝阳')
    await tick(page)
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
    await tick(page)
    await expect(highlighted(hits(page))).toHaveText(/朝阳壹号院 C栋/)
    await input.fill('朝阳壹号院 F')
    await tick(page)
    await expect(hits(page)).toHaveCount(1)
    await expect(highlighted(hits(page))).toHaveCount(0)
    await expect(input).not.toHaveAttribute('aria-activedescendant')
    // 结果由空变非空同样不自动高亮
    await input.fill('西溪')
    await tick(page)
    await expect(hits(page)).toHaveCount(0)
    await input.fill('朝阳')
    await tick(page)
    await expect(hits(page).first()).toBeVisible()
    await expect(highlighted(hits(page))).toHaveCount(0)
  })

  test('输入法组字中的回车不选中、不关闭', async ({ page, login }) => {
    await open(page, login)
    const input = search(page)
    await input.fill('朝阳')
    await tick(page)
    await page.keyboard.press('ArrowDown')
    await tick(page)
    await input.evaluate((n) => {
      n.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))
    })
    await tick(page)
    await expect(hits(page).first()).toBeVisible()
    await expect(highlighted(hits(page))).toHaveText(/朝阳壹号院 A栋/)
    await expect(currentName(page)).toHaveText('朝阳壹号院 A栋')
    await expect(page.locator('.toast')).toHaveCount(0)
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
