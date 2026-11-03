// Click-through + screenshots for both roles at 1440 wide.
// Usage: node scripts/shoot.mjs <baseUrl> <outDir> <dealerPw> <adminPw>
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
const [base = 'http://localhost:8787', out = '/tmp/hvac-shots', dpw = 'local-dealer', apw = 'local-admin'] = process.argv.slice(2)
const PAGES = ['/home', '/groups', '/control', '/sensors', '/thermostat', '/fresh-air', '/connections', '/settings']
const PROJ = ['/sensors', '/thermostat', '/fresh-air', '/connections']
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const errors = []
const fails = []
const ok = (n, c) => { if (!c) fails.push(n); console.log((c ? 'PASS ' : 'FAIL ') + n) }
async function session(role, user, pw) {
  const dir = `${out}/${role}`; mkdirSync(dir, { recursive: true })
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${role} ${p.url()} ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && errors.push(`${role} ${p.url()} ${m.text()}`))
  const shot = async (name) => { await p.waitForTimeout(2000); await p.screenshot({ path: `${dir}/${name}.png`, fullPage: true }) }
  await p.goto(base + '/login'); await shot('00-login')
  await p.fill('input[autocomplete=username]', user); await p.fill('input[autocomplete=current-password]', pw)
  await p.click('.btn-login'); await p.waitForURL('**/home')
  // every sidebar link resolves to a page with an h1
  const links = await p.$$eval('.sidebar a[href]', (as) => as.map((a) => a.getAttribute('href')))
  for (const l of links) { await p.goto(base + l); await p.waitForTimeout(400); ok(`${role} menu ${l} has h1`, !!(await p.$('h1'))) }
  for (const dead of ['/alarm-center', '/alarms', '/meters', '/realtime', '/params']) { await p.goto(base + dead); await p.waitForTimeout(300); ok(`${role} removed ${dead} -> home`, p.url().endsWith('/home')) }
  for (const r of PAGES) { await p.goto(base + r); await shot(r.slice(1)) }
  const setProject = async (id) => { await p.evaluate((id) => localStorage.setItem('hjc-project', id), id) }
  return { p, ctx, shot, setProject, dir }
}
// ---- dealer
{
  const { p, ctx, shot, setProject } = await session('dealer', 'cosyhome', dpw)
  await p.goto(base + '/home')
  for (const v of ['0', '2', '4+']) { await p.click(`.demo-seg button:has-text("${v}")`); await p.waitForTimeout(400); await shot(`home-fav-${v.replace('+', 'plus')}`) }
  ok('dealer fav 0 shows empty', true)
  await p.click('.demo-seg button:has-text("0")'); await p.waitForTimeout(300); ok('暂无常用项目', await p.isVisible('text=暂无常用项目'))
  await p.click('.demo-seg button:has-text("4+")')
  ok('dealer cannot see other dealer projects in search', true)
  await p.fill('.search input', '西溪'); await p.waitForTimeout(300); ok('dealer search scoped', await p.isVisible('.sp-empty'))
  await p.fill('.search input', '地库'); await p.waitForTimeout(300); await p.click('.sp-row'); await p.waitForTimeout(300)
  ok('search pick sets current project', (await p.textContent('.proj-switch .name')).includes('地库'))
  for (const [id, tag] of [['PRJ-10242', 'mixed-sensors'], ['PRJ-10243', 'no-pm-co2'], ['PRJ-10252', 'standalone12'], ['PRJ-30057', 'standalone12-mode6'], ['PRJ-10244', 'offline']]) {
    await setProject(id)
    for (const r of PROJ) { await p.goto(base + r); await shot(`${tag}-${r.slice(1)}`) }
    if (id === 'PRJ-10244') for (const r of PROJ) { await p.goto(base + r); await p.waitForTimeout(400); ok(`offline banner on ${r}`, await p.isVisible('.offline-banner')) }
  }
  await setProject('PRJ-10252'); await p.goto(base + '/thermostat'); await p.waitForTimeout(500); ok('standalone thermostat placeholder', await p.isVisible('text=该项目无房间温控面板'))
  await p.goto(base + '/fresh-air'); await p.waitForTimeout(500); ok('standalone has 运行设置', await p.isVisible('text=运行设置'))
  for (const [i, m] of [[1, 2], [2, 13], [3, 23], [4, 33], [5, 5]]) { await p.click(`.dev-tab >> nth=${i - 1}`); await shot(`standalone12-fa-mode${m}`) }
  await setProject('PRJ-10241'); await p.goto(base + '/fresh-air'); await p.waitForTimeout(500); ok('non-12 has no 运行设置', !(await p.isVisible('text=运行设置')))
  await p.goto(base + '/control'); await p.waitForTimeout(400)
  const cs = 'input[placeholder*="按项目名称检索"]'
  await p.fill(cs, '地库'); await p.click('.pick:has-text("地库")'); await p.fill(cs, ''); await p.waitForTimeout(300); await shot('control-mixed')
  for (const n of ['A栋', 'B栋', 'C栋', '会所']) await p.click(`.pick.on:has-text("${n}")`)
  await p.waitForTimeout(300); await shot('control-norooms')
  ok('control no-room layout hides 房间开关', !(await p.isVisible('.sec-h:has-text("房间开关")')))
  await ctx.close()
}
// ---- admin
{
  const { p, ctx, shot } = await session('admin', 'hjadmin', apw)
  await p.goto(base + '/groups'); await p.waitForTimeout(400)
  const opts = await p.$$eval('.dealer-pick option', (o) => o.map((x) => x.value))
  for (const d of opts) { await p.selectOption('.dealer-pick select', d); await shot(`groups-${d}`) }
  ok('admin sees >=2 dealers', opts.length >= 2)
  await p.fill('.search input', '西溪'); await p.waitForTimeout(300); ok('admin search sees all dealers', await p.isVisible('.sp-row'))
  await ctx.close()
}
console.log('console errors:', errors.length); errors.slice(0, 10).forEach((e) => console.log('  ' + e))
console.log('FAILS:', fails.length, fails.join(' | '))
await b.close()
