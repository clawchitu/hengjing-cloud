// 交互断言（不截图）：Button 键盘可用、焦点可见；Table 行悬停色与特殊行底色的优先级、无滚动包裹层。
import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

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
  for (const key of ['Enter', 'Space'] as const) {
    test(`默认按钮：${key} 触发 onClick，焦点可见`, async ({ page, login }) => {
      await open(page, login, '/groups')
      const btn = page.getByRole('button', { name: '编辑', exact: true })
      await expect(btn).toHaveAttribute('data-variant', 'default')
      await tabTo(page, btn)
      await expectFocusVisible(btn)
      await page.keyboard.press(key)
      await expect(page.locator('.toast').filter({ hasText: '编辑：演示环境为只读' })).toBeVisible()
    })

    test(`primary 按钮：${key} 触发 onClick，焦点可见`, async ({ page, login }) => {
      await open(page, login, '/groups')
      const btn = page.getByRole('button', { name: '新建项目', exact: true })
      await expect(btn).toHaveAttribute('data-variant', 'primary')
      await tabTo(page, btn)
      await expectFocusVisible(btn)
      await page.keyboard.press(key)
      await expect(page.locator('.toast').filter({ hasText: '新建项目：演示环境为只读' })).toBeVisible()
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
    await open(page, login, '/groups')
    const btn = page.getByRole('button', { name: '编辑', exact: true })
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
    await open(page, login, '/groups')
    const btn = page.getByRole('button', { name: '新建项目', exact: true })
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

  test('管理员经销商搜索：下拉里只剩命中的经销商；关闭后 body 样式完全恢复', async ({ page, login }) => {
    await login('admin')
    await page.goto('/groups')
    await settle(page)
    await page.getByPlaceholder('搜索经销商名称 / 编码 / 区域').fill('南京')
    await page.clock.runFor(500)
    const trigger = page.getByRole('combobox', { name: '经销商' })
    await expect(trigger).toContainText('南京')
    const childrenBefore = await page.evaluate(() => document.body.children.length)
    await trigger.click()
    await page.clock.runFor(100)
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option')).toHaveText('南京舒适家系统集成有限公司')
    // 打开时 Radix 锁滚动：body 上有 data-scroll-locked 和 pointer-events: none
    expect(await page.evaluate(() => document.body.hasAttribute('data-scroll-locked'))).toBe(true)
    await page.keyboard.press('Escape')
    await page.clock.runFor(100)
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    const body = await page.evaluate(() => ({ style: document.body.getAttribute('style') ?? '', locked: document.body.hasAttribute('data-scroll-locked'), children: document.body.children.length }))
    expect(body).toEqual({ style: '', locked: false, children: childrenBefore })
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

  test('右键、未完成的指针操作不会遗留标记：之后 Tab 进入仍有外圈', async ({ page, login }) => {
    const tabs = await go(page, login, 'PRJ-10252')
    // 右键当前设备（Radix 只对左键聚焦，这里不能打指针标记）
    await tabs.nth(0).click({ button: 'right' })
    await page.keyboard.press('Escape')
    await expect(tabs.nth(0)).not.toHaveAttribute('data-pointer-focus')
    // 右键另一台（非当前、tabindex=-1）设备
    await tabs.nth(2).click({ button: 'right' })
    await page.keyboard.press('Escape')
    await expect(tabs.nth(2)).not.toHaveAttribute('data-pointer-focus')
    // 指针按下后被取消（触屏滚动等）：瞬时标志清掉
    await tabs.nth(0).dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true })
    await tabs.nth(0).dispatchEvent('pointercancel', { pointerType: 'touch', isPrimary: true })
    await tabTo(page, tabs.nth(0))
    expect(await focusVisible(tabs.nth(0))).toBe(true)
    await expect(tabs.nth(0)).not.toHaveAttribute('data-pointer-focus')
    expect(await shadow(tabs.nth(0))).toContain(RING)
  })

  test('脚本 focus()：不打指针标记，外圈与 :focus-visible 一致', async ({ page, login }) => {
    const tabs = await go(page, login, 'PRJ-10252')
    await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
    await page.keyboard.press('Shift')
    await tabs.nth(0).evaluate((n) => (n as HTMLElement).focus())
    await expect(tabs.nth(0)).toBeFocused()
    await expect(tabs.nth(0)).not.toHaveAttribute('data-pointer-focus')
    const fv = await focusVisible(tabs.nth(0))
    expect(fv).toBe(true)
    expect((await shadow(tabs.nth(0))).includes(RING)).toBe(fv)
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
