// S6a 组织数据联调（手动运行：npx vitest run --config vitest.live.config.ts scripts/live/org.live.ts）。
// 只调只读接口：login（isdp=true）、/me、/ctrl/projects、/integrated-projects、/distributors。
// 钥匙串服务名默认 hengjing-admin / hengjing-dealer，可用 HJC_KEYCHAIN_ADMIN / HJC_KEYCHAIN_DEALER 覆盖。
// 只打印数量、编码和布尔值，不打印令牌、手机号和密码。
// 测试项目的现场服务器可能间歇离线，在线数为 0 不算失败。
import { describe, expect, it } from 'vitest'
import { getConfig, setConfig, TEST_API_ORIGIN } from '../../src/api/config'
import { __resetSessionForTests, signIn } from '../../src/api/session'
import { clearTokens } from '../../src/api/tokens'
import { capabilitiesOf } from '../../src/data/org/capabilities'
import { joinScope, resolveCurrentProject } from '../../src/data/org/map'
import { realSource } from '../../src/data/org/sources'
import { readAccount } from './keychain'

setConfig({ apiBase: TEST_API_ORIGIN, dataSource: 'real' })
if (getConfig().apiEnv !== 'test') throw new Error('联调脚本只允许连测试环境')

const ACCOUNTS = [
  [process.env.HJC_KEYCHAIN_ADMIN || 'hengjing-admin', false],
  [process.env.HJC_KEYCHAIN_DEALER || 'hengjing-dealer', true],
] as const

describe('S6a 组织数据（测试环境，只读）', () => {
  for (const [service, dealer] of ACCOUNTS) {
    it(`${service}：项目列表、在线筛选、集成项目、经销商、组织范围`, async () => {
      clearTokens(); __resetSessionForTests()
      const acct = readAccount(service)
      const info = await signIn(acct.mobile, acct.password, false)
      expect(info.dealer, '身份').toBe(dealer)
      const ctx = { user: { username: '', name: '', org: '', role: dealer ? 'dealer' : 'admin', roleLabel: '' } as const, dealerAccount: dealer }

      const all = await realSource.projects(ctx, {})
      const online = await realSource.projects(ctx, { onlyOnline: true })
      expect(all.length).toBeGreaterThan(0)
      expect(online.every((p) => p.online), 'only_online 返回的都在线').toBe(true)
      expect(all.filter((p) => p.online).length, '全量里的在线数与 only_online 一致').toBe(online.length)
      const codes = new Map<number, number>()
      for (const p of all) codes.set(p.programCode, (codes.get(p.programCode) ?? 0) + 1)
      console.log(`${service}：项目 ${all.length} 个，在线 ${online.length} 个（${online.map((p) => `${p.code}/app ${p.programCode}/温控 ${capabilitiesOf(p.programCode).thermostat}`).join('，')}）；app_code 分布 ${[...codes].map(([c, n]) => `${c}:${n}`).join(' ')}`)

      const groups = await realSource.groups(ctx, undefined)
      const dealers = dealer ? [] : await realSource.dealers(ctx)
      const scope = joinScope(dealers, groups, all, { dealerAccount: dealer })
      console.log(`${service}：集成项目 ${groups.length} 个（${groups.map((g) => `${g.code}:${g.projectIds.length}项`).join('，')}），经销商 ${scope.dealers.length} 个，可见项目 ${scope.projects.length} 个，默认当前项目 ${resolveCurrentProject(scope.projects, '')?.code ?? '无'}`)
      expect(scope.projects.every((p) => groups.find((g) => g.id === p.groupId)?.projectIds.includes(p.id)), '可见项目都在所属集成项目里').toBe(true)
      if (!dealer && dealers[0]) {
        const byDealer = await realSource.groups(ctx, dealers[0].id)
        console.log(`${service}：按经销商 ${dealers[0].code ?? ''} 取集成项目 ${byDealer.length} 个`)
        expect(byDealer.every((g) => g.dealerId)).toBe(true)
      }
      clearTokens()
    }, 60_000)
  }
})
