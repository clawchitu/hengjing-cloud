// 由 scripts/shoot.mjs 迁移的页面状态：常用项目数量、顶栏搜索、新风模式、统一控制选择、管理员经销商选择与搜索。
import type { Page } from '@playwright/test'
import { expect, shot, test } from './fixtures'

/** 交互后推进假时钟，让 mock 数据和防抖跑完 */
const tick = (page: Page, ms = 500) => page.clock.runFor(ms)
/** 顶栏项目搜索框 */
const topSearch = (page: Page) => page.getByPlaceholder('搜索项目名称 / 项目ID')

test.describe('经销商 首页', () => {
  for (const [v, tag] of [['0', '0'], ['2', '2'], ['4+', '4plus']] as const) {
    test(`常用项目 ${v}`, async ({ page, login }) => {
      await login('dealer')
      await page.goto('/home')
      await tick(page, 1500)
      await page.locator('.demo-seg').getByRole('button', { name: v, exact: true }).click()
      await tick(page)
      if (v === '0') await expect(page.getByText('暂无常用项目')).toBeVisible()
      await shot(page, `dealer-home-fav-${tag}`)
    })
  }

  test('顶栏搜索只在本经销商范围内', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await tick(page, 1500)
    await topSearch(page).fill('西溪')
    await tick(page)
    await expect(page.locator('.sp-empty')).toBeVisible()
    await shot(page, 'dealer-search-empty')
    await topSearch(page).fill('地库')
    await tick(page)
    await expect(page.locator('.sp-row').first()).toBeVisible()
    await shot(page, 'dealer-search-hit')
    await page.locator('.sp-row').first().click()
    await tick(page)
    await expect(page.locator('.proj-switch .name')).toContainText('地库')
  })
})

test.describe('新风单机版 运行模式', () => {
  // PRJ-10252 的 5 台设备分别是模式 2 / 13 / 23 / 33 / 5（模式 5 仅湿度控制）
  const MODES = [2, 13, 23, 33, 5]
  for (const [i, m] of MODES.entries()) {
    test(`模式 ${m}`, async ({ page, login }) => {
      await login('dealer', 'PRJ-10252')
      await page.goto('/fresh-air')
      await tick(page, 1500)
      await page.locator('.dev-tab').nth(i).click()
      await tick(page)
      await expect(page.getByText('运行设置')).toBeVisible()
      if (m === 5) {
        // 仅湿度：控制类型锁定为湿度，露点设定值未启用
        await expect(page.locator('.ctl-type button', { hasText: '露点控制' })).toBeDisabled()
        await expect(page.locator('.setbox.dis', { hasText: '露点设定值' }).getByText('未启用')).toBeVisible()
        await expect(page.locator('.setbox.on', { hasText: '湿度设定值' })).toBeVisible()
      } else if (m === 2) {
        await expect(page.locator('.ctl-type button', { hasText: '露点控制' })).toBeEnabled()
      }
      await shot(page, `standalone12-fa-mode${m}`)
      if (m === 5) {
        // 仅湿度模式下湿度设定值可调：点加号后 50 → 51
        await page.locator('.setbox.on button.plus').click()
        await expect(page.locator('.setbox.on .sv')).toHaveText(/^51/)
      }
    })
  }

  for (const id of ['PRJ-10241', 'PRJ-10242', 'PRJ-30058', 'PRJ-20117']) {
    test(`非 12 项目 ${id} 没有运行设置`, async ({ page, login }) => {
      await login('dealer', id)
      await page.goto('/fresh-air')
      await tick(page, 1500)
      await expect(page.locator('h1').first()).toBeVisible()
      await expect(page.getByText('运行设置')).toHaveCount(0)
      await expect(page.locator('.fa-top.wide')).toHaveCount(1)
    })
  }
})

test.describe('统一控制', () => {
  const search = 'input[placeholder*="按项目名称检索"]'

  test('混合选择（含新风单机版）与无房间布局', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/control')
    await tick(page, 1500)
    await page.locator(search).fill('地库')
    await tick(page)
    await page.locator('.pick', { hasText: '地库' }).click()
    await page.locator(search).fill('')
    await tick(page)
    await shot(page, 'control-mixed')
    for (const n of ['A栋', 'B栋', 'C栋', '会所']) await page.locator('.pick.on', { hasText: n }).click()
    await tick(page)
    await expect(page.locator('.sec-h', { hasText: '房间开关' })).toHaveCount(0)
    await shot(page, 'control-norooms')
  })
})

test.describe('管理员 集成项目', () => {
  test('逐个切换经销商', async ({ page, login }) => {
    await login('admin')
    await page.goto('/groups')
    await tick(page, 1500)
    // 经销商下拉是 Radix Select：展开后读出全部选项，再逐个点选（选项上的 data-value 是经销商编码）
    const trigger = page.getByRole('combobox', { name: '经销商' })
    await trigger.click()
    await tick(page, 100)
    const opts = await page.getByRole('option').evaluateAll((o) => o.map((x) => x.getAttribute('data-value') ?? ''))
    await page.keyboard.press('Escape')
    await tick(page, 100)
    expect(opts.length).toBeGreaterThanOrEqual(2)
    for (const d of opts) {
      await trigger.click()
      await tick(page, 100)
      await page.locator(`[role=option][data-value="${d}"]`).click()
      await tick(page)
      await expect(page.getByRole('listbox')).toHaveCount(0)
      await shot(page, `admin-groups-${d}`)
    }
  })

  test('经销商搜索：命中与空态', async ({ page, login }) => {
    await login('admin')
    await page.goto('/groups')
    await tick(page, 1500)
    const q = page.getByPlaceholder('搜索经销商名称 / 编码 / 区域')
    await q.fill('南京')
    await tick(page)
    // 下拉里只剩一个经销商
    await page.getByRole('combobox', { name: '经销商' }).click()
    await tick(page, 100)
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await tick(page, 100)
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(page.getByText('河西府住宅组').first()).toBeVisible()
    await shot(page, 'admin-groups-dealer-search')
    await q.fill('杭州')
    await tick(page)
    await expect(page.getByText('西溪蝶园别墅组').first()).toBeVisible()
    await q.fill('zzz')
    await tick(page)
    await expect(page.getByText('匹配 0 / 3')).toBeVisible()
    await expect(page.getByText('没有与「zzz」匹配的经销商')).toBeVisible()
    await expect(page.locator('.grp-card')).toHaveCount(0)
    await shot(page, 'admin-groups-dealer-search-empty')
    await q.fill('')
    await tick(page)
    await expect(page.locator('.grp-card').first()).toBeVisible()
  })

  test('顶栏搜索可见所有经销商的项目', async ({ page, login }) => {
    await login('admin')
    await page.goto('/home')
    await tick(page, 1500)
    await topSearch(page).fill('西溪')
    await tick(page)
    await expect(page.locator('.sp-row').first()).toBeVisible()
    await shot(page, 'admin-search-hit')
  })
})

test('连接状态页没有网络拓扑', async ({ page, login }) => {
  await login('dealer', 'PRJ-10241')
  await page.goto('/connections')
  await tick(page, 1500)
  await expect(page.locator('h1').first()).toBeVisible()
  await expect(page.getByText('网络拓扑')).toHaveCount(0)
})
