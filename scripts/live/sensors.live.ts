// 室内空气传感器（S8）只读联调（手动运行：npx vitest run --config vitest.live.config.ts scripts/live/sensors.live.ts，
// 仅限 macOS 本机，不进 CI）。账号从钥匙串读取（hengjing-test-platform / hengjing-test-dealer），不打印密码和令牌。
// 只调只读接口：login、/me、/ctrl/projects、ctrl 207、208。走页面同一套数据源、映射和统计（src/data/sensors）。
// 注意：后端每个用户只有一个有效 refresh_token，每次登录都会挤掉该账号别处的会话。
import { describe, expect, it } from 'vitest'
import { getConfig, setConfig, TEST_API_ORIGIN } from '../../src/api/config'
import { isApiError } from '../../src/api/errors'
import { request } from '../../src/api/http'
import { __resetSessionForTests, can, signIn } from '../../src/api/session'
import { clearTokens } from '../../src/api/tokens'
import { chartSeries, METRIC_KEYS, realSensorSource, SENSOR_ROUTES, summarize, timeLabel, toAirSensors, toHourPoints, windowOf, type SensorRange } from '../../src/data/sensors'
import { readAccount } from './keychain'

setConfig({ apiBase: TEST_API_ORIGIN, dataSource: 'real' })
if (getConfig().apiEnv !== 'test') throw new Error('联调脚本只允许连测试环境')

const TEST_CODES = ['260911001', '240829001']
const LIMITS = { temp: { lo: 24, hi: 27 }, hum: { lo: 40, hi: 60 }, dew: { hi: 17 }, pm25: { hi: 35 }, co2: { hi: 1000 } }
interface CtrlProject { id: string; code?: string; name?: string; online?: boolean; app_code?: string | number }

async function login(service: string) {
  clearTokens(); __resetSessionForTests()
  const acct = readAccount(service)
  console.log(`[${service}] 登录时间 ${new Date().toISOString()}`)
  return signIn(acct.mobile, acct.password, false)
}

describe('S8 空气传感器只读联调', () => {
  it('平台账号：测试项目的 207 / 208（24 小时 / 7 日 / 30 日）', async () => {
    await login('hengjing-test-platform')
    expect(can(SENSOR_ROUTES.live)).toBe(true)
    expect(can(SENSOR_ROUTES.hours)).toBe(true)
    const r = await request<{ project_entities?: CtrlProject[] }>('/ctrl/projects', { body: {} })
    const targets = (r.project_entities ?? []).filter((p) => TEST_CODES.includes(p.code ?? ''))
    for (const p of targets) {
      const tag = `${p.code}（app_code ${p.app_code ?? '缺'}，${p.online === true ? '在线' : '离线'}）`
      let raw
      try {
        raw = await realSensorSource.live(p.id)
      } catch (e) {
        console.log(`${tag} 207 失败：${isApiError(e) ? `${e.kind} ${e.status ?? ''} ${e.message}` : e}`)
        continue
      }
      const sensors = toAirSensors(raw)
      console.log(`${tag} 207：${sensors.length} 个`, JSON.stringify(raw))
      for (const s of sensors.filter((x) => x.online)) {
        for (const range of ['24小时', '7日', '30日'] as SensorRange[]) {
          const w = windowOf(range, Date.now())
          const t0 = Date.now()
          try {
            const recs = await realSensorSource.hours(p.id, s.id, w.start, w.end)
            const pts = toHourPoints(recs, s.id, w)
            const sum = METRIC_KEYS.map((k) => summarize(pts, k, LIMITS[k])).filter(Boolean)
            const ch = chartSeries(pts, 'temp', w)
            console.log(`  ${s.name}(${s.id}) ${range}：start ${w.start}（${timeLabel(w.start)}）end ${w.end}，原始 ${recs.length} 条，窗口内 ${pts.length} 小时，耗时 ${Date.now() - t0}ms`)
            console.log(`    记录 date/hour：${recs.slice(0, 4).map((x) => `${x.date}/${x.hour}`).join(' ')}${recs.length > 4 ? ' …' : ''}`)
            console.log(`    汇总：${sum.map((x) => `${x!.key} avg ${x!.avg.toFixed(1)} max ${x!.max} min ${x!.min} 达标 ${x!.pct}% n ${x!.n}`).join('；')}`)
            console.log(`    图：${ch.labels.length} 个槽位，有数据 ${(ch.hourly ?? ch.daily!.avg).filter((v) => v !== null).length} 个`)
            for (const x of recs) expect(String(x.date)).toHaveLength(13) // 毫秒
          } catch (e) {
            console.log(`  ${s.name} ${range} 208 失败：${isApiError(e) ? `${e.kind} ${e.message}` : e}`)
          }
        }
      }
    }
    clearTokens()
  }, 120_000)

  it('经销商账号：207 / 208 权限', async () => {
    await login('hengjing-test-dealer')
    console.log(`经销商 can 207=${can(SENSOR_ROUTES.live)} 208=${can(SENSOR_ROUTES.hours)}`)
    clearTokens()
  }, 60_000)
})
