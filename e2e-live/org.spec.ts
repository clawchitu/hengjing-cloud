// F1 / F6 / F7（只读）：首页、侧栏项目列表、切换、搜索。断言界面与 /ctrl/projects、/integrated-projects 原始回包一致。
import { expect, open, orgFromApi, switchProject, test } from './harness'

test.describe('项目列表与切换', () => {
  test('侧栏项目菜单与接口一致（只列集成项目里的项目，在线显示编号、离线显示「离线」）', async ({ page, api }) => {
    await open(page, '/home')
    const org = await orgFromApi(api)
    expect(org.visible.length, '账号应至少能看到一个项目').toBeGreaterThan(0)

    const sw = page.locator('.proj-switch')
    const curName = (await sw.locator('.name').innerText()).trim()
    const cur = org.visible.find((p) => p.name === curName)
    expect(cur, `当前项目「${curName}」应在可见范围里`).toBeDefined()
    await expect(sw.locator('.st')).toContainText(cur!.online ? '在线' : '离线')

    await sw.click()
    const menu = page.getByRole('listbox', { name: '切换当前项目' })
    await expect(menu).toBeVisible()
    // 菜单按集成项目分组，一个项目属于几个集成项目就出现几次
    const visibleIds = new Set(org.visible.map((p) => p.id))
    const expected = org.groups.reduce((n, g) => n + new Set(g.projectIds.filter((id) => visibleIds.has(id))).size, 0)
    await expect(menu.getByRole('option')).toHaveCount(expected)
    for (const p of org.visible) {
      await expect(menu.getByRole('option').filter({ hasText: p.name }).filter({ hasText: p.online ? p.code : '离线' }).first(), p.code).toBeVisible()
    }

    // 切换到另一个可见项目（优先在线的）：侧栏名称与在线状态跟着变
    const other = [...org.visible].sort((a, b) => Number(b.online) - Number(a.online)).find((p) => p.id !== cur!.id && p.name !== cur!.name)
    test.skip(!other, '账号只有一个可见项目，无法测切换（环境不足，不算失败）')
    await menu.getByRole('option').filter({ hasText: other!.name }).first().click()
    await expect(sw.locator('.name')).toHaveText(other!.name)
    await expect(sw.locator('.st')).toContainText(other!.online ? '在线' : '离线')
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: `已切换到「${other!.name}」` })).toBeVisible()
  })

  test('顶部搜索：按编号找到可见项目并切换；可见范围外的项目搜不到', async ({ page, api }) => {
    await open(page, '/home')
    const org = await orgFromApi(api)
    const target = org.visible.find((p) => p.code) ?? null
    test.skip(!target, '没有带编号的可见项目')
    await switchProject(page, target!)
    await expect(page.locator('.proj-switch .st')).toContainText(target!.online ? '在线' : '离线')
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: `当前项目已切换为「${target!.name}」` })).toBeVisible()

    const box = page.getByRole('combobox', { name: '搜索项目' })
    // 可见范围外（在项目列表里、但不在任何集成项目里）、且编号不会被可见项目包含的项目：搜不到（经销商只见自己）
    const hidden = org.projects.find((p) => p.code && !org.visible.some((v) => v.id === p.id) && !org.visible.some((v) => (v.name + ' ' + v.code).toLowerCase().includes(p.code.toLowerCase())))
    if (hidden) {
      await box.fill(hidden.code)
      await expect(page.getByText('未找到匹配的项目（仅搜索您可见的集成项目内的项目）')).toBeVisible()
    }
    await box.fill('h1-不存在的项目-zz')
    await expect(page.getByText('未找到匹配的项目（仅搜索您可见的集成项目内的项目）')).toBeVisible()
    await box.press('Escape')
  })
})
