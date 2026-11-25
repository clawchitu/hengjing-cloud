// 测试环境只读联调：直辖市的省级码（110000）和市级码（110100）哪个能查到 /weather。
// 手动运行：npx vitest run --config vitest.live.config.ts scripts/live/weather.live.ts（仅限 macOS 本机，不进 CI）。
// 只登录 1 次，只调 /weather（只读）。注意：登录会让同账号其他会话的 refresh 失效，运行前先在群里确认没人在用。
import { describe, expect, it } from 'vitest'
import { login } from '../../src/api/auth'
import { getConfig, setConfig, TEST_API_ORIGIN } from '../../src/api/config'
import { request } from '../../src/api/http'
import { clearTokens } from '../../src/api/tokens'
import { readAccount } from './keychain'

setConfig({ apiBase: TEST_API_ORIGIN, dataSource: 'real' })
if (getConfig().apiEnv !== 'test') throw new Error('联调脚本只允许连测试环境')

const CODES = ['110000', '110100', '120000', '120100', '310000', '310100', '500000', '500100']

describe('直辖市天气查询码', () => {
  it('省级码与市级码各查一次 /weather', async () => {
    clearTokens()
    const acct = readAccount('hengjing-admin')
    await login(acct.mobile, acct.password)
    const rows: string[] = []
    for (const city of CODES) {
      try {
        const r = await request<{ weather?: { cityInfo?: { c0?: string; c3?: string }; f7?: unknown; ret_code?: number } }>('/weather', { body: { city } })
        const w = r.weather
        rows.push(`${city}\t200\tc0=${w?.cityInfo?.c0 ?? ''}\tc3=${w?.cityInfo?.c3 ?? ''}\tf7=${w?.f7 ? 'y' : 'n'}\tret_code=${w?.ret_code ?? ''}`)
      } catch (e) {
        rows.push(`${city}\tERR\t${(e as Error).message}`)
      }
    }
    process.stderr.write(`[${new Date().toISOString()}]\n` + rows.join('\n') + '\n')
    expect(rows.length).toBe(CODES.length)
  })
})
