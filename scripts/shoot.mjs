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
  // mode 5 (humidity-only): panel stays, only the control-type toggle and dew setpoint are hidden
  ok('mode5 keeps 开关/湿度设定值/风速/下发', await p.isVisible('.set-panel >> text=开关') && await p.isVisible('text=湿度设定值') && await p.isVisible('text=风速设定') && await p.isVisible('text=下发设置'))
  ok('mode5: toggle shown but locked to 湿度, 露点 card 未启用', await p.isVisible('.ctl-type') && await p.isDisabled('.ctl-type button:has-text("露点控制")') && await p.isVisible('text=露点设定值') && await p.isVisible('.setbox.dis:has-text("露点设定值") >> text=未启用') && await p.isVisible('.setbox.on:has-text("湿度设定值")') && !(await p.isVisible('text=湿度控制（固定）')))
  await p.click('.setbox.on button.plus'); ok('mode5 humidity editable', (await p.textContent('.setbox.on .sv')).startsWith('51'))
  await p.click('.dev-tab >> nth=0'); await p.waitForTimeout(300); ok('mode2 toggle selectable', await p.isEnabled('.ctl-type button:has-text("露点控制")'))
  for (const id of ['PRJ-10241', 'PRJ-10242', 'PRJ-30058', 'PRJ-20117']) { await setProject(id); await p.goto(base + '/fresh-air'); await p.waitForTimeout(500); ok(`${id} non-12 has no 运行设置, full-row 实时数据`, !(await p.isVisible('text=运行设置')) && !!(await p.$('.fa-top.wide'))) }
  await setProject('PRJ-10241'); await p.goto(base + '/connections'); await p.waitForTimeout(400); ok('connections has no 网络拓扑', !(await p.isVisible('text=网络拓扑')))
  await p.goto(base + '/groups'); await p.waitForTimeout(300); ok('dealer: no dealer picker, only own groups', !(await p.$('.dealer-pick')) && !(await p.isVisible('text=西溪蝶园')))
  await p.goto(base + '/home'); await p.waitForTimeout(500); { const [c, pg] = await Promise.all([p.$eval('.home-mid .card', (e) => e.getBoundingClientRect().width), p.$eval('.home-mid', (e) => e.getBoundingClientRect().width)]); ok('home 24h chart full width', c >= pg - 2) }
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
  await p.fill('.dp-search input', '南京'); await p.waitForTimeout(300); ok('dealer search filters + selects', (await p.$$eval('.dealer-pick option', (o) => o.length)) === 1 && await p.isVisible('text=河西府住宅组')); await shot('groups-dealer-search')
  await p.fill('.dp-search input', '杭州'); await p.waitForTimeout(300); ok('dealer search 杭州', await p.isVisible('text=西溪蝶园别墅组'))
  await p.fill('.dp-search input', 'zzz'); await p.waitForTimeout(300); ok('dealer search no match → empty state, no stale groups', await p.isVisible('text=匹配 0 / 3') && await p.isVisible('text=没有与「zzz」匹配的经销商') && !(await p.isVisible('.grp-card'))); await shot('groups-dealer-search-empty')
  await p.fill('.dp-search input', ''); await p.waitForTimeout(300); ok('clearing search restores groups', await p.isVisible('.grp-card'))
  await p.fill('.search input', '西溪'); await p.waitForTimeout(300); ok('admin search sees all dealers', await p.isVisible('.sp-row'))
  await ctx.close()
}
console.log('console errors:', errors.length); errors.slice(0, 10).forEach((e) => console.log('  ' + e))
console.log('FAILS:', fails.length, fails.join(' | '))
await b.close()
