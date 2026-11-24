import { expect, shot, test } from './fixtures'

const PAGES = ['home', 'groups', 'control', 'sensors', 'thermostat', 'fresh-air', 'connections', 'settings']

// 登录页（经销商和管理员共用同一个页面）
test('login', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('input[autocomplete=username]')).toBeVisible()
  await shot(page, 'login', { h1: false })
})

for (const role of ['dealer', 'admin'] as const) {
  test.describe(`${role} 主要页面`, () => {
    for (const p of PAGES) {
      test(p, async ({ page, login }) => {
        await login(role)
        await page.goto(`/${p}`)
        await shot(page, `${role}-${p}`)
      })
    }
  })
}

// 关键状态：不同能力的项目（经销商视角）
const STATES: [string, string][] = [
  ['PRJ-10242', 'mixed-sensors'],
  ['PRJ-10243', 'no-pm-co2'],
  ['PRJ-10252', 'standalone12'],
  ['PRJ-30057', 'standalone12-mode6'],
  ['PRJ-10244', 'offline'],
]
for (const [id, tag] of STATES) {
  for (const p of ['sensors', 'thermostat', 'fresh-air', 'connections']) {
    test(`state ${tag} ${p}`, async ({ page, login }) => {
      await login('dealer', id)
      await page.goto(`/${p}`)
      await shot(page, `state-${tag}-${p}`)
      if (tag === 'offline') await expect(page.locator('.offline-banner')).toBeVisible()
      if (tag === 'standalone12' && p === 'thermostat') await expect(page.getByText('该项目无房间温控面板')).toBeVisible()
    })
  }
}

test('已移除的旧路径回到首页', async ({ page, login }) => {
  await login('dealer')
  for (const dead of ['alarms', 'meters', 'realtime', 'params']) {
    await page.goto(`/${dead}`)
    await page.clock.runFor(500)
    await expect(page).toHaveURL(/\/home$/)
  }
})
