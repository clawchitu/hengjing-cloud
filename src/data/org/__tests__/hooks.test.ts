// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../../../api/config'
import { __resetHttpForTests } from '../../../api/http'
import { createQueryClient } from '../../../api/query'
import { __resetSessionForTests, signIn } from '../../../api/session'
import { clearTokens } from '../../../api/tokens'
import { fakeBackend, json, text, type Call } from '../../../api/__tests__/helpers'
import { __resetSessionViewForTests, mockSignIn } from '../../session'
import { __resetCurrentForTests, PROJECT_KEY } from '../current'
import { PLATFORM_DEALER_ID } from '../map'
import { useCurrentProject, useDealerPick, useDealers, useIntegratedProjects, useOrgScope, useProjects } from '../hooks'

function wrapper() {
  const client = createQueryClient()
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return { client, wrapper: Wrapper }
}

type Route = (call: Call, n: number) => Response | Promise<Response>
const PROJECTS = [
  { id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', online: true },
  { id: 'p2', code: '260911001', name: '独立空气系统测试', app_code: '12' },
  { id: 'p3', code: '221031001', name: '科希家办公室', app_code: '1' },
]
const GROUPS = [
  { id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p1', 'p3'] },
  { id: 'g2', code: '3', name: '单机版', distributor_id: 'D1', project_ids: ['p2'] },
]
/** 假后端：登录 + 组织数据接口。type=1 为经销商账号 */
function backend(routes: Record<string, Route> = {}, type?: number) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: type === 1 ? 'dealer-1' : 'admin-1', name: 'x', type } }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS, total: 3 }),
    '/integrated-projects': () => json({ entities: GROUPS, total: 2 }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }, { id: 'D2', name: '另一个' }] }),
    ...routes,
  })
}

/** 让某个接口挂起，手动放行（模拟经销商列表晚到） */
function deferred() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { gate, release }
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

describe('mock 数据源（e2e 截图走这里）', () => {
  beforeEach(() => setConfig({ dataSource: 'mock' }))

  it('首屏同步就有数据（initialData），不经过加载态——与拆分前同步算 scope 一致，截图零差异的前提', () => {
    mockSignIn({ username: 'hjadmin', role: 'admin' }, true)
    const be = fakeBackend({})
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgScope(), { wrapper: w })
    expect(result.current.status).toBe('success')
    expect(result.current.data.dealers.length).toBe(3)
    expect(result.current.data.projects.length).toBeGreaterThan(30)
    expect(be.fetchMock).not.toHaveBeenCalled()
  })

  it('经销商账号只见自己的经销商与集成项目', () => {
    mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgScope(), { wrapper: w })
    expect(result.current.data.dealers.map((d) => d.id)).toEqual(['DLR-001'])
    expect(result.current.data.groups.every((g) => g.dealerId === 'DLR-001')).toBe(true)
  })

  it('当前项目：读 hjc-project；失效回退到第一个且不改写存储；切换后写入并在上报后 selectTick 加一', async () => {
    mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
    localStorage.setItem(PROJECT_KEY, 'PRJ-10252')
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    expect(result.current.project?.id).toBe('PRJ-10252')
    // 不在可见范围里的 id 不写进存储（演示 id、管理员才看得到的项目等）
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 不在可见范围里：同步返回 false，不写存储
    act(() => { expect(result.current.setProjectId('PRJ-50101')).toBe(false) })
    expect(localStorage.getItem(PROJECT_KEY)).toBe('PRJ-10252')
    expect(result.current.project?.id).toBe('PRJ-10252')
    warn.mockRestore()
    const t0 = result.current.selectTick
    // 在可见范围里：同步写入并返回 true（演示数据界面时序不变）
    act(() => { expect(result.current.setProjectId('PRJ-30057')).toBe(true) })
    expect(result.current.project?.id).toBe('PRJ-30057')
    await waitFor(() => expect(result.current.selectTick).toBeGreaterThan(t0))
  })

  it('存储里的 id 失效 → 回退到第一个可见项目，且回退不改写存储', () => {
    mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
    localStorage.setItem(PROJECT_KEY, 'PRJ-99999')
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    expect(result.current.project?.id).toBe('PRJ-10241')
    expect(localStorage.getItem(PROJECT_KEY)).toBe('PRJ-99999')
  })

  it('换账号后存储的项目不在新范围里 → 回退到新账号的第一个项目', () => {
    localStorage.setItem(PROJECT_KEY, 'PRJ-50101') // 只有管理员看得到
    mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    expect(result.current.project?.id).toBe('PRJ-10241')
  })
})

describe('真实数据源', () => {
  beforeEach(() => setConfig({ apiBase: '/api', dataSource: 'real' }))

  it('项目列表三态：加载中 → 成功（在线、app_code 已映射）', async () => {
    const d = deferred()
    backend({ '/ctrl/projects': async () => { await d.gate; return json({ project_entities: PROJECTS }) } })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useProjects(), { wrapper: w })
    expect(result.current.status).toBe('loading')
    expect(result.current.data).toEqual([])
    d.release()
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.data.map((p) => [p.code, p.online, p.programCode])).toEqual([['240829001', true, 1], ['260911001', false, 12], ['221031001', false, 1]])
    expect(result.current.isEmpty).toBe(false)
  })

  it('空数据：成功且 isEmpty', async () => {
    backend({ '/ctrl/projects': () => json({}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useProjects(), { wrapper: w })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.isEmpty).toBe(true)
  })

  it('失败：403 no permission → error，kind=forbidden；任一接口失败组织范围即 error', async () => {
    backend({ '/integrated-projects': () => text('no permission', 403) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => ({ g: useIntegratedProjects(), s: useOrgScope() }), { wrapper: w })
    await waitFor(() => expect(result.current.g.status).toBe('error'))
    expect(result.current.g.error?.kind).toBe('forbidden')
    expect(result.current.s.status).toBe('error')
  })

  it('未登录不发请求，状态为 loading', () => {
    const be = backend()
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgScope(), { wrapper: w })
    expect(result.current.status).toBe('loading')
    expect(be.fetchMock).not.toHaveBeenCalled()
  })

  it('平台账号：组织范围只含集成项目里的项目，groupId 已填', async () => {
    backend()
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgScope(), { wrapper: w })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.data.dealers.map((d) => d.id)).toEqual(['D1', 'D2'])
    expect(result.current.data.projects.map((p) => [p.id, p.groupId])).toEqual([['p1', 'g1'], ['p2', 'g2'], ['p3', 'g1']])
  })

  it('经销商账号：不调 /distributors（没有经销商选择器），侧栏分组用集成项目归纳出的经销商', async () => {
    const be = backend({}, 1)
    await signIn('d', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => ({ d: useDealers(), s: useOrgScope() }), { wrapper: w })
    await waitFor(() => expect(result.current.s.status).toBe('success'))
    expect(be.counts['/distributors']).toBeUndefined()
    expect(result.current.d).toMatchObject({ status: 'success', data: [] })
    expect(result.current.s.data.dealers.map((d) => d.id)).toEqual(['D1'])
  })

  it('当前项目：加载中为 null；到达后按 hjc-project 解析', async () => {
    localStorage.setItem(PROJECT_KEY, 'p2')
    const d = deferred()
    backend({ '/ctrl/projects': async () => { await d.gate; return json({ project_entities: PROJECTS }) } })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    expect(result.current.project).toBeNull()
    expect(result.current.status).toBe('loading')
    d.release()
    await waitFor(() => expect(result.current.project?.id).toBe('p2'))
    act(() => { result.current.setProjectId('p3') })
    expect(result.current.project?.id).toBe('p3')
    expect(localStorage.getItem(PROJECT_KEY)).toBe('p3')
    // 后端 id 不在可见范围（不在任何集成项目里）→ 忽略
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    act(() => { expect(result.current.setProjectId('not-visible')).toBe(false) })
    expect(localStorage.getItem(PROJECT_KEY)).toBe('p3')
    warn.mockRestore()
  })

  it('经销商默认值随异步到达（Groups.tsx 的坑）：列表晚到时自动选中第一个，并按它取集成项目', async () => {
    const d = deferred()
    const be = backend({ '/distributors': async () => { await d.gate; return json({ distributor_entities: [{ id: 'D1', name: '甲' }, { id: 'D2', name: '乙' }] }) } })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => {
      const dealers = useDealers().data
      const [dealerId, setDealerId] = useDealerPick(dealers)
      const groups = useIntegratedProjects({ dealerId, enabled: !!dealerId })
      return { dealerId, setDealerId, groups }
    }, { wrapper: w })
    expect(result.current.dealerId).toBe('')
    expect(result.current.groups.data).toEqual([])
    // 经销商列表自己会取一次全部集成项目（判断要不要补「平台」）；按经销商取要等选出经销商
    const byDealer = () => be.callsTo('/integrated-projects').map((c) => c.body as Record<string, unknown>).filter((b) => b.distributor_id)
    expect(byDealer()).toEqual([])
    d.release()
    await waitFor(() => expect(result.current.dealerId).toBe('D1'))
    await waitFor(() => expect(result.current.groups.status).toBe('success'))
    expect(byDealer()).toEqual([{ distributor_id: 'D1' }])
    act(() => result.current.setDealerId('D2'))
    expect(result.current.dealerId).toBe('D2')
    await waitFor(() => expect(byDealer()).toEqual([{ distributor_id: 'D1' }, { distributor_id: 'D2' }]))
  })

  it('后台刷新失败时保留旧数据，不报 error', async () => {
    let fail = false
    backend({ '/ctrl/projects': () => (fail ? text('no permission', 403) : json({ project_entities: PROJECTS })) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useProjects(), { wrapper: w })
    await waitFor(() => expect(result.current.status).toBe('success'))
    fail = true
    await act(async () => { result.current.refetch(); await new Promise((r) => setTimeout(r, 20)) })
    expect(result.current.status).toBe('success')
    expect(result.current.error).toBeNull()
    expect(result.current.staleError?.kind).toBe('forbidden') // 可观察：页面能提示数据可能过期
    expect(result.current.data.length).toBe(3)
  })

  it('/distributors 失败不拖垮组织范围：status 仍 success，错误单独放在 dealersError', async () => {
    backend({ '/distributors': () => text('no permission', 403) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgScope(), { wrapper: w })
    await waitFor(() => expect(result.current.dealersError?.kind).toBe('forbidden'))
    expect(result.current.status).toBe('success')
    expect(result.current.data.projects.length).toBe(3)
  })

  it('平台账号的经销商列表：有没有归属的集成项目时末尾补「平台」', async () => {
    backend({ '/integrated-projects': () => json({ entities: [...GROUPS, { id: 'g0', code: '1', project_ids: ['p1'] }] }) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useDealers(), { wrapper: w })
    await waitFor(() => expect(result.current.data.map((d) => d.id)).toEqual(['D1', 'D2', PLATFORM_DEALER_ID]))
  })
})

describe('useDealerPick', () => {
  it('列表为空 → 空串；到达 → 第一个；选过的保留；选的消失 → 回到第一个', () => {
    const { result, rerender } = renderHook(({ ds }) => useDealerPick(ds), { initialProps: { ds: [] as { id: string }[] } })
    expect(result.current[0]).toBe('')
    rerender({ ds: [{ id: 'A' }, { id: 'B' }] })
    expect(result.current[0]).toBe('A')
    act(() => result.current[1]('B'))
    expect(result.current[0]).toBe('B')
    rerender({ ds: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] })
    expect(result.current[0]).toBe('B')
    rerender({ ds: [{ id: 'A' }] })
    expect(result.current[0]).toBe('A')
  })
})
