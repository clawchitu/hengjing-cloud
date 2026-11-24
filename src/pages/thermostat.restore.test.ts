// @vitest-environment jsdom
// S9 温控：刷新恢复的写锁（#35 Codex 第 3 条）。写锁只在模块初始化时从 localStorage 恢复记录，所以每条用例先写好记录，
// 再 vi.resetModules() 重新加载整套应用模块（等同刷新页面）。只用假后端，绝不连真实后端、不发任何写请求。
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
const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001', name: '测试项目0829', app_code: '1', app_name: '通用版', online: true, control_screen_id: 'SCREEN-T' }
const ENDS = [{ optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 }]
const ROOM = { id: 406658286, name: '客厅', temperature: 25.8, humidity: 51, dewPoint: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0, switch: 1, mode: 0, isConnected: true, endModes: ENDS }
const reply200 = (rooms: object[]) => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: rooms }) })
const KEY = 'screen:SCREEN-T'

/** 写一条「刷新前」留下的锁记录，然后重新加载应用模块并挂载温控页（等同刷新） */
async function reloadWith(userId: string, target: Record<string, number>, read200: () => Response) {
  const { STORAGE_PREFIX } = await import('../api/writeLock')
  localStorage.setItem(STORAGE_PREFIX + KEY, JSON.stringify({ v: 1, op: 'before-refresh', keys: [KEY, 'project:' + P1.id], projectId: P1.id, userId, sentAt: Date.now() - 1000, msg: 201, deviceId: ROOM.id, target }))
  vi.resetModules()
  const [{ setConfig }, { createQueryClient }, { signIn }, { AppProvider }, { OrgGate }, { default: Layout }, { default: Thermostat }, rq, router] = await Promise.all([
    import('../api/config'), import('../api/query'), import('../api/session'), import('../app/store'), import('../app/OrgGate'),
    import('../components/Layout'), import('./Thermostat'), import('@tanstack/react-query'), import('react-router-dom'),
  ])
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
  const be = fakeBackend({
    '/auth/login': () => json({ access_token: jwt('admin-1'), refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: [] }),
    '/ctrl/projects': () => json({ project_entities: [P1] }),
    '/integrated-projects': () => json({ entities: [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: [P1.id] }] }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    '/apps': () => json({}),
    '/ctrl/room-temperature-data-get': read200,
    '/ctrl/room-temperature-data-hour-get': () => json({ body: '' }),
  })
  localStorage.setItem('hjc-project', P1.id)
  await signIn('u', 'pw', true)
  const client = createQueryClient()
  render(createElement(rq.QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(router.MemoryRouter, { initialEntries: ['/thermostat'] },
      createElement(router.Routes, null,
        createElement(router.Route, { element: createElement(OrgGate, null, createElement(Layout)) },
          createElement(router.Route, { path: '/thermostat', element: createElement(Thermostat) }),
        ))))))
  return be
}
const lockBar = () => waitFor(() => { const b = document.querySelector('[data-lock="unknown"]') as HTMLElement; expect(b).toBeTruthy(); return b })
const items = (b: HTMLElement) => [...b.querySelectorAll('[data-field]')].map((li) => li.textContent)

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

describe('刷新恢复的锁：锁提示逐字段四态', () => {
  it('混合：总标题按优先级（未变化），带计数「1 项未生效，1 项无法核对」，并逐项列出；不发写请求', async () => {
    const be = await reloadWith('admin-1', { temperature: 26, eco: 1, switch: -1 }, () => reply200([{ ...ROOM, eco: 65536 }]))
    await screen.findByText('客厅')
    const bar = await waitFor(async () => { const b = await lockBar(); expect(b.querySelector('[data-lock-fields]')).toBeTruthy(); return b })
    expect(bar.textContent).toContain('：指令已下发，设备状态暂未变化（1 项未生效，1 项无法核对）')
    expect(items(bar)).toEqual(['设定温度：未生效（设备状态暂未变化）', '节能模式：暂无回读，无法确认'])
    expect(be.calls.filter((c) => /-set$/.test(c.url))).toHaveLength(0)
  })

  it('单字段一致以外：标题即该态，仍逐项列出（无法核对）', async () => {
    await reloadWith('admin-1', { temperature: 26, eco: -1, switch: -1 }, () => reply200([]))
    const bar = await waitFor(async () => { const b = await lockBar(); expect(b.querySelector('[data-field]')).toBeTruthy(); return b })
    expect(bar.textContent).toContain('：该项暂无回读，无法确认。')
    expect(bar.textContent).not.toContain('项无法核对）') // 单一状态不附计数
    expect(items(bar)).toEqual(['设定温度：暂无回读，无法确认'])
  })

  it('回读失败：每个目标字段列为结果未知，标题「已下发，结果未知」', async () => {
    await reloadWith('admin-1', { temperature: 26, eco: 1, switch: -1 }, () => json({ code: 13, message: 'internal' }, 500))
    const bar = await waitFor(async () => { const b = await lockBar(); expect(b.querySelector('[data-field]')).toBeTruthy(); return b })
    expect(bar.textContent).toContain('：已下发，结果未知')
    expect(items(bar)).toEqual(['设定温度：结果未知', '节能模式：结果未知'])
  })

  it('别的账号的恢复锁：只见泛化提示，不列字段、不带目标', async () => {
    await reloadWith('someone-else', { temperature: 26, eco: 1, switch: -1 }, () => reply200([{ ...ROOM, eco: 65536 }]))
    await screen.findByText('客厅')
    const bar = await lockBar()
    await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
    expect(bar.textContent).toContain('上一账号的下发结果未知，请稍后再试或联系有权限的账号')
    expect(bar.querySelector('[data-lock-fields]')).toBeNull()
    expect(bar.textContent).not.toMatch(/设定温度|节能模式|未生效|客厅/)
  })
})
