// S5 会话联调（手动运行：npx vitest run --config vitest.live.config.ts scripts/live/session.live.ts）。
// 只调 POST /auth/login（isdp=true）和 GET /me，不调任何写接口，也不调 refresh / invalidate。
// 只断言布尔值和数量，日志里不出现令牌、手机号和密码。
import { describe, expect, it } from 'vitest'
import { getConfig, setConfig, TEST_API_ORIGIN } from '../../src/api/config'
import { __resetSessionForTests, can, getSession, signIn } from '../../src/api/session'
import { clearTokens, readTokens } from '../../src/api/tokens'
import { readAccount } from './keychain'

setConfig({ apiBase: TEST_API_ORIGIN, dataSource: 'real' })
if (getConfig().apiEnv !== 'test') throw new Error('联调脚本只允许连测试环境')

describe('S5 会话（测试环境，只读）', () => {
  for (const [service, dealer] of [['hengjing-admin', false], ['hengjing-dealer', true]] as const) {
    it(`${service}：signIn(isdp=true) → /me → 身份与 can()`, async () => {
      clearTokens(); __resetSessionForTests()
      const acct = readAccount(service)
      const info = await signIn(acct.mobile, acct.password, false)
      expect(getSession().status).toBe('authed')
      expect(info.dealer, '身份').toBe(dealer)
      expect(readTokens()!.expiresAt - Date.now()).toBeGreaterThan(7000_000)
      console.log(`${service}：dealer=${info.dealer}，permission_paths ${info.permissionPaths.length} 条，can(/me)=${can('/me')}，can(/projects)=${can('/projects')}，can(/project/{id})=${can('/project/000000000000000000000000')}`)
      expect(can('/me')).toBe(true)
      expect(can('/projects')).toBe(true)
      clearTokens()
    }, 30_000)
  }
})
