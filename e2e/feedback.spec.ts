// S3a 交互用例（不截图）：确认弹窗（AlertDialog）、温度滑块（Slider）、文字提示（Tooltip）、轻提示（Sonner）。
// 外观由 overlays.spec / pages.spec 的既有截图把关；这里断言截图测不出的焦点、键盘、并发与恢复状态。
import type { Locator, Page } from '@playwright/test'
import { expect, expectToast, settle, test } from './fixtures'

const tick = (page: Page, ms = 50) => page.clock.runFor(ms)
const outline = (el: Locator) => el.evaluate((n) => getComputedStyle(n).outlineStyle)
/** 焦点在 el 上，且外圈是否可见与 ring 一致（浏览器默认外圈是 outline-style: auto） */
async function expectFocus(el: Locator, ring: boolean) {
  await expect(el).toBeFocused()
  if (ring) expect(await outline(el)).not.toBe('none')
  else expect(await outline(el)).toBe('none')
}
/** 真实键盘导航到 el（从顶栏搜索框起按 Tab） */
async function tabTo(page: Page, el: Locator) {
  await page.getByPlaceholder('搜索项目名称 / 项目ID').focus()
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('Tab')
    if (await el.evaluate((n) => n === document.activeElement)) return
  }
  throw new Error('Tab 没能聚焦到目标')
}

test.describe('确认弹窗', () => {
  const openThermostat = async (page: Page, login: (r: 'dealer') => Promise<void>) => {
    await login('dealer')
    await page.goto('/thermostat')
    await settle(page)
    return page.getByRole('button', { name: '全部开启' })
  }
  const dlg = (page: Page) => page.getByRole('alertdialog')

  test('确认：Promise 为 true（下发并提示）；取消：为 false（不下发）', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await trigger.click()
    await tick(page)
    await dlg(page).getByRole('button', { name: '取消' }).click()
    await tick(page)
    await expect(dlg(page)).toHaveCount(0)
    await tick(page, 1000)
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    await trigger.click()
    await tick(page)
    await dlg(page).getByRole('button', { name: '确认下发' }).click()
    await expect(dlg(page)).toHaveCount(0)
    await tick(page, 1000) // 演示接口的延时
    await expectToast(page, '已下发：全部开启（6 个房间）')
  })

  test('Esc 关闭（按取消处理）；点遮罩不关闭', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await trigger.click()
    await tick(page)
    await expect(dlg(page)).toBeVisible()
    // 遮罩左上角（弹窗外）：AlertDialog 不因点遮罩关闭（旧版会关，负责人 11/24 确认改掉）
    await page.mouse.click(10, 10)
    await tick(page)
    await expect(dlg(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(dlg(page)).toHaveCount(0)
    await tick(page, 1000)
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  })

  test('焦点圈在弹窗内：Tab / Shift+Tab 只在「取消」「确认下发」之间', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await trigger.click()
    await tick(page)
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role=alertdialog]'))
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      expect(await inside()).toBe(true)
    }
  })

  test('打开后页面锁滚动、读屏隐藏其余部分；关闭后 body 样式与属性恢复原样', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    const body = () => page.evaluate(() => ({
      // Radix 恢复 pointer-events 后会留下一个空的 style 属性，内容为空即算恢复
      style: document.body.getAttribute('style') ?? '', attrs: [...document.body.attributes].map((a) => a.name).filter((n) => n !== 'style').sort().join(','), paddingRight: getComputedStyle(document.body).paddingRight, marginRight: getComputedStyle(document.body).marginRight, position: getComputedStyle(document.body).position, overflow: getComputedStyle(document.body).overflow, pe: getComputedStyle(document.body).pointerEvents, hidden: document.querySelector('.app')?.getAttribute('aria-hidden') ?? null }))
    const before = await body()
    await trigger.click()
    await tick(page)
    const open = await body()
    expect(open.overflow).toBe('hidden')
    expect(open.hidden).toBe('true')
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(dlg(page)).toHaveCount(0)
    expect(await body()).toEqual(before)
  })

  // 焦点状态表（store.tsx）：打开时「取消」、关闭后触发器的外圈只跟这次操作方式走
  test('鼠标打开 → 「取消」无外圈；鼠标点取消 → 焦点回触发器、无外圈', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    // 先用键盘把焦点移到触发器上（此时它有外圈）：Chromium 对脚本聚焦会沿用“用过键盘”的状态，这里证明鼠标路径不受影响
    await tabTo(page, trigger)
    await trigger.click()
    await tick(page)
    await expectFocus(dlg(page).getByRole('button', { name: '取消' }), false)
    await dlg(page).getByRole('button', { name: '取消' }).click()
    await tick(page)
    await expectFocus(trigger, false)
  })

  test('键盘打开 → 「取消」有外圈；Esc → 焦点回触发器、有外圈', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await tabTo(page, trigger)
    await page.keyboard.press('Enter')
    await tick(page)
    await expectFocus(dlg(page).getByRole('button', { name: '取消' }), true)
    await page.keyboard.press('Escape')
    await tick(page)
    await expectFocus(trigger, true)
  })

  test('键盘打开 → 鼠标点取消：焦点回触发器、无外圈', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await tabTo(page, trigger)
    await page.keyboard.press('Space')
    await tick(page)
    await dlg(page).getByRole('button', { name: '取消' }).click()
    await tick(page)
    await expectFocus(trigger, false)
  })

  test('鼠标打开 → 键盘在「取消」上按 Enter：焦点回触发器、有外圈', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await trigger.click()
    await tick(page)
    await expect(dlg(page).getByRole('button', { name: '取消' })).toBeFocused()
    await page.keyboard.press('Enter')
    await tick(page)
    await expect(dlg(page)).toHaveCount(0)
    await expectFocus(trigger, true)
  })

  test('触发器是不可聚焦的链接（退出登录）：取消后焦点留在 body，不报错', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    await page.locator('.sidebar').getByText('退出登录', { exact: true }).click()
    await tick(page)
    await dlg(page).getByRole('button', { name: '取消' }).click()
    await tick(page)
    await expect(dlg(page)).toHaveCount(0)
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
    await expect(page).toHaveURL(/\/home$/)
  })
})

test.describe('确认弹窗随离开失效', () => {
  test('历史条目已变、React 还没处理时点「确认下发」：按取消处理（不下发），弹窗关闭', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/thermostat')
    await settle(page)
    await page.getByRole('button', { name: '全部开启' }).click()
    await tick(page)
    // 同一个同步块里：浏览器换了历史条目（相当于后退 / 前进已经发生、popstate 还没交给 React），紧接着点旧弹窗的确认
    await page.evaluate(() => {
      history.pushState({ key: 'elsewhere', idx: 99 }, '', '/home')
      const ok = [...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === '确认下发') as HTMLButtonElement
      ok.click()
    })
    await tick(page, 2000)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('[data-sonner-toast]', { hasText: '已下发' })).toHaveCount(0)
  })

  test('温控「全部开启」确认打开时浏览器后退：弹窗消失、按取消处理（不下发）', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    await page.locator('.sidebar').getByText('房间温控面板', { exact: true }).click() // 应用内跳转，后退走 popstate
    await settle(page)
    await expect(page).toHaveURL(/\/thermostat$/)
    await page.getByRole('button', { name: '全部开启' }).click()
    await tick(page)
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.goBack()
    await tick(page)
    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await tick(page, 2000)
    await expect(page.locator('[data-sonner-toast]', { hasText: '已下发' })).toHaveCount(0)
    // 页面恢复可操作（模态的 pointer-events / 滚动锁已解除）
    expect(await page.evaluate(() => [getComputedStyle(document.body).pointerEvents, getComputedStyle(document.body).overflow])).toEqual(['auto', 'visible'])
  })
})

/*
 * 不支持 focus({ focusVisible }) 的浏览器：把 focus() 包一层、丢掉 focusVisible（读不到这个选项 = 不支持），
 * 检查 data-focus-ring 兜底下状态表照样成立
 */
test.describe('焦点外圈兜底（模拟不支持 focusVisible）', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const f = HTMLElement.prototype.focus
      HTMLElement.prototype.focus = function (o?: FocusOptions) { return f.call(this, o ? { preventScroll: o.preventScroll } : undefined) }
    })
  })
  const openThermostat = async (page: Page, login: (r: 'dealer') => Promise<void>) => {
    await login('dealer')
    await page.goto('/thermostat')
    await settle(page)
    return page.getByRole('button', { name: '全部开启' })
  }

  test('用过键盘后鼠标打开 →「取消」无外圈；鼠标点取消 → 触发器无外圈', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await tabTo(page, trigger)
    await trigger.click()
    await tick(page)
    const cancel = page.getByRole('alertdialog').getByRole('button', { name: '取消' })
    await expectFocus(cancel, false)
    await expect(cancel).toHaveAttribute('data-focus-ring', 'off')
    await cancel.click()
    await tick(page)
    await expectFocus(trigger, false)
    // 键盘接管后外圈回来，标记清除
    await page.keyboard.press('ArrowRight')
    await expect(trigger).not.toHaveAttribute('data-focus-ring')
  })

  test('键盘打开 →「取消」有外圈；Esc → 触发器有外圈', async ({ page, login }) => {
    const trigger = await openThermostat(page, login)
    await tabTo(page, trigger)
    await page.keyboard.press('Enter')
    await tick(page)
    await expectFocus(page.getByRole('alertdialog').getByRole('button', { name: '取消' }), true)
    await page.keyboard.press('Escape')
    await tick(page)
    await expectFocus(trigger, true)
  })

  test('滑块：用过键盘后鼠标点击无外圈，按键后有', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/control')
    await settle(page)
    const ring = () => page.locator('[data-slot=slider]').evaluate((n) => getComputedStyle(n, '::after').outlineStyle)
    await page.keyboard.press('Tab')
    const b = (await page.locator('[data-slot=slider]').boundingBox())!
    await page.mouse.click(b.x + 100, b.y + 8)
    await expect(page.getByRole('slider')).toBeFocused()
    expect(await ring()).toBe('none')
    await page.keyboard.press('ArrowLeft')
    expect(await ring()).toBe('auto')
  })
})

test.describe('温度滑块', () => {
  const open = async (page: Page, login: (r: 'dealer') => Promise<void>) => {
    await login('dealer')
    await page.goto('/control')
    await settle(page)
    return page.getByRole('slider', { name: '房间温度设定' })
  }
  const shown = (page: Page) => page.locator('.temp-box .tv b')
  /** 外圈画在控件盒的 ::after 上 */
  const ring = (page: Page) => page.locator('[data-slot=slider]').evaluate((n) => getComputedStyle(n, '::after').outlineStyle)

  test('方向键 / Home / End / PageUp / PageDown / Shift+方向键：步长与原生 range 一致', async ({ page, login }) => {
    const s = await open(page, login)
    await expect(s).toHaveAttribute('aria-valuenow', '26')
    await expect(s).toHaveAttribute('aria-valuemin', '16')
    await expect(s).toHaveAttribute('aria-valuemax', '30')
    await tabTo(page, s)
    const steps: [string, string][] = [
      ['ArrowRight', '26.5'], ['ArrowUp', '27'], ['ArrowLeft', '26.5'], ['ArrowDown', '26'],
      ['End', '30'], ['PageUp', '30'], ['PageDown', '28.5'], ['PageDown', '27'],
      ['Home', '16'], ['ArrowLeft', '16'], ['PageUp', '17.5'], ['Shift+ArrowRight', '18'], ['Shift+ArrowLeft', '17.5'],
    ]
    for (const [key, v] of steps) {
      await page.keyboard.press(key)
      await expect(s, key).toHaveAttribute('aria-valuenow', v)
    }
    await expect(shown(page)).toHaveText('17.5°C')
  })

  test('点击轨道：按指针位置取值（两端各留 8px 行程余量，同原生）', async ({ page, login }) => {
    const s = await open(page, login)
    const b = (await page.locator('[data-slot=slider]').boundingBox())!
    await page.mouse.click(b.x + 8 + (b.width - 16) / 2, b.y + 8)
    await expect(s).toHaveAttribute('aria-valuenow', '23')
    await page.mouse.click(b.x + 2, b.y + 8) // 左端行程余量内
    await expect(s).toHaveAttribute('aria-valuenow', '16')
    await page.mouse.click(b.x + b.width - 2, b.y + 2) // 右端、上沿（控件盒内都能按）
    await expect(s).toHaveAttribute('aria-valuenow', '30')
    await expect(shown(page)).toHaveText('30.0°C')
  })

  test('焦点外圈：鼠标点击无；随后按键有；Tab 进入有', async ({ page, login }) => {
    const s = await open(page, login)
    await page.keyboard.press('Tab') // 先用过键盘：之后的鼠标点击也不出外圈
    const b = (await page.locator('[data-slot=slider]').boundingBox())!
    await page.mouse.click(b.x + 100, b.y + 8)
    await expect(s).toBeFocused()
    expect(await ring(page)).toBe('none')
    await page.keyboard.press('ArrowRight')
    expect(await ring(page)).toBe('auto')
    await page.keyboard.press('Tab')
    expect(await ring(page)).toBe('none')
    await page.keyboard.press('Shift+Tab')
    await expect(s).toBeFocused()
    expect(await ring(page)).toBe('auto')
    // 有外圈时再用鼠标点：外圈不变（同原生）
    await page.mouse.click(b.x + 80, b.y + 8)
    expect(await ring(page)).toBe('auto')
    // 先离开，再鼠标聚焦（无外圈）→ Tab 离开 → Shift+Tab 回来：指针标记在失焦时清掉，键盘回来有外圈
    await page.keyboard.press('Tab')
    await page.mouse.click(b.x + 60, b.y + 8)
    expect(await ring(page)).toBe('none')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(s).toBeFocused()
    expect(await ring(page)).toBe('auto')
    // 滑钮自身不画外圈（外圈画在整个控件盒上，同原生）
    expect(await outline(s)).toBe('none')
  })
})

test.describe('文字提示', () => {
  const tip = (page: Page) => page.getByRole('tooltip')

  test('常用项目卡片：Tab 聚焦立即出现、Esc 关闭；Enter 打开项目', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    const card = page.locator('.proj-card').first()
    await tabTo(page, card)
    await tick(page)
    await expect(tip(page)).toBeVisible()
    await expect(tip(page)).toHaveText(/^已选择 \d+ 次$/)
    await expect(card).toHaveAttribute('aria-describedby', /.+/)
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(tip(page)).toHaveCount(0)
    await expect(card).toBeFocused()
    await page.keyboard.press('Enter')
    await tick(page, 500)
    await expect(page).toHaveURL(/\/sensors$/)
  })

  test('常用项目卡片：悬停 500ms 后出现，移开消失', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    await page.locator('.proj-card').first().hover()
    await tick(page, 300)
    await expect(tip(page)).toHaveCount(0)
    await tick(page, 300)
    await expect(tip(page)).toBeVisible()
    await page.mouse.move(5, 5, { steps: 5 })
    await tick(page)
    await expect(tip(page)).toHaveCount(0)
  })

  test('新风「露点控制」不可用时：按钮本身可聚焦（aria-disabled），Tab 聚焦显示原因、Esc 关闭；点击不切换', async ({ page, login }) => {
    await login('dealer', 'PRJ-10252')
    await page.goto('/fresh-air')
    await settle(page)
    await page.locator('.dev-tab').nth(4).click() // 模式 5：仅湿度控制
    await settle(page)
    const dew = page.getByRole('button', { name: '露点控制' })
    await expect(dew).toHaveAttribute('aria-disabled', 'true')
    await expect(dew).toBeDisabled() // Playwright 认 aria-disabled
    // 外观与真正 disabled 的「湿度控制」同一组规则
    expect(await dew.evaluate((n) => [getComputedStyle(n).cursor, getComputedStyle(n).opacity])).toEqual(['not-allowed', '0.45'])
    await tabTo(page, dew) // 真实 Tab 导航能到达
    await tick(page)
    await expect(tip(page)).toHaveText('当前模式固定为湿度控制')
    await expect(dew).toHaveAttribute('aria-describedby', /.+/)
    await page.keyboard.press('Escape')
    await tick(page)
    await expect(tip(page)).toHaveCount(0)
    await page.keyboard.press('Enter')
    await dew.click({ force: true }) // Playwright 对 aria-disabled 的按钮默认等它可用，这里强制点
    await tick(page)
    await expect(page.locator('.setbox.on', { hasText: '湿度设定值' })).toBeVisible()
    await expect(page.locator('.setbox.dis', { hasText: '露点设定值' })).toBeVisible()
    // 可用时没有提示，是普通按钮
    await page.locator('.dev-tab').nth(0).click()
    await settle(page)
    await expect(page.getByRole('button', { name: '露点控制' })).toBeEnabled()
    await expect(page.getByRole('button', { name: '露点控制' })).not.toHaveAttribute('aria-disabled')
  })

  test('常用项目卡片的可访问名称：项目名、在线状态、编号', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    const name = await page.locator('.proj-card').first().getAttribute('aria-label')
    expect(name).toMatch(/^.+，(在线|离线)，PRJ-\d+$/)
    await expect(page.getByRole('button', { name: name! })).toHaveCount(1)
  })
})

test.describe('轻提示', () => {
  test('2600ms 后消失；多条竖排、旧的在上、间距 8px', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    const city = page.getByRole('button', { name: '上海市 · 浦东新区' })
    await city.click()
    await tick(page, 100)
    await page.locator('.demo-seg').getByRole('button', { name: '2', exact: true }).click()
    await tick(page, 100)
    const toasts = page.locator('[data-sonner-toast]')
    await expect(toasts).toHaveCount(2)
    const [a, b] = await Promise.all([
      page.locator('[data-sonner-toast]', { hasText: '演示环境仅提供上海市浦东新区天气' }).boundingBox(),
      page.locator('[data-sonner-toast]', { hasText: '常用项目计数已重置' }).boundingBox(),
    ])
    expect(a!.y).toBe(72)
    expect(b!.y - (a!.y + a!.height)).toBe(8)
    // 第一条在 2600ms 时消失（已过 200ms），第二条稍后
    await tick(page, 2350)
    await expect(page.locator('[data-sonner-toast]:visible', { hasText: '演示环境' })).toHaveCount(1)
    await tick(page, 100)
    await expect(page.locator('[data-sonner-toast]:visible', { hasText: '演示环境' })).toHaveCount(0)
    await tick(page, 300)
    await expect(page.locator('[data-sonner-toast]:visible')).toHaveCount(0)
  })
})

test.describe('轻提示（不减少动态效果）', () => {
  test.use({ reducedMotion: 'no-preference' })
  test('有入场动画 pop .2s（同旧版）；区域名称「通知」；没有挡点击的悬停桥', async ({ page, login }) => {
    await login('dealer')
    await page.goto('/home')
    await settle(page)
    await page.getByRole('button', { name: '上海市 · 浦东新区' }).click()
    await tick(page, 1)
    const t = page.locator('[data-sonner-toast]')
    await expect(t).toHaveCount(1)
    const anim = await t.evaluate((n) => getComputedStyle(n).animationName + ' ' + getComputedStyle(n).animationDuration)
    expect(anim).toBe('pop 0.2s')
    expect(await t.evaluate((n) => getComputedStyle(n).transitionProperty)).toBe('none') // Sonner 的 0.4s 过渡关掉
    expect(await t.evaluate((n) => getComputedStyle(n, '::after').display)).toBe('none')
    await expect(page.getByRole('region', { name: '通知' })).toHaveCount(1)
  })
})
