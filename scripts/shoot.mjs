// Screenshot every page at the reference viewport. Usage: node scripts/shoot.mjs <baseUrl> <outDir> [pages...]
import { chromium } from 'playwright-core'
const [base = 'http://localhost:4173', out = 'compare/build', ...only] = process.argv.slice(2)
const W = 1300
// page -> [route, reference height in px at W (from PDF aspect)]
const PAGES = {
  p01: ['/login', 768], p02: ['/thermostat', 1470], p03: ['/fresh-air', 1248], p04: ['/meters', 1266],
  p05: ['/realtime', 1331], p06: ['/params', 1007], p07: ['/connections', 1093], p08: ['/alarms', 1202],
  p09: ['/control', 927], p10: ['/home', 1055], p11: ['/sensors', 1236], p12: ['/groups', 768],
}
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
for (const [k, [route, hpt]] of Object.entries(PAGES)) {
  if (only.length && !only.includes(k)) continue
  const h = Math.round(hpt * W / 1080)
  const ctx = await browser.newContext({ viewport: { width: W, height: k === 'p01' || k === 'p12' ? Math.round(h * 0.814) : h }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  if (k !== 'p01') await page.addInitScript(() => { localStorage.setItem('hjc-auth', 'zhangjianguo'); localStorage.setItem('hjc-project', 'PRJ-10241') })
  else await page.addInitScript(() => localStorage.clear())
  await page.goto(base + route, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/${k}.png`, fullPage: true })
  await ctx.close()
  console.log('shot', k)
}
await browser.close()
