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
    expect(await rows.count()).toBeGreaterThanOrEqual(4)
    const classes = ['', 'st-off', 'st-err', 'mod'] as const
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
