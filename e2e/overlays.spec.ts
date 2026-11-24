// 弹层打开态（S3-0 在旧代码上补录，作为 S3 替换的比对基线）：确认弹窗、toast、项目切换菜单、
// 顶栏搜索命中满 8 条（截断上限）。
// 顶栏搜索有结果 / 无结果、管理员经销商搜索已在 states.spec.ts 里有截图，这里不重复。
// 每个弹层状态一个独立用例，截完即结束，不在同一页面上接着截别的状态。
// 确认弹窗只打开、截图，绝不点「确认」。
// 截可视区（1440×900）而不是整页：弹层是 fixed 定位，整页截图里遮罩只盖住首屏，
// 而且 S3 换成 Radix 后弹窗打开会锁 body 滚动，整页高度会变，可视区截图前后才可比。
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

/** 交互后推进假时钟，让 mock 数据和防抖跑完 */
const tick = (page: Page, ms = 500) => page.clock.runFor(ms)

/** 同 fixtures 的 shot()，但只截可视区；settle 为 false 时不推进时钟（toast 会在 2.6 秒后消失） */
async function shotView(page: Page, name: string, opts: { settle?: boolean } = {}) {
  if (opts.settle !== false) await settle(page)
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('h1').first()).toBeVisible()
  // 可视区截图的前提：没有占宽的竖向滚动条、页面停在顶部（不靠无头模式隐藏滚动条默认成立）
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(1440)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await expect.soft(page).toHaveScreenshot(`${name}.png`)
}

const dialog = (page: Page, title: string) => page.locator('.modal').filter({ has: page.getByRole('heading', { name: title }) })

test.describe('确认弹窗', () => {
  test('退出登录', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await tick(page, 1500)
    await page.locator('.sidebar').getByText('退出登录', { exact: true }).click()
    await tick(page)
    const dlg = dialog(page, '退出登录')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByText('确定要退出恒境云平台吗？')).toBeVisible()
    await expect(dlg.getByRole('button', { name: '退出' })).toBeVisible()
    await shotView(page, 'confirm-logout')
  })

  test('统一控制下发确认', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/control')
    await tick(page, 1500)
    await page.getByRole('button', { name: '确认下发' }).click()
    await tick(page)
    const dlg = dialog(page, '确认下发统一控制指令')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByText('运行模式')).toBeVisible()
    await expect(dlg.getByRole('button', { name: '确认下发' })).toBeVisible()
    await shotView(page, 'confirm-control-send')
  })

  test('新风下发确认', async ({ page, login }) => {
    await login('dealer', 'PRJ-10252')
    await page.goto('/fresh-air')
    await tick(page, 1500)
    await page.getByRole('button', { name: '下发设置' }).click()
    await tick(page)
    const dlg = dialog(page, '确认下发设置')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByText('控制类型')).toBeVisible()
    await expect(dlg.getByRole('button', { name: '确认下发' })).toBeVisible()
    await shotView(page, 'confirm-fresh-air-send')
  })

  test('温控全部开启确认', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/thermostat')
    await tick(page, 1500)
    await page.getByRole('button', { name: '全部开启' }).click()
    await tick(page)
    const dlg = dialog(page, '全部开启')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByRole('button', { name: '确认下发' })).toBeVisible()
    await shotView(page, 'confirm-thermostat-all-on')
  })

  // 与「全部开启」同一个 confirm() 调用点，只是文案和指令值不同：只断言文案，不另录基线
  test('温控全部关闭确认文案', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/thermostat')
    await tick(page, 1500)
    await page.getByRole('button', { name: '全部关闭' }).click()
    await tick(page)
    const dlg = dialog(page, '全部关闭')
    await expect(dlg).toBeVisible()
    await expect(dlg).toContainText('将向 朝阳壹号院 A栋 的 6 个温控面板下发「关闭」指令，确定继续？')
    await expect(dlg.getByRole('button', { name: '取消' })).toBeVisible()
    await expect(dlg.getByRole('button', { name: '确认下发' })).toBeVisible()
  })
})

test.describe('toast', () => {
  // toast 2.6 秒后自动消失，而 settle() 会推进 3 秒时钟，所以先把页面跑稳，
  // 再触发 toast，只推进 300ms 就截图。
  test('成功', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    // 首屏顶部的城市按钮：不会把页面滚动走，也没有副作用
    await page.getByRole('button', { name: '上海市 · 浦东新区' }).click()
    await tick(page, 300)
    const t = page.locator('.toast').filter({ hasText: '演示环境仅提供上海市浦东新区天气' })
    await expect(t).toBeVisible()
    await expect(t).not.toHaveClass(/err/)
    await shotView(page, 'toast-success', { settle: false })
  })

  test('两条同时显示', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    const city = page.getByRole('button', { name: '上海市 · 浦东新区' })
    await city.click()
    await tick(page, 100)
    await city.click()
    await tick(page, 300)
    const t = page.locator('.toast').filter({ hasText: '演示环境仅提供上海市浦东新区天气' })
    await expect(t).toHaveCount(2)
    await shotView(page, 'toast-stack', { settle: false })
  })

  test('失败', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/groups')
    await settle(page)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await tick(page, 300)
    const t = page.locator('.toast').filter({ hasText: '编辑：演示环境为只读' })
    await expect(t).toBeVisible()
    await expect(t).toHaveClass(/err/)
    await shotView(page, 'toast-error', { settle: false })
  })
})

test.describe('项目切换菜单展开', () => {
  for (const role of ['dealer', 'admin'] as const) {
    test(role === 'dealer' ? '经销商' : '管理员（按经销商分组）', async ({ page, login }) => {
      await login(role)
      await page.goto('/home')
      await tick(page, 1500)
      await page.getByText('当前项目', { exact: true }).click()
      await tick(page)
      const menu = page.locator('.proj-menu')
      await expect(menu).toBeVisible()
      await expect(menu.locator('.opt.cur')).toHaveCount(1)
      if (role === 'admin') await expect(menu.locator('.dlr').first()).toBeVisible()
      await shotView(page, `${role}-project-menu`)
    })
  }

  // 当前项目在菜单很靠后（第 3 个经销商）：锁定旧版「打开时停在菜单顶部、不滚到当前项」的行为
  test('管理员：当前项目不在菜单首屏', async ({ page, login }) => {
    await login('admin', 'PRJ-60012')
    await page.goto('/home')
    await tick(page, 1500)
    await page.getByText('当前项目', { exact: true }).click()
    await tick(page)
    const menu = page.locator('.proj-menu')
    await expect(menu).toBeVisible()
    const cur = menu.locator('.opt.cur')
    await expect(cur).toHaveCount(1)
    await expect(cur).toContainText('河西府 2栋')
    await expect(cur).not.toBeInViewport()
    expect(await menu.evaluate((m) => m.scrollTop)).toBe(0)
    await shotView(page, 'admin-project-menu-cur-below')
  })
})

test.describe('顶栏搜索', () => {
  // 「朝阳壹号院」在经销商范围内命中 12 个项目（A–K 栋、会所、地库新风），列表截断为 8 条
  test('命中满 8 条（截断上限）', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await tick(page, 1500)
    await page.locator('.search input').fill('朝阳壹号院')
    await tick(page)
    await expect(page.locator('.sp-row')).toHaveCount(8)
    await shotView(page, 'dealer-search-hit-8')
  })
})
