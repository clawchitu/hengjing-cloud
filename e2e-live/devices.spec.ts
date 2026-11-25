// F8（只读）：传感器、温控、连接状态三页的读数与 ctrl 读回包一致，不显示 65536；离线项目为空态、不发 ctrl 请求。
// 温控只看：可以点开关进入确认框再「取消」，断言没有任何写请求（闸门在请求发出前 abort，这里再核对一条都没出现过）。
// 不碰新风和天气。
import { WRITE_PATHS } from './policy'
import { expect, expectNo65536, open, orgFromApi, switchProject, test, type ApiLog, type LiveProject } from './harness'
import type { Page } from '@playwright/test'

/** 优先用两个测试项目（在线时），其次任一在线的可见项目；都没有就跳过（环境不可用，不算失败） */
async function onlineProject(page: Page, api: ApiLog): Promise<LiveProject> {
  await open(page, '/home')
  const org = await orgFromApi(api)
  const on = org.visible.filter((p) => p.online)
  const p = on.find((x) => x.code === '240829001') ?? on.find((x) => x.code === '260911001') ?? on[0]
  test.skip(!p, '可见范围里没有在线项目（环境不可用，不算失败）')
  await switchProject(page, p!)
  return p!
}

/** 读数有效：不是 65536（无数据）/ -100（无效） */
const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v !== 65536 && v !== -100

test('传感器：实时卡片与 207 一致；统计三档切换', async ({ page, api }) => {
  const p = await onlineProject(page, api)
  await page.goto('/sensors')
  await expect(page.getByRole('heading', { level: 1, name: '室内空气传感器' })).toBeVisible()
  const { hit, reply } = await api.ctrl(207, p.id)
  if (!reply) {
    if (hit.status === 503) await expect(page.getByText('控制屏未连接').first()).toBeVisible()
    else if (hit.status === 403) await expect(page.getByText('未开通空气传感器数据')).toBeVisible()
    else await expect(page.getByText('空气传感器数据加载失败')).toBeVisible()
    test.info().annotations.push({ type: 'env', description: `207 返回 ${hit.status}，只核对了空态` })
    return
  }
  const data = reply.data ?? []
  if (!data.length) { await expect(page.getByText('暂无空气传感器数据')).toBeVisible(); return }

  // 卡片数量、名称、在线传感器的温度（取最新一次 207，轮询刷新时自动对上）
  await expect(page.getByText(`${data.length} 台`).first()).toBeVisible()
  await expect(async () => {
    const latest = (await api.ctrl(207, p.id)).reply?.data ?? []
    const cards = page.locator('.sensor')
    await expect(cards).toHaveCount(latest.length, { timeout: 1000 })
    for (const [i, d] of latest.entries()) {
      const name = d.name?.trim() || `传感器 ${d.id || i + 1}`
      const card = cards.filter({ hasText: name }).first()
      await expect(card).toBeVisible({ timeout: 1000 })
      if (d.isConnected === true && valid(d.temperature)) await expect(card).toContainText(`${d.temperature.toFixed(1)}°`, { timeout: 1000 })
    }
  }).toPass({ timeout: 30_000 })
  await expectNo65536(page)

  // 统计三档：按钮高亮、说明文字跟着变，统计区不报错；208 都返回 200
  const seg = page.locator('.seg.primary')
  const desc: Record<string, string> = { '7日': '近 7 日趋势', '30日': '近 30 日趋势', '24小时': '24 小时趋势（逐时）' }
  for (const range of ['7日', '30日', '24小时']) {
    await seg.getByRole('button', { name: range, exact: true }).click()
    await expect(seg.getByRole('button', { name: range, exact: true })).toHaveClass(/\bon\b/)
    await expect(page.getByText(desc[range]).first()).toBeVisible()
    await expect(page.locator('[data-slot="card"]').filter({ hasText: '数据统计' }).getByText(/加载失败/)).toHaveCount(0)
  }
  const r208 = api.all('/ctrl/air-sensor-data-hour-get', (h) => h.reqBody?.project_id === p.id)
  expect(r208.length, '统计应读过 208').toBeGreaterThan(0)
  expect(r208.map((h) => h.status).filter((s) => s !== 200), '208 回包状态').toEqual([])
  await expectNo65536(page)
})

test('温控：房间列表与 200 一致；点开关进确认框再取消，零写请求', async ({ page, api, ledger }) => {
  const p = await onlineProject(page, api)
  await page.goto('/thermostat')
  await expect(page.getByRole('heading', { level: 1, name: '房间温控面板' })).toBeVisible()
  const { hit, reply } = await api.ctrl(200, p.id)
  if (!reply) {
    await expect(page.getByText(hit.status === 503 ? '控制屏未连接' : '房间温控数据读取失败').first()).toBeVisible()
    test.info().annotations.push({ type: 'env', description: `200 返回 ${hit.status}，只核对了空态` })
    return
  }
  const rooms = (reply.data ?? []).filter((r) => Number.isSafeInteger(r.id) && r.id > 0)
  if (!rooms.length) { await expect(page.getByText('未读到房间温控面板')).toBeVisible(); return }

  // 每个房间：名称、面板离线标记；开关已上报时开关状态与 switch 一致，未上报时显示「开关未知」
  await expect(async () => {
    const latest = ((await api.ctrl(200, p.id)).reply?.data ?? []).filter((r) => Number.isSafeInteger(r.id) && r.id > 0)
    for (const r of latest) {
      const name = r.name || `房间 ${r.id}`
      const sw = page.getByRole('switch', { name: `${name} 开关`, exact: true })
      if (await sw.count()) await expect(sw).toHaveAttribute('aria-checked', String(r.switch === 1), { timeout: 1000 })
      else await expect(page.getByRole('button', { name: `${name} 开启`, exact: true })).toBeVisible({ timeout: 1000 })
      const card = page.locator(`[data-room="${r.id}"]`)
      await expect(card.locator('.room-name')).toHaveText(name, { timeout: 1000 })
      await expect(card.getByText('面板离线')).toHaveCount(r.isConnected === true ? 0 : 1, { timeout: 1000 })
    }
  }).toPass({ timeout: 30_000 })
  await expectNo65536(page)

  // 找一个可点的开关（Switch 或未上报时的「开 / 关」按钮），点开确认框，核对文案后取消
  let trigger = null as null | { loc: ReturnType<Page['getByRole']>; on: boolean; room: string }
  for (const r of rooms) {
    const name = r.name || `房间 ${r.id}`
    const sw = page.getByRole('switch', { name: `${name} 开关`, exact: true })
    if (await sw.count() && await sw.isEnabled()) { trigger = { loc: sw, on: (await sw.getAttribute('aria-checked')) !== 'true', room: name }; break }
    const btn = page.getByRole('button', { name: `${name} 开启`, exact: true })
    if (await btn.count() && await btn.isEnabled()) { trigger = { loc: btn, on: true, room: name }; break }
  }
  test.skip(!trigger, '没有可点的房间开关（面板离线或读数不可下发），跳过确认框部分')
  const before = await trigger!.loc.getAttribute('aria-checked')
  await trigger!.loc.click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(trigger!.on ? '开启房间' : '关闭房间')
  await expect(dialog).toContainText(p.code)
  await expect(dialog).toContainText(`「${trigger!.room}」`)
  await expect(dialog.getByRole('button', { name: '确认下发' })).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  expect(await trigger!.loc.getAttribute('aria-checked')).toBe(before)

  // 零写请求：网络记录里一条写路由都没有（不只是被拦，而是根本没发起）
  const writes = ledger.net.filter((l) => WRITE_PATHS.some((w) => l.endsWith('/api' + w)))
  expect(writes, '取消后不应发起任何写请求').toEqual([])
  expect(ledger.violations).toEqual([])
})

test('连接状态：计数与 205 一致', async ({ page, api }) => {
  const p = await onlineProject(page, api)
  await page.goto('/connections')
  await expect(page.getByRole('heading', { level: 1, name: '设备连接状态' })).toBeVisible()
  // 切换后页头是新项目（没有上一个项目的残留）
  await expect(page.locator('.page-head .sub').first()).toContainText(p.name)
  const { hit, reply } = await api.ctrl(205, p.id)
  if (!reply) {
    if (hit.status === 503) await expect(page.getByText('控制屏未连接').first()).toBeVisible()
    test.info().annotations.push({ type: 'env', description: `205 返回 ${hit.status}，只核对了空态` })
    return
  }
  await expect(async () => {
    const data = (await api.ctrl(205, p.id)).reply?.data ?? []
    const online = data.filter((d) => d.connStatus === 1).length
    const offline = data.filter((d) => (d.connStatus ?? 0) === 0).length
    const kpi = (label: string) => page.locator('.kpi').filter({ has: page.locator('.k-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.k-val')
    await expect(kpi('在线')).toHaveText(String(online), { timeout: 1000 })
    await expect(kpi('离线')).toHaveText(String(offline), { timeout: 1000 })
    await expect(page.locator('.seg button', { hasText: '全部' })).toContainText(String(data.length), { timeout: 1000 })
  }).toPass({ timeout: 30_000 })
  await expectNo65536(page)
})

test('离线项目：三页都是离线空态，不发 ctrl 请求', async ({ page, api }) => {
  await open(page, '/home')
  const org = await orgFromApi(api)
  const p = org.visible.find((x) => !x.online && x.code)
  test.skip(!p, '可见范围里没有离线项目')
  await switchProject(page, p!)
  for (const [path, title] of [['/sensors', '室内空气传感器'], ['/thermostat', '房间温控面板'], ['/connections', '设备连接状态']] as const) {
    await page.goto(path)
    await expect(page.locator('.offline-banner')).toContainText(`项目离线 · ${p!.name}`)
    await expect(page.getByRole('heading', { name: '项目离线，暂无数据' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title)
  }
  // 设备页不挂载，不应对离线项目发任何 ctrl 读请求（留 3 秒给可能的误发）
  await page.waitForTimeout(3000)
  expect(api.ctrlCalls(p!.id), '离线项目不应发 ctrl 请求').toBe(0)
})
