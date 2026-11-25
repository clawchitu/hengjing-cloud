// @vitest-environment jsdom
// S6b：首页统计卡、常用项目、切换项目时的点击上报、切换失败的两种原因，以及新增的只读接口。只用假后端。
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../../../api/config'
import { isWritePath } from '../../../api/guard'
import { __resetHttpForTests } from '../../../api/http'
import { getFrequentProjects, getIntegratedProjectStat, reportProjectClick } from '../../../api/pcfg'
import { createQueryClient } from '../../../api/query'
import { __resetSessionForTests, signIn } from '../../../api/session'
import { clearTokens, writeTokens } from '../../../api/tokens'
import { fakeBackend, json, text, type Call } from '../../../api/__tests__/helpers'
import { __resetSessionViewForTests, mockSignIn } from '../../session'
import { __resetCurrentForTests, PROJECT_KEY } from '../current'
import { SET_PROJECT_FAIL_TEXT, useCurrentProject, useFrequentProjects, useOrgStat, whenProjectSet } from '../hooks'

type Route = (call: Call, n: number) => Response | Promise<Response>
const PROJECTS = [
  { id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', online: true },
  { id: 'p2', code: '260911001', name: '独立空气系统测试', app_code: '12' },
  { id: 'p3', code: '221031001', name: '科希家办公室', app_code: '1' },
  { id: 'p9', code: '999999999', name: '不在任何集成项目里', app_code: '1' },
]
const GROUPS = [
  { id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p1', 'p3'] },
  { id: 'g2', code: '3', name: '单机版', distributor_id: 'D1', project_ids: ['p2', 'p1'] },
]
const ALL_PATHS = ['/v1/projects/frequent', '/v1/project/click/{id}', '/v1/integrated-projects/stat']
function backend(routes: Record<string, Route> = {}, paths: string[] = ALL_PATHS) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: 'x' }, permission_paths: paths }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    ...routes,
  })
}
function wrapper() {
  const client = createQueryClient()
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return { client, wrapper: Wrapper }
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null) })

describe('只读接口（pcfg.ts）', () => {
  beforeEach(() => writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3600_000 }, true))

  it('统计：int64 是字符串，转成数字；缺 project_offline 时按 total - online 算', async () => {
    const be = fakeBackend({ '/integrated-projects/stat': (_c, n) => json(n === 1 ? { total: '3', project_total: '3', project_online: '2', project_offline: '1' } : { total: '2', project_total: '5', project_online: '1' }) })
    expect(await getIntegratedProjectStat()).toEqual({ total: 3, projectTotal: 3, projectOnline: 2, projectOffline: 1 })
    expect(await getIntegratedProjectStat()).toEqual({ total: 2, projectTotal: 5, projectOnline: 1, projectOffline: 4 })
    expect(be.callsTo('/integrated-projects/stat')[0]).toMatchObject({ method: 'POST', body: {} })
  })

  it('常用项目：POST /projects/frequent { limit }；没有点击记录时后端返回 {} → 空列表', async () => {
    const be = fakeBackend({ '/projects/frequent': (_c, n) => json(n === 1 ? {} : { project_entities: [{ id: 'p1' }], total: '1' }) })
    expect(await getFrequentProjects(20)).toEqual([])
    expect((await getFrequentProjects(20)).map((e) => e.id)).toEqual(['p1'])
    expect(be.callsTo('/projects/frequent')[0].body).toEqual({ limit: 20 })
  })

  it('点击上报：POST /project/click/{id} body {}；不是写接口路径；不合法的 id 不拼进路径', async () => {
    const be = fakeBackend({ '/project/click/66cfd7959fb60d63c917fd0a': () => json({}) })
    expect(isWritePath('/project/click/66cfd7959fb60d63c917fd0a')).toBe(false)
    await reportProjectClick('66cfd7959fb60d63c917fd0a')
    expect(be.calls[0]).toMatchObject({ method: 'POST', body: {} })
    expect(be.calls[0].url).toBe('/api/project/click/66cfd7959fb60d63c917fd0a')
    for (const bad of ['../ctrl/unified-ctrls-send', 'a/b', 'a b', '', 'x%2f']) await expect(reportProjectClick(bad)).rejects.toMatchObject({ kind: 'bad_request' })
    expect(be.calls.length).toBe(1)
  })
})

describe('切换项目：点击上报', () => {
  it('切换成功后上报 POST /project/click/{id}，完成后 selectTick 加一', async () => {
    const be = backend({ '/project/click/p3': () => json({}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    const t0 = result.current.selectTick
    act(() => { expect(result.current.setProjectId('p3')).toBe(true) })
    await waitFor(() => expect(result.current.selectTick).toBe(t0 + 1))
    expect(be.callsTo('/project/click/p3')).toHaveLength(1)
    expect(be.callsTo('/project/click/p3')[0].body).toEqual({})
  })

  it('没有该路由的权限：不发上报，切换照常成功', async () => {
    const be = backend({}, [])
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    act(() => { expect(result.current.setProjectId('p3')).toBe(true) })
    await flush()
    expect(be.calls.filter((c) => c.url.includes('/project/click/'))).toEqual([])
    expect(localStorage.getItem(PROJECT_KEY)).toBe('p3')
  })

  it('上报失败只记日志：切换不回滚，selectTick 不变', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend({ '/project/click/p3': () => text('no permission', 403) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    const t0 = result.current.selectTick
    act(() => { result.current.setProjectId('p3') })
    await flush()
    expect(result.current.project?.id).toBe('p3')
    expect(result.current.selectTick).toBe(t0)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('点击上报失败'))).toBe(true)
  })

  it('范围外的项目不上报', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const be = backend({ '/project/click/p9': () => json({}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    act(() => { result.current.setProjectId('p9') })
    await flush()
    expect(be.callsTo('/project/click/p9')).toEqual([])
  })
})

describe('切换项目：失败原因', () => {
  it('范围外：先「正在刷新」（刷新进行中再点也是，不重复刷新）；两份刷新都成功后仍不在范围里 →「无权查看」', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release = () => {}
    let hold = false
    const be = backend({
      '/ctrl/projects': async () => { if (hold) await new Promise<void>((r) => { release = r }); return json({ project_entities: PROJECTS }) },
    })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    const n0 = be.callsTo('/ctrl/projects').length
    hold = true
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
    await flush()
    expect(be.callsTo('/ctrl/projects').length).toBe(n0 + 1) // 只刷新了一次
    hold = false
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)) })
    act(() => { expect(result.current.setProjectId('p9')).toBe('forbidden') })
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull()
    // 文案
    const fail = vi.fn()
    whenProjectSet('forbidden', () => {}, fail)
    whenProjectSet('refreshing', () => {}, fail)
    expect(fail.mock.calls).toEqual([['无权查看该项目'], ['项目列表正在刷新，请稍后重试']])
    expect(SET_PROJECT_FAIL_TEXT.refreshing).toBe('项目列表正在刷新，请稍后重试')
  })

  it('刷新失败（旧数据保留）不算确认：下次再点仍是「正在刷新」并重新刷新', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let fail = false
    const be = backend({ '/integrated-projects': () => (fail ? text('no permission', 403) : json({ entities: GROUPS })) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    fail = true
    const n0 = be.callsTo('/integrated-projects').length
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
    await flush()
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
    await flush()
    expect(be.callsTo('/integrated-projects').length).toBe(n0 + 2)
  })

  it('刷新后出现在范围里：再点成功', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let groups = GROUPS
    backend({ '/integrated-projects': () => json({ entities: groups }), '/project/click/p9': () => json({}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    groups = [...GROUPS, { id: 'g3', code: '4', name: '新组', distributor_id: 'D1', project_ids: ['p9'] }]
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
    await flush()
    act(() => { expect(result.current.setProjectId('p9')).toBe(true) })
    expect(result.current.project?.id).toBe('p9')
  })
})

describe('useOrgStat（首页统计卡）', () => {
  it('有权限：用 /integrated-projects/stat 的四个数', async () => {
    backend({ '/integrated-projects/stat': () => json({ total: '3', project_total: '7', project_online: '2', project_offline: '5' }) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgStat(), { wrapper: w })
    await waitFor(() => expect(result.current.source === 'api' && result.current.data).toBeTruthy())
    expect(result.current.data).toEqual({ groups: 3, projects: 7, online: 2, offline: 5 })
  })

  it('加载中 data 为 null（卡片显示占位，不先显示另一套数字）', async () => {
    backend({ '/integrated-projects/stat': () => new Promise<Response>(() => {}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgStat(), { wrapper: w })
    await flush()
    expect(result.current.status).toBe('loading')
    expect(result.current.data).toBeNull()
  })

  it('没有权限：不发请求，按可见范围算（集成项目 2，项目去重 3，在线 1）', async () => {
    const be = backend({}, [])
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgStat(), { wrapper: w })
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.data).toEqual({ groups: 2, projects: 3, online: 1, offline: 2, unknown: 0 })
    expect(result.current.source).toBe('scope')
    expect(be.callsTo('/integrated-projects/stat')).toEqual([])
  })

  it('统计接口失败：退回按可见范围算，错误留在 error', async () => {
    backend({ '/integrated-projects/stat': () => json({ code: 13, message: '统计失败' }, 500) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgStat(), { wrapper: w })
    await waitFor(() => expect(result.current.source).toBe('scope'), { timeout: 3000 })
    expect(result.current.data).toEqual({ groups: 2, projects: 3, online: 1, offline: 2, unknown: 0 })
    expect(result.current.error?.message).toBe('统计失败')
  })
})

describe('useOrgStat：回退口径（接口文档 6.1：project_total = project_ids 去重数）', () => {
  it('关联 id 在项目列表里缺失（实际可能在线）：仍计入总数，但不当离线也不当在线，单独记为未知', async () => {
    backend({ '/integrated-projects': () => json({ entities: [...GROUPS, { id: 'g3', code: '4', name: '有缺失', distributor_id: 'D1', project_ids: ['p1', 'gone1', 'gone2'] }] }) }, [])
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useOrgStat(), { wrapper: w })
    await waitFor(() => expect(result.current.data).not.toBeNull())
    // p1、p2、p3 + gone1、gone2 = 5；已知在线 p1，已知离线 p2、p3；gone1、gone2 状态未知（可能在线），不算进离线
    expect(result.current.data).toEqual({ groups: 3, projects: 5, online: 1, offline: 2, unknown: 2 })
  })
})

describe('切换项目：重复选择与「无权查看」的失效', () => {
  it('再选当前项目：成功但不上报点击', async () => {
    const be = backend({ '/project/click/p3': () => json({}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    act(() => { result.current.setProjectId('p3') })
    await flush()
    act(() => { expect(result.current.setProjectId('p3')).toBe(true) })
    await flush()
    expect(be.callsTo('/project/click/p3')).toHaveLength(1)
  })

  it('没有保存的当前项目时，点回退显示的项目（第一个可见项目）是真实选择：写入存储并上报（约定）', async () => {
    const be = backend({ '/project/click/p1': () => json({}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull() // 回退显示，未存储
    act(() => { expect(result.current.setProjectId('p1')).toBe(true) })
    await flush()
    expect(localStorage.getItem(PROJECT_KEY)).toBe('p1')
    expect(be.callsTo('/project/click/p1')).toHaveLength(1)
  })

  async function forbiddenP9(groups: { current: typeof GROUPS }) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend({ '/integrated-projects': () => json({ entities: groups.current }), '/project/click/p9': () => json({}) })
    await signIn('u', 'pw', true)
    const { client, wrapper: w } = wrapper()
    const { result } = renderHook(() => useCurrentProject(), { wrapper: w })
    await waitFor(() => expect(result.current.project?.id).toBe('p1'))
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
    await flush()
    act(() => { expect(result.current.setProjectId('p9')).toBe('forbidden') })
    return { client, result }
  }

  it('先无权、随后获得权限：组织范围更新后「无权」结论作废，再选成功', async () => {
    const groups = { current: GROUPS }
    const { client, result } = await forbiddenP9(groups)
    groups.current = [...GROUPS, { id: 'g3', code: '4', name: '新授权', distributor_id: 'D1', project_ids: ['p9'] }]
    await act(async () => { await client.refetchQueries({ queryKey: ['org'] }); await new Promise((r) => setTimeout(r, 20)) })
    act(() => { expect(result.current.setProjectId('p9')).toBe(true) })
  })

  it('组织范围有变化（即使目标仍不在范围里）：之前的「无权」结论作废，再选会重新刷新确认', async () => {
    const groups = { current: GROUPS }
    const { client, result } = await forbiddenP9(groups)
    groups.current = [...GROUPS, { id: 'g3', code: '4', name: '别的组', distributor_id: 'D1', project_ids: ['p2'] }]
    await act(async () => { await client.refetchQueries({ queryKey: ['org'] }); await new Promise((r) => setTimeout(r, 20)) })
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
  })

  it('组织范围没变但过了 60 秒：不再直接判无权，重新刷新', async () => {
    const groups = { current: GROUPS }
    const { result } = await forbiddenP9(groups)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    act(() => { expect(result.current.setProjectId('p9')).toBe('refreshing') })
  })
})

describe('useFrequentProjects（首页常用项目）', () => {
  it('只留可见范围里的项目（去重、保持后端顺序、最多 4 个），项目对象取自组织范围', async () => {
    const be = backend({ '/projects/frequent': () => json({ project_entities: [{ id: 'p9' }, { id: 'p3' }, { id: 'gone' }, { id: 'p1' }, { id: 'p3' }, { id: 'p2' }] }) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useFrequentProjects(2), { wrapper: w })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.data.map((f) => [f.project.id, f.project.code])).toEqual([['p3', '221031001'], ['p1', '240829001']])
    expect(be.callsTo('/projects/frequent')[0].body).toEqual({ limit: 20 })
  })

  it('空：成功且 isEmpty；没有权限：permitted=false 且不发请求', async () => {
    const be = backend({ '/projects/frequent': () => json({}) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useFrequentProjects(), { wrapper: w })
    await waitFor(() => expect(result.current.isEmpty).toBe(true))
    expect(result.current.permitted).toBe(true)
    expect(be.callsTo('/projects/frequent')).toHaveLength(1)
  })

  it('没有权限：permitted=false，不发请求', async () => {
    const be = backend({ '/projects/frequent': () => json({}) }, [])
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useFrequentProjects(), { wrapper: w })
    await flush()
    expect(result.current.permitted).toBe(false)
    expect(be.callsTo('/projects/frequent')).toEqual([])
  })

  it('失败：status=error 并带错误，重试成功', async () => {
    let fail = true
    backend({ '/projects/frequent': () => (fail ? json({ code: 13, message: '查询失败' }, 500) : json({ project_entities: [{ id: 'p1' }] })) })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useFrequentProjects(), { wrapper: w })
    await waitFor(() => expect(result.current.status).toBe('error'), { timeout: 3000 })
    expect(result.current.error?.message).toBe('查询失败')
    fail = false
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.data.map((f) => f.project.id)).toEqual(['p1']))
  })

  it('切换项目上报完成后重取，重取期间保留上一份结果', async () => {
    let list = [{ id: 'p1' }]
    let release = () => {}
    const be = backend({
      '/projects/frequent': async (_c, n) => { if (n > 1) await new Promise<void>((r) => { release = r }); return json({ project_entities: list }) },
      '/project/click/p3': () => json({}),
    })
    await signIn('u', 'pw', true)
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => ({ f: useFrequentProjects(), c: useCurrentProject() }), { wrapper: w })
    await waitFor(() => expect(result.current.f.data.map((f) => f.project.id)).toEqual(['p1']))
    list = [{ id: 'p3' }, { id: 'p1' }]
    act(() => { result.current.c.setProjectId('p3') })
    await waitFor(() => expect(be.callsTo('/projects/frequent')).toHaveLength(2))
    expect(result.current.f.data.map((f) => f.project.id)).toEqual(['p1']) // 重取中：旧结果
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)) })
    expect(result.current.f.data.map((f) => f.project.id)).toEqual(['p3', 'p1'])
  })

  it('演示数据：本地计数，只留可见范围（经销商看不到管理员的项目）', async () => {
    setConfig({ dataSource: 'mock' })
    localStorage.setItem('hjc-mock-select-counts', JSON.stringify({ cosyhome: { 'PRJ-50101': 99, 'PRJ-10242': 3, 'PRJ-10241': 5 } }))
    mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
    const be = fakeBackend({})
    const { wrapper: w } = wrapper()
    const { result } = renderHook(() => useFrequentProjects(), { wrapper: w })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.data.map((f) => [f.project.id, f.count])).toEqual([['PRJ-10241', 5], ['PRJ-10242', 3]])
    expect(be.fetchMock).not.toHaveBeenCalled()
  })
})

