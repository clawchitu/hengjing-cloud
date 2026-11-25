// H1 命令行护栏（playwright.live.config.ts 在主进程里调用）：
// - 拒绝会绕过护栏的参数：--ui / --ui-port / --ui-host / --debug（可交互重放；后两个会隐式打开 UI 模式）、--trace（trace 里有请求头和请求体）、
//   --retries 非 0、--repeat-each 非 1（都会让 setup 再登录一次）；
// - 从 --project 算出这次要登录的账号：只选了 platform 就不登录 dealer，反之亦然；没给 --project 两个都登录。
import type { Role } from './harness'

const ROLES: readonly Role[] = ['platform', 'dealer']

export interface CliCheck { errors: string[]; roles: Role[] }

/** argv 里某个选项的取值（--x=v 或 --x v；可出现多次，--project 还可以跟多个值） */
function values(argv: readonly string[], name: string, multi = false): string[] | null {
  let found = false
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === name) {
      found = true
      for (let j = i + 1; j < argv.length && !argv[j].startsWith('-'); j++) { out.push(argv[j]); if (!multi) break }
    } else if (a.startsWith(name + '=')) { found = true; out.push(...a.slice(name.length + 1).split(',')) }
  }
  return found ? out : null
}

export function checkCli(argv: readonly string[], env: Record<string, string | undefined> = {}): CliCheck {
  const errors: string[] = []
  for (const flag of ['--ui', '--ui-port', '--ui-host', '--debug']) if (argv.some((a) => a === flag || a.startsWith(flag + '='))) errors.push(`H1 不允许 ${flag}`)
  if (argv.some((a) => a === '--trace' || a.startsWith('--trace='))) errors.push('H1 不允许 --trace（trace 里有请求头和请求体）')
  if (env.PWDEBUG) errors.push('H1 不允许 PWDEBUG')
  const retries = values(argv, '--retries')
  if (retries && retries.some((v) => v !== '0')) errors.push('H1 不允许 --retries 非 0（重试 setup 就是第二次登录）')
  const repeat = values(argv, '--repeat-each')
  if (repeat && repeat.some((v) => v !== '1')) errors.push('H1 不允许 --repeat-each 非 1（会重复登录）')
  const projects = values(argv, '--project', true)
  const roles = projects === null ? [...ROLES] : ROLES.filter((r) => projects.includes(r))
  return { errors, roles }
}
