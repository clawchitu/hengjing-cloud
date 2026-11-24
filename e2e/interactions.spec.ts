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
  await page.locator('.search input').focus()
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
    await open(page, login, '/groups')
    // 用页面上已加载的 global.css + pages.css，插一张与 shadcn Table 同结构的表
    await page.evaluate(() => {
      const box = document.createElement('div')
      box.id = 'probe'
      box.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#fff'
      box.innerHTML = `<table data-slot="table" class="ptable"><tbody data-slot="table-body">
        ${['plain', 'cur-row', 'st-off', 'st-err', 'mod'].map((c) => `<tr class="${c}"><td data-slot="table-cell" style="height:40px">${c}</td></tr>`).join('')}
      </tbody></table>`
      document.body.prepend(box)
    })
    const cases = [
      ['plain', 'rgba(0, 0, 0, 0)', HOVER],
      ['cur-row', 'rgb(240, 253, 255)', HOVER],
      ['st-off', 'rgb(255, 247, 247)', HOVER],
      ['st-err', 'rgb(255, 252, 242)', HOVER],
      ['mod', 'rgb(255, 251, 235)', 'rgb(255, 251, 235)'], // !important 仍压过悬停
    ] as const
    for (const [cls, idle, hovered] of cases) {
      const td = page.locator(`#probe tr.${cls} > td`)
      await page.mouse.move(1439, 899)
      await expect(td).toHaveCSS('background-color', idle)
      await td.hover()
      await expect(td).toHaveCSS('background-color', hovered)
    }
  })
})
