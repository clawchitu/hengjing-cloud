// @vitest-environment jsdom
// S10c 新风：刷新恢复的 204 写锁由 verifier204 核对（OrgGate 在组织数据就绪后注册）。写锁只在模块初始化时从 localStorage 恢复，
// 所以先写好记录，再 vi.resetModules() 重新加载整套应用模块（等同刷新页面）。只用假后端，不发任何写请求。
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { fakeBackend, json } from '../api/__tests__/helpers'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub, n: 1 }))}.s`
const P12 = { id: '6aa3a0ade8f3372b86b15b05', code: '260911001', name: '独立空气系统测试', app_code: '12', online: true, control_screen_id: 'SCREEN-T' }
const ID = 1514027092
const KEY = 'screen:SCREEN-T'
const UNIT = { id: ID, name: 'TXFS500', switch: 1, isConnected: true }
const S210 = (o: object = {}) => ({ id: ID, name: 'TXFS500', controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 2, switch: 1, canChange: false, ...o })

async function reloadWith(target: Record<string, number>, r210: () => object) {
  const { STORAGE_PREFIX } = await import('../api/writeLock')
  localStorage.setItem(STORAGE_PREFIX + KEY, JSON.stringify({ v: 1, op: 'before-refresh', keys: [KEY, 'project:' + P12.id], projectId: P12.id, userId: 'admin-1', sentAt: Date.now() - 1000, msg: 204, deviceId: ID, target }))
  vi.resetModules()
  const [{ setConfig }, { createQueryClient }, { signIn }, { AppProvider }, { OrgGate }, { default: Layout }, { default: FreshAir }, rq, router, { FRESH_ROUTES }] = await Promise.all([
    import('../api/config'), import('../api/query'), import('../api/session'), import('../app/store'), import('../app/OrgGate'),
    import('../components/Layout'), import('./FreshAir'), import('@tanstack/react-query'), import('react-router-dom'), import('../features/freshAir'),
  ])
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
  const be = fakeBackend({
    '/auth/login': () => json({ access_token: jwt('admin-1'), refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: [FRESH_ROUTES.units, FRESH_ROUTES.settings, FRESH_ROUTES.write] }),
    '/ctrl/projects': () => json({ project_entities: [P12] }),
    '/integrated-projects': () => json({ entities: [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: [P12.id] }] }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    '/ctrl/fresh-dehumidifier-get': () => json({ body: encodeMessage(pb.FreshDehumidifierGetReplySchema, { data: [UNIT] }) }),
    '/ctrl/running-ctrl-get': () => json({ body: encodeMessage(pb.RunningCtrlGetReplySchema, r210()) }),
  })
  localStorage.setItem('hjc-project', P12.id)
  await signIn('u', 'pw', true)
  const client = createQueryClient()
  render(createElement(rq.QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(router.MemoryRouter, { initialEntries: ['/fresh-air'] },
      createElement(router.Routes, null,
        createElement(router.Route, { element: createElement(OrgGate, null, createElement(Layout)) },
          createElement(router.Route, { path: '/fresh-air', element: createElement(FreshAir) }),
        ))))))
  return be
}
const lockBar = () => waitFor(() => { const b = document.querySelector('[data-lock="unknown"]') as HTMLElement; expect(b).toBeTruthy(); return b })
const fakeClock = () => vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
async function runRetries() {
  const { RETRY_DELAYS_MS } = await import('../api/writeLock')
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  for (const d of RETRY_DELAYS_MS) await act(async () => { await vi.advanceTimersByTimeAsync(d); await new Promise((r) => setTimeout(r, 30)) })
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

describe('刷新恢复的 204 锁', () => {
  it('回读风速一致（control_type = -1，露点 / 湿度读到 -1 不比对）：核对器放锁，不发写请求', async () => {
    const be = await reloadWith({ controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 1, switch: -1 }, () => S210({ windSpeed: 1 }))
    await screen.findByText('实时数据', { exact: false })
    await waitFor(() => expect(be.callsTo('/ctrl/running-ctrl-get').length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    expect(be.calls.filter((c) => /-set$/.test(c.url))).toHaveLength(0)
  })

  it('回读不一致：退避用完后锁提示逐项列出「风速：未生效」', async () => {
    fakeClock()
    await reloadWith({ controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 1, switch: -1 }, () => S210({ windSpeed: 2 }))
    await screen.findByText('实时数据', { exact: false })
    await runRetries()
    const bar = await waitFor(async () => { const b = await lockBar(); expect(b.querySelector('[data-field]')).toBeTruthy(); return b })
    expect(bar.textContent).toContain('指令已下发，设备状态暂未变化')
    expect([...bar.querySelectorAll('[data-field]')].map((li) => li.textContent)).toEqual(['风速：未生效（设备状态暂未变化）'])
  })
})
