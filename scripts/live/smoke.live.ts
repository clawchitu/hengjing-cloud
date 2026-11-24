// 测试环境只读联调（手动运行：npm run test:live，仅限 macOS 本机，不进 CI）。
// 账号从钥匙串读取；只调只读接口：login、/me、/ctrl/projects、/projects、ctrl 205/207、refresh。
// 注意：后端每个用户只有一个有效 refresh_token，登录和刷新会让该账号其他会话的 refresh 失效。
import { describe, expect, it } from 'vitest'
import { isDealer, login, me } from '../../src/api/auth'
import { callCtrl } from '../../src/api/ctrl'
import { getConfig, setConfig, TEST_API_ORIGIN } from '../../src/api/config'
import { checkWrite } from '../../src/api/guard'
import { refreshSession, request } from '../../src/api/http'
import { clearTokens, readTokens } from '../../src/api/tokens'
import { readAccount } from './keychain'

setConfig({ apiBase: TEST_API_ORIGIN, dataSource: 'real' })
if (getConfig().apiEnv !== 'test') throw new Error('联调脚本只允许连测试环境')

interface CtrlProject { id: string; name?: string; online?: boolean }

describe('测试环境只读联调', () => {
  it('平台账号：login(isdp=true) → me → ctrl/projects → ctrl 205 读 → refresh', async () => {
    clearTokens()
    const acct = readAccount('hengjing-admin')
    await login(acct.mobile, acct.password, { isdp: true })
    const m = await me()
    expect(m.user_entity?.id).toBeTruthy()
    expect(isDealer(m.user_entity)).toBe(false)
    expect(m.permission_paths?.length ?? 0).toBeGreaterThan(0)

    const r = await request<{ project_entities?: CtrlProject[] }>('/ctrl/projects', { body: { only_online: true } })
    const online = (r.project_entities ?? []).filter((p) => p.online)
    console.log(`在线项目 ${online.length} 个`)
    expect(online.length).toBeGreaterThan(0)

    const summary = await callCtrl(205, online[0].id)
    console.log(`205 设备汇总：${summary.data.length} 台`, summary.data.map((d) => `${d.deviceName}/${d.model}/${d.connStatus}`).join('，'))
    expect(summary.data.length).toBeGreaterThan(0)
    const sensors = await callCtrl(207, online[0].id)
    console.log(`207 空气传感器：${sensors.data.length} 个`)

    // 写防护：测试环境放行判断（不真正下发），生产配置拦截
    expect(checkWrite('ctrl-206', [online[0].id]).ok).toBe(true)

    // 只断言布尔值，失败时日志里不会出现令牌原文
    const before = readTokens()!
    const after = await refreshSession()
    const rotated = after.refreshToken !== before.refreshToken && after.accessToken !== before.accessToken
    expect(rotated, '刷新后令牌应轮换').toBe(true)
    const sameUser = (await me()).user_entity?.id === m.user_entity?.id
    expect(sameUser, '刷新后 /me 应是同一用户').toBe(true)
  }, 60_000)

  it('经销商账号：login → me(type=1) → projects', async () => {
    clearTokens()
    const acct = readAccount('hengjing-dealer')
    // 测试经销商账号传 isdp=true 会被拒（实测记录 Q3），后端修好前临时传 false
    await login(acct.mobile, acct.password, { isdp: false })
    const m = await me()
    expect(isDealer(m.user_entity)).toBe(true)
    const r = await request<{ project_entities?: unknown[] }>('/projects', { body: {} })
    console.log(`经销商可见项目 ${r.project_entities?.length ?? 0} 个`)
    expect(r.project_entities?.length ?? 0).toBeGreaterThan(0)
    clearTokens()
  }, 60_000)
})
