// F1 / F5（只读部分）：首页统计卡与常用项目，和 /integrated-projects/stat、/projects/frequent 的原始回包一致。
// 不碰天气（真实接口模式下首页天气暂未接入）。
import { expect, open, orgFromApi, test, type ApiHit } from './harness'

/** 网关 JSON 里 int64 是字符串；缺失、非法按 0（与接口文档 6.1 一致） */
const int64 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }
const squash = (s: string) => s.replace(/\s+/g, '')

test('首页统计卡与接口一致', async ({ page, api }) => {
  await open(page, '/home')
  await expect(page.locator('h1').first()).toBeVisible()
  const org = await orgFromApi(api)
  const card = (label: string) => page.locator('.stat').filter({ hasText: label }).locator('b.num')
  // 等统计卡出数（不是「—」）
  await expect(card('集成项目')).not.toHaveText('—')

  // 发过 /stat 就等它的回包（界面可能先于回包记录渲染）；没发过说明没有权限
  const statHit: ApiHit | undefined = api.wasSent('/integrated-projects/stat') ? await api.latest('/integrated-projects/stat') : undefined
  const stat = statHit?.status === 200 ? statHit : undefined
  let want: { groups: string; projects: string; online: string; offline: string }
  if (stat) {
    // 有权限：直接取 /stat
    const r = stat.json as Record<string, unknown>
    const total = int64(r.project_total), online = Math.min(int64(r.project_online), total)
    const offline = r.project_offline === undefined ? total - online : int64(r.project_offline)
    want = { groups: String(int64(r.total)), projects: String(total), online: `${online}/${total}`, offline: `${offline}/${total}` }
    test.info().annotations.push({ type: 'stat', description: '来源 /integrated-projects/stat' })
  } else {
    // 无权限或失败：前端按可见范围算（集成项目的 project_ids 去重；列表里没有的算「未知」，在线 / 离线显示为范围）
    const ids = new Set(org.groups.flatMap((g) => g.projectIds))
    const known = org.projects.filter((p) => ids.has(p.id))
    const online = known.filter((p) => p.online).length, offline = known.length - online, unknown = ids.size - known.length
    want = {
      groups: String(org.groups.length), projects: String(ids.size),
      online: `${unknown ? '≥' : ''}${online}/${ids.size}`, offline: `${unknown ? '≤' : ''}${unknown ? offline + unknown : offline}/${ids.size}`,
    }
    test.info().annotations.push({ type: 'stat', description: '来源 前端按可见范围计算（/stat 无权限或失败）' })
  }
  await expect(card('集成项目')).toHaveText(want.groups)
  await expect(card('项目总数')).toHaveText(want.projects)
  expect(squash(await card('在线项目').innerText())).toBe(want.online)
  expect(squash(await card('离线项目').innerText())).toBe(want.offline)
})

test('首页常用项目与 /projects/frequent 一致（只留可见范围里的，最多 4 个，按接口顺序）', async ({ page, api }) => {
  await open(page, '/home')
  const org = await orgFromApi(api)
  const box = page.locator('[data-slot="card"]').filter({ hasText: '按您切换当前项目的次数统计' }).last()
  // 等到出结果：卡片或空态 / 未开通 / 失败
  await expect(box.locator('.proj-card, .empty-fav').first()).toBeVisible()

  if (api.wasSent('/projects/frequent')) await api.latest('/projects/frequent')
  const hits = api.all('/projects/frequent')
  if (!hits.length) {
    // 没有该路由权限：不发请求，显示未开通
    await expect(box.getByText('常用项目暂不可用')).toBeVisible()
    return
  }
  const last = hits.at(-1)!
  if (last.status !== 200) {
    await expect(box.getByText('常用项目加载失败')).toBeVisible()
    return
  }
  const byId = new Map(org.visible.map((p) => [p.id, p]))
  const want: typeof org.visible = []
  for (const e of (last.json as { project_entities?: { id?: unknown }[] }).project_entities ?? []) {
    const p = byId.get(String(e.id))
    if (p && !want.includes(p)) want.push(p)
    if (want.length >= 4) break
  }
  if (!want.length) {
    await expect(box.getByText('暂无常用项目')).toBeVisible()
    return
  }
  const cards = box.locator('.proj-card')
  await expect(cards).toHaveCount(want.length)
  for (const [i, p] of want.entries()) {
    await expect(cards.nth(i)).toHaveAttribute('aria-label', `${p.name}，${p.online ? '在线' : '离线'}，${p.code}`)
  }
})
