// 交互断言（不截图）：Button 键盘可用、焦点可见；Table 行悬停色与特殊行底色的优先级、无滚动包裹层。
import type { Locator, Page } from '@playwright/test'
import { expect, expectToast, settle, test } from './fixtures'

const HOVER = 'rgb(250, 252, 254)' // #fafcfe

async function open(page: Page, login: (role: 'dealer') => Promise<void>, path: string) {
  await login('dealer')
  await page.goto(path)
  await settle(page)
}

/** 键盘聚焦后：:focus-visible 命中，且有可见的焦点轮廓（沿用浏览器默认焦点环） */
async function expectFocusVisible(el: Locator) {
  await expect(el).toBeFocused()
  const s = await el.evaluate((n) => {
    const c = getComputedStyle(n)
    return { fv: n.matches(':focus-visible'), style: c.outlineStyle, width: parseFloat(c.outlineWidth) }
  })
  expect(s.fv).toBe(true)
  expect(s.style).not.toBe('none')
  expect(s.width).toBeGreaterThan(0)
}

/** 从页面里一个确定的起点按 Tab，直到目标按钮获得焦点（真实键盘导航，不用 el.focus()） */
async function tabTo(page: Page, el: Locator) {
  await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('Tab')
    if (await el.evaluate((n) => n === document.activeElement)) return
  }
  throw new Error('Tab 没能聚焦到目标按钮')
}

test.describe('Button 键盘', () => {
  // 集成项目页的「编辑」「新建项目」已按改动文档移除（S6b），默认 / primary 按钮改用传感器页「导出」、连接状态页「立即检测」
  for (const key of ['Enter', 'Space'] as const) {
    test(`默认按钮：${key} 触发 onClick，焦点可见`, async ({ page, login }) => {
      await open(page, login, '/sensors')
      const btn = page.getByRole('button', { name: '导出', exact: true })
      await expect(btn).toHaveAttribute('data-variant', 'default')
      await tabTo(page, btn)
      await expectFocusVisible(btn)
      await page.keyboard.press(key)
      await expectToast(page, '已导出：')
    })

    test(`primary 按钮：${key} 触发 onClick，焦点可见`, async ({ page, login }) => {
      await open(page, login, '/connections')
      const btn = page.getByRole('button', { name: '立即检测', exact: true })
      await expect(btn).toHaveAttribute('data-variant', 'primary')
      await tabTo(page, btn)
      await expectFocusVisible(btn)
      await page.keyboard.press(key)
      // 「立即检测」现在是重新读一次连接数据（S11，演示数据有 120ms 模拟延迟），先推进假时钟让读取返回
      await page.clock.runFor(500)
      await expectToast(page, '检测完成')
    })

    test(`link 按钮：${key} 触发 onClick，焦点可见`, async ({ page, login }) => {
      await open(page, login, '/groups')
      const btn = page.getByRole('button', { name: '查看数据' }).first()
      await expect(btn).toHaveAttribute('data-variant', 'link')
      await tabTo(page, btn)
      await expectFocusVisible(btn)
      await page.keyboard.press(key)
      await expect(page).toHaveURL(/\/sensors$/)
    })
  }
})

test.describe('Table', () => {
  test('直接渲染 <table>，没有横向滚动包裹层', async ({ page, login }) => {
    await open(page, login, '/groups')
    const table = page.locator('table[data-slot="table"]').first()
    await expect(table).toBeVisible()
    // 父元素是 Card 本身，不是 shadcn 的 table-container
    expect(await table.evaluate((t) => t.parentElement?.getAttribute('data-slot'))).toBe('card')
    expect(await page.locator('[data-slot="table-container"]').count()).toBe(0)
  })

  test('当前项目行：不悬停是行底色，悬停是 #fafcfe', async ({ page, login }) => {
    await open(page, login, '/groups')
    const row = page.locator('tbody[data-slot="table-body"] > tr').first()
    // 让第一行成为当前项目（与真实点击「查看数据」相同的状态），再回到本页
    await row.getByRole('button', { name: '查看数据' }).click()
    await page.goto('/groups')
    await settle(page)
    const cur = page.locator('tbody[data-slot="table-body"] > tr.cur-row')
    await expect(cur).toHaveCount(1)
    await page.mouse.move(0, 0)
    await expect(cur.locator('td').first()).toHaveCSS('background-color', 'rgb(240, 253, 255)')
    await cur.locator('td').first().hover()
    await expect(cur.locator('td').first()).toHaveCSS('background-color', HOVER)
  })

  test('特殊行底色与悬停色的优先级（cur-row / st-off / st-err / .ptable tr.mod）', async ({ page, login }) => {
    // 用页面上真实渲染的 Table / TableBody / TableRow / TableCell（集成项目的项目列表），只给表格和行加上旧样式类，
    // 这样 data-slot、组件自带的工具类和 global.css / pages.css 的层叠关系都和线上一致
    await open(page, login, '/groups')
    await page.mouse.move(1439, 899)
    const table = page.locator('table[data-slot="table"]').first()
    const rows = table.locator('tbody[data-slot="table-body"] > tr')
    expect(await rows.count()).toBeGreaterThanOrEqual(5)
    const classes = ['', 'st-off', 'st-err', 'mod', 'cur-row'] as const
    await table.evaluate((t, cls) => {
      t.classList.add('ptable')
      const trs = t.querySelectorAll('tbody[data-slot="table-body"] > tr')
      cls.forEach((c, i) => { trs[i].classList.remove('cur-row'); if (c) trs[i].classList.add(c) })
    }, [...classes])
    const cases = [
      ['', 'rgba(0, 0, 0, 0)', HOVER],
      ['st-off', 'rgb(255, 247, 247)', HOVER],
      ['st-err', 'rgb(255, 252, 242)', HOVER],
      ['mod', 'rgb(255, 251, 235)', 'rgb(255, 251, 235)'], // !important 仍压过悬停
      ['cur-row', 'rgb(240, 253, 255)', HOVER],
    ] as const
    for (const [i, [cls, idle, hovered]] of cases.entries()) {
      const td = rows.nth(i).locator('td[data-slot="table-cell"]').first()
      await expect(rows.nth(i)).toHaveClass(cls ? new RegExp(`\\b${cls}\\b`) : /.*/)
      await page.mouse.move(1439, 899)
      await expect(td).toHaveCSS('background-color', idle)
      await td.hover()
      await expect(td).toHaveCSS('background-color', hovered)
    }
  })
})

test.describe('Button 悬停', () => {
  /** 悬停规则不能带 @media (hover: hover)（tailwind.css 的 @custom-variant hover），否则触屏设备上与旧版不一致 */
  async function hoverRuleIsUnconditional(page: Page, selectorPart: string) {
    return page.evaluate((part) => {
      const found: boolean[] = []
      const walk = (rules: CSSRuleList, inMedia: boolean) => {
        for (const r of Array.from(rules)) {
          if (r instanceof CSSStyleRule && r.selectorText.includes(part) && r.selectorText.includes(':hover')) found.push(!inMedia)
          if (r instanceof CSSMediaRule) walk(r.cssRules, inMedia || /hover/.test(r.conditionText))
          else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules, inMedia)
        }
      }
      for (const sh of Array.from(document.styleSheets)) walk(sh.cssRules, false)
      return found
    }, selectorPart)
  }

  test('默认按钮：悬停变 #f8fafc 底、#cbd5e1 边', async ({ page, login }) => {
    await open(page, login, '/sensors')
    const btn = page.getByRole('button', { name: '导出', exact: true })
    await page.mouse.move(0, 0)
    await expect(btn).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(btn).toHaveCSS('border-top-color', 'rgb(231, 236, 242)')
    await btn.hover()
    await expect(btn).toHaveCSS('background-color', 'rgb(248, 250, 252)')
    await expect(btn).toHaveCSS('border-top-color', 'rgb(203, 213, 225)')
    expect(await hoverRuleIsUnconditional(page, 'hover\\:bg-\\[\\#f8fafc\\]')).toEqual([true])
    expect(await hoverRuleIsUnconditional(page, 'hover\\:border-\\[\\#cbd5e1\\]')).toEqual([true])
  })

  test('primary 按钮：悬停变 #0e7490 底', async ({ page, login }) => {
    await open(page, login, '/connections')
    const btn = page.getByRole('button', { name: '立即检测', exact: true })
    await page.mouse.move(0, 0)
    await expect(btn).toHaveCSS('background-color', 'rgb(8, 145, 178)')
    await btn.hover()
    await expect(btn).toHaveCSS('background-color', 'rgb(14, 116, 144)')
    expect(await hoverRuleIsUnconditional(page, 'hover\\:bg-\\[\\#0e7490\\]')).toEqual([true])
  })
})

test.describe('Select（集成项目）', () => {
  test('切到不含当前区域的集成项目后，区域回到「全部区域」，列表不被旧区域过滤', async ({ page, login }) => {
    await open(page, login, '/groups')
    const area = page.getByRole('combobox', { name: '区域' })
    await expect(area).toHaveText('全部区域')
    await area.click()
    await page.clock.runFor(100)
    await page.getByRole('option', { name: '浦东新区' }).click()
    await page.clock.runFor(500)
    await expect(area).toHaveText('浦东新区')
    // 重复点当前集成项目：筛选不变
    await page.locator('.grp-card.on h4').click()
    await page.clock.runFor(500)
    await expect(area).toHaveText('浦东新区')
    // 滨江别墅区的项目都在滨江区
    await page.locator('.grp-card', { hasText: '滨江别墅区' }).locator('h4').click()
    await page.clock.runFor(500)
    await expect(page.locator('.grp-card.on')).toContainText('滨江别墅区')
    await expect(area).toHaveText('全部区域')
    const rows = page.locator('tbody[data-slot="table-body"] > tr')
    await expect(rows).toHaveCount(5)
    await expect(rows.first()).toContainText('滨江别墅')
    // 下拉里只有本集成项目的区域
    await area.click()
    await page.clock.runFor(100)
    await expect(page.getByRole('option')).toHaveText(['全部区域', '滨江区'])
    await page.keyboard.press('Escape')
  })

  test('管理员经销商下拉：搜索后只剩命中的经销商；非模态，不锁页面滚动，关闭后 body 完全恢复', async ({ page, login }) => {
    await login('admin')
    await page.goto('/groups')
    await settle(page)
    const trigger = page.getByRole('button', { name: /^经销商/ })
    const bodyBefore = await page.evaluate(() => ({ style: document.body.getAttribute('style') ?? '', locked: document.body.hasAttribute('data-scroll-locked'), children: document.body.children.length }))
    await trigger.click()
    await page.clock.runFor(100)
    await page.getByRole('combobox', { name: '搜索经销商' }).fill('南京')
    await page.clock.runFor(100)
    const list = page.getByRole('listbox', { name: '经销商' })
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(list.getByRole('option')).toContainText('南京舒适家系统集成有限公司')
    // Popover 非模态（同项目切换菜单）：不锁滚动、不屏蔽页面指针事件
    expect(await page.evaluate(() => document.body.hasAttribute('data-scroll-locked'))).toBe(false)
    await page.keyboard.press('Escape')
    await page.clock.runFor(100)
    await expect(list).toHaveCount(0)
    await expect(trigger).toBeFocused()
    // 只是关闭，没有选：仍是原来的经销商
    await expect(trigger).toContainText('上海恒境暖通')
    const body = await page.evaluate(() => ({ style: document.body.getAttribute('style') ?? '', locked: document.body.hasAttribute('data-scroll-locked'), children: document.body.children.length }))
    expect(body).toEqual(bodyBefore)
  })
})

test.describe('Checkbox', () => {
  const cbColors = (el: Locator) => el.evaluate((n) => {
    const q = (p: string) => n.querySelector(`[data-part="${p}"]`)
    const c = (e: Element | null, prop: 'fill' | 'stroke') => (e ? getComputedStyle(e)[prop] : null)
    return { border: c(q('border'), 'stroke'), borderShown: q('border') ? getComputedStyle(q('border')!).display !== 'none' : false, accent: c(q('accent'), 'fill') }
  })

  test('登录「记住我」：点文字只切换一次；悬停时描边 / 底色变深', async ({ page }) => {
    await page.goto('/login')
    await settle(page)
    const cb = page.getByRole('checkbox', { name: '记住我' })
    await expect(cb).toHaveAttribute('aria-checked', 'true')
    await page.mouse.move(0, 0)
    expect((await cbColors(cb)).accent).toBe('rgb(8, 145, 178)')
    await cb.hover()
    expect((await cbColors(cb)).accent).toBe('rgb(6, 101, 124)')
    await page.getByText('记住我', { exact: true }).click()
    await expect(cb).toHaveAttribute('aria-checked', 'false')
    await page.mouse.move(0, 0)
    expect(await cbColors(cb)).toEqual({ border: 'rgb(118, 118, 118)', borderShown: true, accent: null })
    await cb.hover()
    expect((await cbColors(cb)).border).toBe('rgb(79, 79, 79)')
    await page.getByText('记住我', { exact: true }).click()
    await expect(cb).toHaveAttribute('aria-checked', 'true')
  })

  test('统一控制：「全选在线项目」点文字切换；项目行点击和点复选框都只切换一次；禁用项不响应悬停', async ({ page, login }) => {
    await open(page, login, '/control')
    const all = page.getByRole('checkbox', { name: '全选在线项目' })
    const count = page.locator('.muted', { hasText: '已选' }).first().locator('b')
    await page.getByText('全选在线项目', { exact: true }).click()
    await expect(all).toHaveAttribute('aria-checked', 'true')
    await page.getByText('全选在线项目', { exact: true }).click()
    await expect(all).toHaveAttribute('aria-checked', 'false')
    await expect(count).toHaveText('0')

    const row = page.locator('.pick:not(.dis)').first()
    const cb = row.getByRole('checkbox')
    await row.locator('b').click()
    await expect(cb).toHaveAttribute('aria-checked', 'true')
    await expect(count).toHaveText('1')
    await cb.click()
    await expect(cb).toHaveAttribute('aria-checked', 'false')
    await expect(count).toHaveText('0')

    const dis = page.locator('.pick.dis').first().getByRole('checkbox')
    await expect(dis).toBeDisabled()
    await page.mouse.move(0, 0)
    const idle = await cbColors(dis)
    expect(idle.border).toBe('rgba(118, 118, 118, 0.3)')
    await dis.hover({ force: true })
    expect(await cbColors(dis)).toEqual(idle)
  })
})

test.describe('Tabs（新风设备切换）', () => {
  const RING = 'rgba(6, 182, 212, 0.12)'
  const shadow = (el: Locator) => el.evaluate((n) => getComputedStyle(n).boxShadow)
  const focusVisible = (el: Locator) => el.evaluate((n) => n.matches(':focus-visible'))

  async function go(page: Page, login: (role: 'dealer', project?: string) => Promise<void>, project: string) {
    await login('dealer', project)
    await page.goto('/fresh-air')
    await settle(page)
    return page.getByRole('tablist', { name: '新风设备' }).getByRole('tab')
  }
  /** 从顶栏搜索框开始真实地按 Tab，直到目标获得焦点 */
  async function tabTo(page: Page, el: Locator) {
    await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab')
      if (await el.evaluate((n) => n === document.activeElement)) return
    }
    throw new Error('Tab 没能聚焦到目标')
  }

  test('Tab 键进入时有焦点外圈，鼠标点击不出现，方向键移动外圈跟随', async ({ page, login }) => {
    const tabs = await go(page, login, 'PRJ-10252')
    // 鼠标点击：聚焦但没有外圈
    await tabs.nth(1).click()
    await page.clock.runFor(100)
    await expect(tabs.nth(1)).toBeFocused()
    await expect(tabs.nth(1)).toHaveAttribute('data-pointer-focus', '')
    expect(await shadow(tabs.nth(1))).not.toContain(RING)
    // 从顶栏搜索框按 Tab 走到设备切换：落在当前设备上，:focus-visible 命中且有外圈
    await tabTo(page, tabs.nth(1))
    expect(await focusVisible(tabs.nth(1))).toBe(true)
    await expect(tabs.nth(1)).not.toHaveAttribute('data-pointer-focus')
    expect(await shadow(tabs.nth(1))).toContain(RING)
    await page.keyboard.press('ArrowRight')
    await page.clock.runFor(100)
    await expect(tabs.nth(2)).toBeFocused()
    expect(await shadow(tabs.nth(2))).toContain(RING)
    expect(await shadow(tabs.nth(1))).not.toContain(RING)
    // 鼠标点击后直接按方向键：键盘接管，外圈出现
    await tabs.nth(0).click()
    await page.clock.runFor(100)
    expect(await shadow(tabs.nth(0))).not.toContain(RING)
    await page.keyboard.press('ArrowRight')
    await page.clock.runFor(100)
    await expect(tabs.nth(1)).toBeFocused()
    expect(await shadow(tabs.nth(1))).toContain(RING)
  })

  // 以下用例对应 src/components/ui/tabs.tsx 顶部状态表的每一格「Tab 回来」（以及部分「方向键」）
  const ringed = async (el: Locator) => (await shadow(el)).includes(RING)

  test('状态表·鼠标左键：未聚焦 / 已聚焦无外圈 / 已聚焦有外圈，之后 Tab 回来都有外圈', async ({ page, login }) => {
    const tabs = await go(page, login, 'PRJ-10252')
    // 未聚焦 → 左键
    await tabs.nth(1).click()
    await page.clock.runFor(100)
    await expect(tabs.nth(1)).toBeFocused()
    expect(await ringed(tabs.nth(1))).toBe(false)
    await tabTo(page, tabs.nth(1))
    expect(await ringed(tabs.nth(1))).toBe(true)
    // 已聚焦·无外圈 → 再左键（第三轮评审的复现路径：先离开，左键点进来，再点同一个标签，离开，Tab 回来）
    await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
    await tabs.nth(1).click()
    await page.clock.runFor(100)
    await tabs.nth(1).click()
    await page.clock.runFor(100)
    await expect(tabs.nth(1)).toBeFocused()
    expect(await ringed(tabs.nth(1))).toBe(false)
    await tabTo(page, tabs.nth(1))
    expect(await ringed(tabs.nth(1))).toBe(true)
    // 已聚焦·有外圈（键盘进来的）→ 左键：外圈保持；离开再 Tab 回来仍有
    await tabs.nth(1).click()
    await page.clock.runFor(100)
    expect(await ringed(tabs.nth(1))).toBe(true)
    await tabTo(page, tabs.nth(1))
    expect(await ringed(tabs.nth(1))).toBe(true)
  })

  test('状态表·右键与 Ctrl+左键：未聚焦时不聚焦，已聚焦时不变，之后 Tab 回来都有外圈', async ({ page, login }) => {
    const tabs = await go(page, login, 'PRJ-10252')
    await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
    // 未聚焦的非当前标签：右键、Ctrl+左键都不聚焦、不打标记
    for (const opts of [{ button: 'right' as const }, { modifiers: ['Control' as const] }]) {
      await tabs.nth(2).click(opts)
      await page.keyboard.press('Escape')
      await page.clock.runFor(100)
      await expect(tabs.nth(2)).not.toBeFocused()
      await expect(tabs.nth(2)).not.toHaveAttribute('data-pointer-focus')
    }
    await tabTo(page, tabs.nth(0))
    expect(await ringed(tabs.nth(0))).toBe(true)
    // 已聚焦（鼠标点进来、无外圈）：右键 / Ctrl+左键不改变；离开再 Tab 回来有外圈
    for (const opts of [{ button: 'right' as const }, { modifiers: ['Control' as const] }]) {
      await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
      await tabs.nth(0).click()
      await page.clock.runFor(100)
      await tabs.nth(0).click(opts)
      await page.clock.runFor(100)
      // 这里不按 Esc：任何按键都视为键盘接管（会清标记、显示外圈），见状态表
      expect(await ringed(tabs.nth(0))).toBe(false)
      await tabTo(page, tabs.nth(0))
      expect(await ringed(tabs.nth(0))).toBe(true)
    }
    // 已聚焦（键盘进来、有外圈）：右键不改变
    await tabs.nth(0).click({ button: 'right' })
    await page.keyboard.press('Escape')
    expect(await ringed(tabs.nth(0))).toBe(true)
    // 方向键：右键之后直接按方向键，相邻标签有外圈
    await page.keyboard.press('ArrowRight')
    await page.clock.runFor(100)
    await expect(tabs.nth(1)).toBeFocused()
    expect(await ringed(tabs.nth(1))).toBe(true)
  })

  test('状态表·脚本 focus()：不打指针标记，外圈与 :focus-visible 一致；之后 Tab 回来有外圈', async ({ page, login }) => {
    const tabs = await go(page, login, 'PRJ-10252')
    await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
    await page.keyboard.press('Shift')
    await tabs.nth(0).evaluate((n) => (n as HTMLElement).focus())
    await expect(tabs.nth(0)).toBeFocused()
    await expect(tabs.nth(0)).not.toHaveAttribute('data-pointer-focus')
    const fv = await focusVisible(tabs.nth(0))
    expect(fv).toBe(true)
    expect(await ringed(tabs.nth(0))).toBe(fv)
    await tabTo(page, tabs.nth(0))
    expect(await ringed(tabs.nth(0))).toBe(true)
  })

  test.describe('触屏', () => {
    test.use({ hasTouch: true })

    test('状态表·触屏点按：未聚焦 / 已聚焦（重复点按）/ 按下后取消，之后 Tab 回来都有外圈，方向键有外圈', async ({ page, login }) => {
      const tabs = await go(page, login, 'PRJ-10252')
      // 未聚焦 → 点按：聚焦、无外圈
      await tabs.nth(1).tap()
      await page.clock.runFor(100)
      await expect(tabs.nth(1)).toBeFocused()
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
      expect(await ringed(tabs.nth(1))).toBe(false)
      await tabTo(page, tabs.nth(1))
      expect(await ringed(tabs.nth(1))).toBe(true)
      // 已聚焦 → 重复点按：先离开，点按进来，再点按同一个：无外圈；离开再 Tab 回来有外圈
      await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
      await tabs.nth(1).tap()
      await page.clock.runFor(100)
      await tabs.nth(1).tap()
      await page.clock.runFor(100)
      expect(await ringed(tabs.nth(1))).toBe(false)
      await tabTo(page, tabs.nth(1))
      expect(await ringed(tabs.nth(1))).toBe(true)
      // 按下后取消（滚动等）：之后 Tab 回来有外圈
      await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
      await tabs.nth(1).dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true })
      await tabs.nth(1).dispatchEvent('pointercancel', { pointerType: 'touch', isPrimary: true })
      await tabTo(page, tabs.nth(1))
      expect(await ringed(tabs.nth(1))).toBe(true)
      // 点按后直接方向键：相邻标签有外圈
      await tabs.nth(0).tap()
      await page.clock.runFor(100)
      expect(await ringed(tabs.nth(0))).toBe(false)
      await page.keyboard.press('ArrowRight')
      await page.clock.runFor(100)
      await expect(tabs.nth(1)).toBeFocused()
      expect(await ringed(tabs.nth(1))).toBe(true)
    })
  })

  for (const [project, kind] of [['PRJ-10252', '有运行设置'], ['PRJ-10241', '只读']] as const) {
    test(`面板是 Tab 停留点，键盘聚焦时有焦点环、鼠标点击没有（${kind}）`, async ({ page, login }) => {
      const tabs = await go(page, login, project)
      const panel = page.getByRole('tabpanel')
      await tabTo(page, tabs.nth(0))
      await page.keyboard.press('Tab')
      await expect(panel).toBeFocused()
      expect(await focusVisible(panel)).toBe(true)
      expect(await panel.evaluate((n) => getComputedStyle(n).outlineStyle)).not.toBe('none')
      // 鼠标点面板里的只读文字：焦点落到面板，但不显示焦点环
      await page.mouse.click(5, 5)
      await panel.getByText('实时数据', { exact: false }).first().click()
      await expect(panel).toBeFocused()
      expect(await focusVisible(panel)).toBe(false)
      expect(await panel.evaluate((n) => getComputedStyle(n).outlineStyle)).toBe('none')
    })
  }
})

// S12b 统一控制（演示数据模式：回读与下发只改内存里的演示状态，不发任何请求）
test.describe('统一控制下发', () => {
  const slider = (page: Page) => page.getByRole('slider', { name: '房间温度设定' })
  const shownT = (page: Page) => page.locator('.temp-box .tv b')

  async function expectLocked(page: Page) {
    const s = slider(page)
    await expect(s).toHaveAttribute('data-disabled', '')
    await expect(page.getByRole('button', { name: '降低温度' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '升高温度' })).toBeDisabled()
    const before = await s.getAttribute('aria-valuenow')
    // 滑钮不在 Tab 顺序里；强行聚焦后按键也改不了
    await s.evaluate((n) => (n as HTMLElement).focus())
    for (const k of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'End', 'Home', 'PageUp', 'PageDown', 'Shift+ArrowRight']) await page.keyboard.press(k)
    await expect(s).toHaveAttribute('aria-valuenow', before!)
    // Tab 走一遍整页也不会停在温度区的任何控件上
    await page.locator('input[placeholder*="按项目名称检索"]').focus()
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('.temp-box'))).toBe(false)
    }
  }

  test('「保持不变」时温度区禁用：键盘和 ± 都改不了', async ({ page, login }) => {
    await open(page, login, '/control')
    await expect(page.getByRole('checkbox', { name: '保持不变' })).toHaveAttribute('aria-checked', 'true')
    await expectLocked(page)
    await expect(shownT(page)).toHaveText('26.0°C')
  })

  test('只选新风单机版（app_code 12）：温度设定禁用，键盘改不了；房间开关可用', async ({ page, login }) => {
    await open(page, login, '/control')
    await page.getByRole('checkbox', { name: '保持不变' }).click()
    const search = page.locator('input[placeholder*="按项目名称检索"]')
    await search.fill('地库')
    await page.locator('.pick', { hasText: '地库' }).click()
    await search.fill('')
    for (const n of ['A栋', 'B栋', 'C栋', '会所']) await page.locator('.pick.on', { hasText: n }).click()
    await expect(page.getByText(/该应用类型不支持温度设定/)).toBeVisible()
    await expect(page.getByRole('checkbox', { name: '保持不变' })).toBeDisabled()
    await expectLocked(page)
    await expect(page.getByRole('group', { name: '房间开关' }).getByRole('button', { name: '全部开启' })).toBeEnabled()
  })

  test('二次确认 → 逐个下发 → 结果表（项目、项目ID、状态、操作时间）带回显', async ({ page, login }) => {
    await open(page, login, '/control')
    await page.getByRole('group', { name: '房间开关' }).getByRole('button', { name: '全部开启' }).click()
    await page.getByRole('checkbox', { name: '保持不变' }).click()
    await page.getByRole('button', { name: '升高温度' }).click()
    await page.getByRole('button', { name: '确认下发' }).click()
    await page.clock.runFor(50)
    const dlg = page.getByRole('alertdialog')
    await expect(dlg).toContainText('房间温度26.5°C')
    await expect(dlg).toContainText('朝阳壹号院 A栋（PRJ-10241）')
    await dlg.getByRole('button', { name: '确认下发' }).click()
    await page.clock.runFor(50)
    await expect(page.getByRole('status').filter({ hasText: '正在下发' })).toBeVisible()
    await page.clock.runFor(6000)
    const table = page.locator('table').filter({ hasText: '操作时间' })
    await expect(table.locator('thead th')).toHaveText(['项目', '项目ID', '状态', '操作时间'])
    await expect(table.locator('[data-slot=badge]', { hasText: '成功' })).toHaveCount(4)
    // 结果卡片只有四项；原因与回读在卡片下方默认收起的「下发核对」里
    const toggle = page.getByRole('button', { name: /下发核对/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.unified-notes')).toHaveCount(0)
    await toggle.click()
    await expect(page.locator('.unified-notes')).toContainText('下发后 房间开 · 26.5°C')
    await expectToast(page, '下发成功')
  })
})
