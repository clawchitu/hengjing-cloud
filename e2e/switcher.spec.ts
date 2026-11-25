// 侧栏「当前项目」切换器（负责人 11/25 确认的方案）：从真实点击入口走 打开 → 搜索 → 选中 → 当前项目变化。
// 覆盖去重、置顶、最近使用、离线、空结果、限高与底部固定链接；经销商、平台两种账号都测。
// 演示数据之外再注入 300 个项目（window.__HJC_MOCK_ORG_EXTRA__，见 src/data/org/sources.ts withMockExtra）：
// - 「批量园区」集成项目（经销商 DLR-001）：300 个项目，每 10 个有 1 个离线；
// - 「批量园区」里的 BULK-007 同时属于杭州暖居（DLR-002）的集成项目和一个平台集成项目（去重：只出现一次）；
// - 杭州暖居另有 1 个项目 HZ-ONLY（经销商账号看不到）。
// 只做行为断言；打开态外观由 overlays.spec.ts 的基线锁定。
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const tick = (page: Page, ms = 100) => page.clock.runFor(ms)

const N = 300
const pad = (i: number) => String(i).padStart(3, '0')
const bulkId = (i: number) => `BULK-${pad(i)}`
const bulkName = (i: number) => `批量园区 ${pad(i)}号`

function extra() {
  const proj = (id: string, name: string, groupId: string, online: boolean) =>
    ({ id, code: id, name, groupId, city: '上海', district: '浦东新区', kind: '三恒住宅', online, version: 'v3.6.2', devices: 1, programCode: 1 })
  const g = (id: string, dealerId: string, name: string, projectIds: string[]) =>
    ({ id, code: id, dealerId, name, type: '三恒住宅', typeColor: 'cyan', desc: '', created: '2025-01-01 00:00', projectIds })
  const ids = Array.from({ length: N }, (_, k) => bulkId(k + 1))
  return {
    dealers: [{ id: 'virtual:platform', name: '平台', short: '平台', region: '' }],
    groups: [
      g('GRP-BULK', 'DLR-001', '批量园区', ids),
      g('GRP-BULK-HZ', 'DLR-002', '杭州合作园区', [bulkId(7), 'HZ-ONLY']),
      g('GRP-BULK-PF', 'virtual:platform', '平台直营', [bulkId(7)]),
    ],
    projects: [
      ...ids.map((id, k) => proj(id, bulkName(k + 1), 'GRP-BULK', (k + 1) % 10 !== 0)),
      proj('HZ-ONLY', '杭州独有项目', 'GRP-BULK-HZ', true),
    ],
  }
}

type Role = 'dealer' | 'admin'
async function open(page: Page, login: (role: Role, project?: string) => Promise<void>, role: Role, project?: string) {
  await page.addInitScript((x) => { (globalThis as Record<string, unknown>).__HJC_MOCK_ORG_EXTRA__ = x }, extra())
  await login(role, project)
  await page.goto('/home')
  await tick(page, 1500)
}

const trigger = (page: Page) => page.locator('.proj-switch')
const currentName = (page: Page) => page.locator('.proj-switch .name')
const menu = (page: Page) => page.getByRole('dialog', { name: '切换当前项目' })
const input = (page: Page) => page.getByRole('combobox', { name: '搜索要切换的项目' })
const list = (page: Page) => page.getByRole('listbox', { name: '切换当前项目' })
const options = (page: Page) => list(page).getByRole('option')
const section = (page: Page, label: string) => list(page).getByRole('group', { name: label })
const optionNames = (page: Page) => options(page).evaluateAll((els) => els.map((e) => (e.querySelector('.truncate')?.textContent ?? '').trim()))
const star = (page: Page, name: string) => options(page).filter({ hasText: name }).getByRole('button', { name: new RegExp(`置顶「${name}」`) })

async function openMenu(page: Page) {
  await trigger(page).click()
  await tick(page)
  await expect(menu(page)).toBeVisible()
}
async function pickBySearch(page: Page, q: string, name: string) {
  await openMenu(page)
  await input(page).fill(q)
  await tick(page)
  await options(page).filter({ hasText: name }).first().click()
  await tick(page)
  await expect(menu(page)).toHaveCount(0)
  await expect(currentName(page)).toHaveText(name)
}

test.describe('经销商账号', () => {
  test('打开即聚焦搜索框；默认列出自己的全部项目，不分组，限高可滚动，底部链接固定', async ({ page, login }) => {
    await open(page, login, 'dealer')
    await openMenu(page)
    await expect(input(page)).toBeFocused()
    // 没有最近、置顶时只有「全部项目」一段；没有经销商 / 集成项目分组标题
    await expect(list(page).getByRole('group')).toHaveCount(1)
    await expect(section(page, '全部项目')).toBeVisible()
    await expect(menu(page).getByText('朝阳壹号院住宅组')).toHaveCount(0)
    // 演示数据 33 个 + 批量 300 个，按 id 去重（BULK-007 只出现一次），看不到杭州暖居的项目
    const names = await optionNames(page)
    expect(names).toHaveLength(28 + N)
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((n) => n === bulkName(7))).toHaveLength(1)
    expect(names).not.toContain('杭州独有项目')
    expect(names).not.toContain('西溪蝶园 3号')
    // 限高：弹层在视口内，列表自己滚，底部「查看全部项目 →」不跟着滚
    const box = (await menu(page).boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(900)
    expect(box.height).toBeLessThanOrEqual(480)
    const footer = menu(page).getByRole('link', { name: '查看全部项目 →' })
    await expect(footer).toBeInViewport({ ratio: 1 })
    const before = (await footer.boundingBox())!.y
    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await tick(page)
    await expect(options(page).last()).toBeInViewport({ ratio: 1 })
    await expect(footer).toBeInViewport({ ratio: 1 })
    expect((await footer.boundingBox())!.y).toBe(before)
    await expect(input(page)).toBeInViewport({ ratio: 1 })
    // 点「查看全部项目 →」去集成项目页
    await footer.click()
    await tick(page)
    await expect(page).toHaveURL(/\/groups$/)
    await expect(menu(page)).toHaveCount(0)
  })

  test('打开 → 搜索 → 选中 → 当前项目变化；按名称、ID、经销商名都能搜，界面不显示 ID', async ({ page, login }) => {
    await open(page, login, 'dealer')
    await openMenu(page)
    // 按名称
    await input(page).fill('批量园区 15')
    await tick(page)
    expect(await optionNames(page)).toEqual(Array.from({ length: 10 }, (_, k) => bulkName(150 + k)))
    // 按 ID（code）：能搜到，但列表里不出现 ID
    await input(page).fill('BULK-123')
    await tick(page)
    expect(await optionNames(page)).toEqual([bulkName(123)])
    await expect(list(page)).not.toContainText('BULK-123')
    // 按经销商名（全称 / 简称）：自己的项目都能命中
    await input(page).fill('上海恒境暖通')
    await tick(page)
    await expect(options(page)).toHaveCount(28 + N)
    // 搜索结果的副标题是经销商名
    await input(page).fill('BULK-200')
    await tick(page)
    await expect(options(page).first()).toContainText('上海恒境暖通')
    // 回车选第一条命中（输入时高亮第一条），当前项目变化
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(menu(page)).toHaveCount(0)
    await expect(currentName(page)).toHaveText(bulkName(200))
    await expect(trigger(page)).not.toContainText('BULK-200')
    // 鼠标点选同样切换
    await pickBySearch(page, '朝阳壹号院 C', '朝阳壹号院 C栋')
  })

  test('最近使用：切换项目时按账号更新，最多 5 个，排在全部项目前且不重复；刷新后还在', async ({ page, login }) => {
    await open(page, login, 'dealer')
    for (const i of [11, 12, 13, 14, 15, 16]) await pickBySearch(page, bulkId(i), bulkName(i))
    await openMenu(page)
    await expect(section(page, '最近使用')).toBeVisible()
    // 最新的在最前，只留 5 个
    expect(await section(page, '最近使用').getByRole('option').evaluateAll((els) => els.map((e) => (e.querySelector('.truncate')?.textContent ?? '').trim())))
      .toEqual([16, 15, 14, 13, 12].map(bulkName))
    // 最近使用里的项目不会在「全部项目」里再出现一次
    const names = await optionNames(page)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toHaveLength(28 + N)
    await page.keyboard.press('Escape')
    await tick(page)
    // 存在 localStorage，按账号区分
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hjc-recent-projects:')))
    expect(keys).toHaveLength(1)
    await page.reload()
    await tick(page, 1500)
    await openMenu(page)
    await expect(section(page, '最近使用').getByRole('option').first()).toContainText(bulkName(16))
  })

  test('星标置顶：点星标不切换项目、不关菜单；下次打开排在最前；再点取消；按账号存 localStorage', async ({ page, login }) => {
    await open(page, login, 'dealer')
    await openMenu(page)
    await input(page).fill(bulkId(250))
    await tick(page)
    await star(page, bulkName(250)).click()
    await tick(page)
    await expect(menu(page)).toBeVisible()
    await expect(input(page)).toBeFocused()
    await expect(currentName(page)).toHaveText('朝阳壹号院 A栋')
    await expect(star(page, bulkName(250))).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await tick(page)
    await openMenu(page)
    await expect(list(page).getByRole('group').first()).toHaveAttribute('aria-label', '已置顶')
    await expect(section(page, '已置顶').getByRole('option')).toHaveText([new RegExp(bulkName(250))])
    const names = await optionNames(page)
    expect(names.filter((n) => n === bulkName(250))).toHaveLength(1)
    // 开着菜单取消置顶：行不跳动（下次打开才变）
    await star(page, bulkName(250)).click()
    await tick(page)
    await expect(section(page, '已置顶').getByRole('option')).toHaveCount(1)
    await expect(star(page, bulkName(250))).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Escape')
    await tick(page)
    await openMenu(page)
    await expect(section(page, '已置顶')).toHaveCount(0)
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hjc-pinned-projects:')))).toHaveLength(1)
  })

  test('离线项目照常显示、照常排序，前面灰点加「离线」，可以切换', async ({ page, login }) => {
    await open(page, login, 'dealer')
    await openMenu(page)
    await input(page).fill('批量园区 0')
    await tick(page)
    // 001–099：010 离线，仍在 009 和 011 之间
    const names = await optionNames(page)
    expect(names.indexOf(bulkName(10))).toBe(names.indexOf(bulkName(9)) + 1)
    const row = options(page).filter({ hasText: bulkName(10) })
    await expect(row).toContainText('离线')
    await expect(options(page).filter({ hasText: bulkName(9) })).not.toContainText('离线')
    // 不置灰：名称颜色与在线行一致
    const color = (n: string) => options(page).filter({ hasText: n }).locator('span.truncate').evaluate((e) => getComputedStyle(e).color)
    expect(await color(bulkName(10))).toBe(await color(bulkName(9)))
    await expect(row).not.toHaveAttribute('aria-disabled', 'true')
    await row.click()
    await tick(page)
    await expect(currentName(page)).toHaveText(bulkName(10))
    await expect(trigger(page)).toContainText('离线')
  })

  test('搜不到：提示、去集成项目页搜索（带关键词）、只显示你名下的项目', async ({ page, login }) => {
    await open(page, login, 'dealer')
    await openMenu(page)
    // 别家经销商的项目搜不到
    await input(page).fill('杭州独有')
    await tick(page)
    await expect(options(page)).toHaveCount(0)
    await expect(menu(page).getByText('没有匹配“杭州独有”的项目')).toBeVisible()
    await expect(menu(page).getByText('只显示你名下的项目')).toBeVisible()
    await menu(page).getByRole('link', { name: '去集成项目页搜索 →' }).click()
    await tick(page)
    await expect(page).toHaveURL(/\/groups\?q=%E6%9D%AD%E5%B7%9E%E7%8B%AC%E6%9C%89$/)
    await expect(page.getByPlaceholder('项目名称 / ID')).toHaveValue('杭州独有')
  })
})

test.describe('平台账号', () => {
  test('默认只列最近使用和已置顶，不列全量；副标题是经销商名，没有分组标题', async ({ page, login }) => {
    await open(page, login, 'admin')
    await openMenu(page)
    await expect(input(page)).toBeFocused()
    await expect(options(page)).toHaveCount(0)
    await expect(menu(page).getByText('输入项目名称、项目 ID 或经销商名搜索；点星标可置顶常用项目')).toBeVisible()
    await expect(menu(page).getByRole('link', { name: '查看全部项目 →' })).toBeVisible()
    await page.keyboard.press('Escape')
    await tick(page)
    await pickBySearch(page, '河西府 2', '河西府 2栋')
    await pickBySearch(page, bulkId(42), bulkName(42))
    await openMenu(page)
    await input(page).fill('西溪蝶园 7')
    await tick(page)
    await star(page, '西溪蝶园 7号').click()
    await tick(page)
    await page.keyboard.press('Escape')
    await tick(page)
    await openMenu(page)
    expect(await list(page).getByRole('group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['已置顶', '最近使用'])
    expect(await optionNames(page)).toEqual(['西溪蝶园 7号', bulkName(42), '河西府 2栋'])
    // 每行副标题是经销商名；不出现经销商 / 集成项目分组标题
    await expect(options(page).nth(0)).toContainText('杭州暖居环境')
    await expect(options(page).nth(1)).toContainText('上海恒境暖通')
    await expect(options(page).nth(2)).toContainText('南京舒适家')
    await expect(menu(page).getByText('河西府住宅组')).toHaveCount(0)
    // 平台账号与经销商账号的记录互不影响
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hjc-recent-projects:')).length)).toBe(1)
  })

  test('搜索：按经销商名找项目，跨经销商的项目只出现一次，「平台」不是分组；ID 不显示', async ({ page, login }) => {
    await open(page, login, 'admin')
    await openMenu(page)
    await input(page).fill('杭州暖居')
    await tick(page)
    const names = await optionNames(page)
    // 杭州暖居：演示数据 7 个 + BULK-007 + HZ-ONLY
    expect(names).toHaveLength(9)
    expect(names.filter((n) => n === bulkName(7))).toHaveLength(1)
    await expect(list(page).getByRole('group')).toHaveCount(0)
    // BULK-007 同属上海恒境暖通、杭州暖居、平台：搜索「平台」也能找到，但只列一次，副标题是真实经销商
    await input(page).fill('平台')
    await tick(page)
    expect(await optionNames(page)).toEqual([bulkName(7)])
    await expect(options(page).first()).toContainText('上海恒境暖通')
    // 300 个项目里按 ID 搜
    await input(page).fill('bulk-299')
    await tick(page)
    expect(await optionNames(page)).toEqual([bulkName(299)])
    await expect(list(page)).not.toContainText('BULK-299')
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(currentName(page)).toHaveText(bulkName(299))
  })

  test('搜索 300 个项目：结果限高可滚动，底部链接固定', async ({ page, login }) => {
    await open(page, login, 'admin')
    await openMenu(page)
    await input(page).fill('批量园区')
    await tick(page)
    await expect(options(page)).toHaveCount(N)
    const footer = menu(page).getByRole('link', { name: '查看全部项目 →' })
    await expect(footer).toBeInViewport({ ratio: 1 })
    await expect(options(page).last()).not.toBeInViewport()
    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await tick(page)
    await expect(options(page).last()).toBeInViewport({ ratio: 1 })
    await expect(footer).toBeInViewport({ ratio: 1 })
  })

  test('搜不到：提示和去集成项目页搜索，没有「只显示你名下的项目」', async ({ page, login }) => {
    await open(page, login, 'admin')
    await openMenu(page)
    await input(page).fill('不存在的项目')
    await tick(page)
    await expect(menu(page).getByText('没有匹配“不存在的项目”的项目')).toBeVisible()
    await expect(menu(page).getByRole('link', { name: '去集成项目页搜索 →' })).toHaveAttribute('href', '/groups?q=' + encodeURIComponent('不存在的项目'))
    await expect(menu(page).getByText('只显示你名下的项目')).toHaveCount(0)
  })
})

test('Cmd+K / Ctrl+K 聚焦顶栏搜索', async ({ page, login }) => {
  await open(page, login, 'dealer')
  const top = page.getByPlaceholder('搜索项目名称 / 项目ID')
  await expect(top).not.toBeFocused()
  await page.keyboard.press('ControlOrMeta+k')
  await tick(page)
  await expect(top).toBeFocused()
})
