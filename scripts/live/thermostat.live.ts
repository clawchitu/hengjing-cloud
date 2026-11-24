// S9 温控面板联调（手动运行：npx vitest run --config vitest.live.config.ts scripts/live/thermostat.live.ts）。
// 只读：login（isdp=true）、/me、/ctrl/projects、ctrl 200、ctrl 209。不调任何写接口（201 / 206 等），也不调 refresh / invalidate。
// 钥匙串服务名默认 hengjing-test-platform，可用 HJC_KEYCHAIN_ADMIN 覆盖。登录会挤掉别处同账号的会话，脚本只登录一次并打印登录时间。
// 只打印数量、设备 ID、设定值与布尔值，不打印令牌、手机号和密码。
import { describe, expect, it } from 'vitest'
import { callCtrl } from '../../src/api/ctrl'
import { getConfig, setConfig, TEST_API_ORIGIN } from '../../src/api/config'
import { checkWrite } from '../../src/api/guard'
import { __resetSessionForTests, signIn } from '../../src/api/session'
import { clearTokens } from '../../src/api/tokens'
import { capabilitiesOf } from '../../src/data/org/capabilities'
import { realSource as orgSource } from '../../src/data/org/sources'
import { buildRoomSwitch, editBlock, realSource, toRoomViews, windLabel, type EditCtx } from '../../src/features/thermostat'
import { readAccount } from './keychain'

setConfig({ apiBase: TEST_API_ORIGIN, dataSource: 'real' })
if (getConfig().apiEnv !== 'test') throw new Error('联调脚本只允许连测试环境')

const SERVICE = process.env.HJC_KEYCHAIN_ADMIN || 'hengjing-test-platform'
const CODE = '240829001'

describe('S9 温控面板（测试环境，只读）', () => {
  it(`${SERVICE}：项目 ${CODE} 的 ctrl 200 映射与 209 统计`, async () => {
    clearTokens(); __resetSessionForTests()
    const acct = readAccount(SERVICE)
    console.log(`登录时间：${new Date().toISOString()}（${SERVICE}）`)
    await signIn(acct.mobile, acct.password, false)
    const ctx = { user: { username: '', name: '', org: '', role: 'admin', roleLabel: '' } as const, dealerAccount: false }
    const projects = await orgSource.projects(ctx, {})
    const p = projects.find((x) => x.code === CODE)
    expect(p, `找到项目 ${CODE}`).toBeTruthy()
    console.log(`项目 ${CODE}：app_code ${p!.programCode}，温控 ${capabilitiesOf(p!.programCode).thermostat}，在线 ${p!.online}`)
    // 写防护判断（纯函数，不发请求）：测试环境 + 默认名单应放行这个项目
    console.log(`写防护对 ${CODE}：${JSON.stringify(checkWrite('ctrl-201', [p]))}`)
    if (!p!.online) { console.log('项目离线，跳过 ctrl 读取'); clearTokens(); return }

    const raw = await callCtrl(200, p!.id, {})
    const rooms = toRoomViews(raw)
    // 与页面同一口径：项目在线、这次 200 读取成功
    const ectx: EditCtx = { online: p!.online === true, fresh: true }
    console.log(`ctrl 200：原始 ${raw.data.length} 条，映射 ${rooms.length} 个房间`)
    for (const r of rooms) {
      console.log(`  ${r.key} ${r.name}：开关 ${r.on ? '开' : '关'}，连接 ${r.connected}，室温 ${r.temp}，湿度 ${r.humidity}，露点 ${r.dew}，设定 ${r.setTemp}，风速 ${windLabel(r.windSpeed)}（原值 ${raw.data.find((x) => String(x.id) === r.key)?.windSpeed}），节能 ${r.eco}，模式 ${r.mode}，可设置：${editBlock(r, ectx) ?? '是'}`)
      console.log(`    末端：${r.endModes.map((m) => `${m.name}(type ${m.type}) ${m.selected ? '蓝' : '灰'} ${m.on ? '开' : '关'}`).join('，') || '无'}`)
      // 只组装不发送：看一眼开关 Query 的形状
      console.log(`    （示例，未发送）开关 Query：${JSON.stringify(buildRoomSwitch(r, !r.on, ectx))}`)
    }
    expect(rooms.length).toBe(raw.data.length)

    if (rooms[0]) {
      for (const range of ['24小时', '7日'] as const) {
        const d = await realSource.stats(p!.id, rooms[0], range)
        const valid = d.rows.filter((row) => row[0] !== null).length
        console.log(`ctrl 209（${range}）：${d.xs.length} 个点，有温度的 ${valid} 个，首尾 ${d.xs[0]} … ${d.xs.at(-1)}`)
      }
    }
    clearTokens()
  }, 60_000)
})
