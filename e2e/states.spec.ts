// 由 scripts/shoot.mjs 迁移的页面状态：常用项目数量、顶栏搜索、新风模式、统一控制选择、管理员经销商选择与搜索。
import type { Page } from '@playwright/test'
import { expect, shot, test } from './fixtures'

/** 交互后推进假时钟，让 mock 数据和防抖跑完 */
const tick = (page: Page, ms = 500) => page.clock.runFor(ms)
/** 顶栏项目搜索框 */
const topSearch = (page: Page) => page.getByPlaceholder('搜索项目名称 / 项目ID')
/** 顶栏搜索结果（Popover + Command，选项是 role=option） */
const hitRows = (page: Page) => page.getByRole('listbox', { name: '项目搜索结果' }).getByRole('option')

test.describe('经销商 首页', () => {
  // 常用项目数量：演示数据按本地计数（hjc-mock-select-counts）取前 4 个。「演示计数」开关已去掉（方案 1.2），
  // 这里在页面加载前直接写入计数：0 个、2 个；≥4 个用经销商账号的初始计数（5 个，显示 4 个）
  const COUNTS: Record<string, Record<string, number> | null> = { '0': {}, '2': { 'PRJ-10241': 6, 'PRJ-10252': 2 }, '4+': null }
  for (const [v, tag] of [['0', '0'], ['2', '2'], ['4+', '4plus']] as const) {
    test(`常用项目 ${v}`, async ({ page, login }) => {
      await login('dealer')
      const counts = COUNTS[v]
      if (counts) await page.addInitScript((c) => localStorage.setItem('hjc-mock-select-counts', JSON.stringify({ cosyhome: c })), counts)
      await page.goto('/home')
      await tick(page, 1500)
      if (v === '0') await expect(page.getByText('暂无常用项目')).toBeVisible()
      await expect(page.locator('.proj-card')).toHaveCount(v === '0' ? 0 : v === '2' ? 2 : 4)
      await expect(page.getByText('演示计数')).toHaveCount(0)
      await shot(page, `dealer-home-fav-${tag}`)
    })
  }

  test('顶栏搜索只在本经销商范围内', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await tick(page, 1500)
    await topSearch(page).fill('西溪')
    await tick(page)
    await expect(page.getByText('未找到匹配的项目（仅搜索您可见的集成项目内的项目）')).toBeVisible()
    await shot(page, 'dealer-search-empty')
    await topSearch(page).fill('地库')
    await tick(page)
    await expect(hitRows(page).first()).toBeVisible()
    await shot(page, 'dealer-search-hit')
    await hitRows(page).first().click()
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

  // 改动文档第 5 条：app_code 12（新风单机版）只禁用房间温度设定，房间开关仍在。截图名沿用 control-mixed / control-norooms
  test('混合选择（含新风单机版）与只选新风单机版：温度设定禁用、房间开关仍可用', async ({ page, login }) => {
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
    await expect(page.locator('.sec-h', { hasText: '房间开关' })).toHaveCount(1)
    await expect(page.getByText(/该应用类型不支持温度设定/)).toBeVisible()
    await expect(page.getByRole('slider', { name: '房间温度设定' })).toHaveAttribute('data-disabled', '')
    await shot(page, 'control-norooms')
  })
})

test.describe('管理员 集成项目', () => {
  // 经销商选择是可搜索下拉（Popover + Command，S6b）：触发器是按钮，弹层里是搜索框和经销商列表（选项的 data-value 是经销商编号）
  const dealerTrigger = (page: Page) => page.getByRole('button', { name: /^经销商/ })
  const dealerList = (page: Page) => page.getByRole('listbox', { name: '经销商' })
  const dealerSearch = (page: Page) => page.getByRole('combobox', { name: '搜索经销商' })

  test('逐个切换经销商', async ({ page, login }) => {
    await login('admin')
    await page.goto('/groups')
    await tick(page, 1500)
    await dealerTrigger(page).click()
    await tick(page, 100)
    const opts = await dealerList(page).getByRole('option').evaluateAll((o) => o.map((x) => x.getAttribute('data-value') ?? ''))
    await page.keyboard.press('Escape')
    await tick(page, 100)
    expect(opts).toEqual(['DLR-001', 'DLR-002', 'DLR-003'])
    for (const d of opts) {
      await dealerTrigger(page).click()
      await tick(page, 100)
      await dealerList(page).locator(`[role=option][data-value="${d}"]`).click()
      await tick(page)
      await expect(dealerList(page)).toHaveCount(0)
      await page.mouse.move(0, 0)
      await shot(page, `admin-groups-${d}`)
    }
  })

  test('经销商下拉：展开、搜索命中与空态', async ({ page, login }) => {
    await login('admin')
    await page.goto('/groups')
    await tick(page, 1500)
    await dealerTrigger(page).click()
    await tick(page)
    // 打开时焦点在搜索框，高亮当前经销商
    await expect(dealerSearch(page)).toBeFocused()
    await expect(dealerList(page).getByRole('option')).toHaveCount(3)
    await expect(dealerList(page).locator('[aria-selected="true"]')).toHaveText(/上海恒境暖通/)
    await page.mouse.move(0, 0)
    await shot(page, 'admin-groups-dealer-open')
    await dealerSearch(page).fill('南京')
    await tick(page)
    await expect(dealerList(page).getByRole('option')).toHaveText(['南京舒适家系统集成有限公司江苏'])
    await shot(page, 'admin-groups-dealer-search')
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(dealerList(page)).toHaveCount(0)
    await expect(dealerTrigger(page)).toContainText('南京')
    await expect(page.getByText('河西府住宅组').first()).toBeVisible()
    await dealerTrigger(page).click()
    await tick(page)
    await dealerSearch(page).fill('zzz')
    await tick(page)
    await expect(dealerList(page).getByRole('option')).toHaveCount(0)
    await expect(page.getByText('未找到匹配的经销商')).toBeVisible()
    await shot(page, 'admin-groups-dealer-search-empty')
    // 没有命中时回车不改选择；Esc 关闭
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(dealerList(page)).toHaveCount(0)
    await expect(dealerTrigger(page)).toContainText('南京')
    await expect(page.locator('.grp-card').first()).toContainText('河西府住宅组')
  })

  test('顶栏搜索可见所有经销商的项目', async ({ page, login }) => {
    await login('admin')
    await page.goto('/home')
    await tick(page, 1500)
    await topSearch(page).fill('西溪')
    await tick(page)
    await expect(hitRows(page).first()).toBeVisible()
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
