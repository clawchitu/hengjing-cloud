// H1 泄漏回归（npm run e2e:live:dry 的第二步，不连测试服）：
// 用一对独特的假账号密码跑 setup，并故意让「记住我」找不到（填完账号密码后才失败），
// 然后在终端输出、JSON 报告、test-results-live/（含 error-context.md）、e2e-live/.auth/ 里搜这两个值，搜到即失败。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const account = `H1LEAKACCT${randomBytes(4).toString('hex')}`
const password = `H1LEAKPW${randomBytes(4).toString('hex')}`
const r = spawnSync('npx', ['playwright', 'test', '-c', 'playwright.live-dry.config.ts', '--project', 'platform'], {
  encoding: 'utf8',
  env: { ...process.env, H1_DRY_BREAK: 'remember', H1_DRY_KEEP: '1', H1_DRY_MARK_ACCOUNT: account, H1_DRY_MARK_PASSWORD: password },
})
const out = (r.stdout ?? '') + (r.stderr ?? '')

const files = []
const walk = (p) => {
  if (!existsSync(p)) return
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f))
  else files.push(p)
}
for (const d of ['test-results-live', 'playwright-report-live', 'e2e-live/.auth']) walk(d)

const problems = []
if (r.status === 0) problems.push('故意注入的登录失败没有让运行失败')
if (!out.includes('登录未完成')) problems.push('没有看到预期的「登录未完成」错误（故障注入可能没生效）')
if (!files.some((f) => f.endsWith('error-context.md'))) problems.push('没有生成 error-context.md，回归没有覆盖到失败快照')
for (const [name, text] of [['终端输出', out], ...files.map((f) => [f, readFileSync(f, 'utf8')])]) {
  if (text.includes(account) || text.includes(password)) problems.push(`${name} 里出现了账号或密码`)
}
rmSync('test-results-live', { recursive: true, force: true })
rmSync('playwright-report-live', { recursive: true, force: true })
rmSync('e2e-live/.auth', { recursive: true, force: true })

if (problems.length) {
  console.error('H1 泄漏回归失败：\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log(`H1 泄漏回归通过：登录失败后检查了终端输出和 ${files.length} 个产物文件，没有账号和密码`)
