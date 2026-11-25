// H1 命令行护栏的单元测试
import { describe, expect, it } from 'vitest'
import { checkCli } from './cli'

describe('H1 命令行护栏', () => {
  it('默认两个账号都登录，无错误', () => {
    expect(checkCli(['node', 'playwright', 'test', '-c', 'playwright.live.config.ts'])).toEqual({ errors: [], roles: ['platform', 'dealer'] })
  })
  it('--project 只选一个时只登录那一个', () => {
    expect(checkCli(['test', '--project=platform']).roles).toEqual(['platform'])
    expect(checkCli(['test', '--project', 'dealer']).roles).toEqual(['dealer'])
    expect(checkCli(['test', '--project', 'dealer', 'platform', '-g', 'x']).roles).toEqual(['platform', 'dealer'])
    expect(checkCli(['test', '--project', 'setup']).roles).toEqual([])
  })
  it('拒绝 --ui / --debug / --trace / PWDEBUG', () => {
    expect(checkCli(['test', '--ui']).errors).toHaveLength(1)
    expect(checkCli(['test', '--debug']).errors).toHaveLength(1)
    expect(checkCli(['test', '--trace', 'on']).errors).toHaveLength(1)
    expect(checkCli(['test', '--trace=retain-on-failure']).errors).toHaveLength(1)
    expect(checkCli(['test'], { PWDEBUG: '1' }).errors).toHaveLength(1)
  })
  it('拒绝 --retries 非 0、--repeat-each 非 1', () => {
    expect(checkCli(['test', '--retries', '2']).errors).toHaveLength(1)
    expect(checkCli(['test', '--retries=1']).errors).toHaveLength(1)
    expect(checkCli(['test', '--retries=0']).errors).toEqual([])
    expect(checkCli(['test', '--repeat-each', '3']).errors).toHaveLength(1)
    expect(checkCli(['test', '--repeat-each=1']).errors).toEqual([])
  })
})
