// 从 macOS 钥匙串读取测试账号（服务名 hengjing-admin / hengjing-dealer）。
// 账号是条目的「帐户」字段，密码是条目的密码。不打印、不落盘。
import { execFileSync } from 'node:child_process'

export function readAccount(service: string): { mobile: string; password: string } {
  const attrs = execFileSync('security', ['find-generic-password', '-s', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const m = /"acct"<blob>="([^"]*)"/.exec(attrs)
  if (!m) throw new Error(`钥匙串条目 ${service} 缺少帐户字段`)
  const password = execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '')
  return { mobile: m[1], password }
}
