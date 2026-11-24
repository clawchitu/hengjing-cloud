// @vitest-environment jsdom
// S6b 页面级用例（真实数据形状，只用假后端）：集成项目页去掉按钮、经销商可搜索下拉、三态与应用名称；
// 首页统计卡与常用项目；侧栏在经销商列表失败、后台刷新失败时的提示。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json, text, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import Layout from '../components/Layout'
import Groups from './Groups'
import Home from './Home'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

type Handler = (call: Call, n: number) => Response | Promise<Response>
const PROJECTS = [
  { id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', app_name: '通用版', online: true },
  { id: 'p2', code: '260911001', name: '独立空气系统测试', app_code: '12', app_name: '独立空气系统' },
  { id: 'p3', code: '221031001', name: '科希家办公室', app_code: '1', app_name: '通用版', app_category_name: '五恒' },
  { id: 'p4', code: '261124001', name: '南京的项目', app_code: '1' },
]
const GROUPS = [
  { id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', app_id: 'A1', project_ids: ['p1', 'p3'], created_at: '2026-11-24 07:49:41' },
  { id: 'g2', code: '3', name: '单机版', distributor_id: 'D1', app_id: 'A12', project_ids: ['p2'] },
  { id: 'g4', code: '4', name: '南京集成项目', distributor_id: 'D2', project_ids: ['p4'] },
]
const DEALERS = [{ id: 'D1', name: '科希家研发苏州main', code: 'KXJ01' }, { id: 'D2', name: '南京舒适家', code: 'NJ02' }]
const PATHS = ['/v1/projects/frequent', '/v1/project/click/{id}', '/v1/integrated-projects/stat']
function backend(routes: Record<string, Handler> = {}, opts: { type?: number; paths?: string[] } = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: opts.type === 1 ? 'dealer-1' : 'admin-1', name: '测试', type: opts.type }, permission_paths: opts.paths ?? PATHS }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    '/integrated-projects': (c) => {
      const d = (c.body as Record<string, unknown> | undefined)?.distributor_id
      return json({ entities: d ? GROUPS.filter((g) => g.distributor_id === d) : GROUPS })
    },
    '/distributors': () => json({ distributor_entities: DEALERS }),
    '/apps': () => json({ app_entities: [{ id: 'A1', code: '1', name: '通用版' }, { id: 'A12', code: '12', name: '独立空气系统' }] }),
    '/projects/frequent': () => json({}),
    '/integrated-projects/stat': () => json({ total: '3', project_total: '4', project_online: '1', project_offline: '3' }),
    ...routes,
  })
}
function mountAt(path: string) {
  const client = createQueryClient()
  const page = (name: string) => createElement('div', null, name + '页内容')
  return render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null,
      createElement(Route, { element: createElement(Layout) },
        createElement(Route, { path: '/home', element: createElement(Home) }),
        createElement(Route, { path: '/groups', element: createElement(Groups) }),
        createElement(Route, { path: '/sensors', element: page('传感器') }),
      ))))))
}
const toasts = () => document.querySelector('.toasts')?.textContent ?? ''
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null) })

describe('集成项目页（改动 3、4）', () => {
  for (const [who, type] of [['平台账号', undefined], ['经销商账号', 1]] as const) {
    it(`${who}：没有「新建集成项目」「新建项目」「编辑」按钮，「统一控制」还在`, async () => {
      backend({}, { type })
      await signIn('u', 'pw', true)
      mountAt('/groups')
      await screen.findByText('科希家办公室')
      for (const name of ['新建集成项目', '新建项目', '编辑']) expect(screen.queryByRole('button', { name })).toBeNull()
      expect(screen.getByRole('button', { name: /统一控制/ })).toBeTruthy()
      if (type === 1) expect(screen.queryByRole('button', { name: /^经销商/ })).toBeNull() // 经销商账号没有经销商选择
    })
  }

  it('集成项目卡的类型名称按 app_id 从 /apps 查；没有 app_id 的不画空标签；创建时间取 created_at', async () => {
    backend()
    await signIn('u', 'pw', true)
    const { container } = mountAt('/groups')
    await screen.findByText('科希家办公室')
    const card = (name: string) => [...container.querySelectorAll('.grp-card')].find((c) => c.textContent?.includes(name))!
    await waitFor(() => expect(card('五恒集成项目').querySelector('[data-slot="badge"]')?.textContent).toBe('通用版'))
    expect(card('单机版').querySelector('[data-slot="badge"]')?.textContent).toBe('独立空气系统')
    expect(container.querySelector('.info4')?.textContent).toContain('2026-11-24 07:49:41')
    expect(container.querySelector('.info4')?.textContent).toContain('通用版')
  })

  it('按经销商取集成项目：加载中、失败（可重试）、空三态', async () => {
    let mode: 'hold' | 'fail' | 'empty' = 'hold'
    let release = () => {}
    backend({
      '/integrated-projects': async (c) => {
        const d = (c.body as Record<string, unknown>).distributor_id
        if (!d) return json({ entities: GROUPS })
        if (mode === 'hold') { await new Promise<void>((r) => { release = r }); return json({ code: 13, message: '集成项目查询失败' }, 500) }
        return mode === 'fail' ? json({ code: 13, message: '集成项目查询失败' }, 500) : json({})
      },
    })
    await signIn('u', 'pw', true)
    mountAt('/groups')
    expect(await screen.findByText('正在加载集成项目…', { selector: 'b' })).toBeTruthy()
    mode = 'fail'
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) })
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert.textContent).toContain('集成项目加载失败')
    expect(alert.textContent).toContain('集成项目查询失败')
    mode = 'empty'
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: '重试' })) })
    expect(await screen.findByText('该经销商下还没有集成项目，请选择其他经销商')).toBeTruthy()
  })
})

describe('经销商选择（可搜索下拉）', () => {
  const trigger = () => screen.getByRole('button', { name: /^经销商/ })
  const input = () => screen.getByRole('combobox', { name: '搜索经销商' })
  const options = () => within(screen.getByRole('listbox', { name: '经销商' })).queryAllByRole('option')

  it('打开后焦点在搜索框、高亮当前经销商；输入过滤并高亮第一条，回车选中、关闭并按它取集成项目', async () => {
    const be = backend()
    await signIn('u', 'pw', true)
    mountAt('/groups')
    await screen.findByText('科希家办公室')
    expect(trigger().textContent).toContain('科希家研发苏州main')
    await act(async () => { fireEvent.keyDown(trigger(), { key: 'Enter' }) })
    await waitFor(() => expect(document.activeElement).toBe(input()))
    expect(options().map((o) => o.textContent)).toEqual(['科希家研发苏州mainKXJ01', '南京舒适家NJ02'])
    await waitFor(() => expect(options()[0].getAttribute('aria-selected')).toBe('true'))
    expect(input().getAttribute('aria-controls')).toBe(screen.getByRole('listbox', { name: '经销商' }).id)
    await act(async () => { fireEvent.change(input(), { target: { value: 'nj' } }) })
    expect(options().map((o) => o.textContent)).toEqual(['南京舒适家NJ02'])
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id))
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    expect(screen.queryByRole('listbox', { name: '经销商' })).toBeNull()
    await screen.findByText('南京的项目')
    expect(trigger().textContent).toContain('南京舒适家')
    expect(be.callsTo('/integrated-projects').some((c) => (c.body as Record<string, unknown>).distributor_id === 'D2')).toBe(true)
  })

  it('没有命中：显示「未找到匹配的经销商」，回车不改选择；Esc 关闭，焦点回到触发器', async () => {
    backend()
    await signIn('u', 'pw', true)
    mountAt('/groups')
    await screen.findByText('科希家办公室')
    await act(async () => { fireEvent.click(trigger()) })
    await act(async () => { fireEvent.change(input(), { target: { value: 'zzz' } }) })
    expect(options()).toEqual([])
    expect(screen.getByText('未找到匹配的经销商')).toBeTruthy()
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    expect(trigger().textContent).toContain('科希家研发苏州main')
    await act(async () => { fireEvent.keyDown(input(), { key: 'Escape' }) })
    expect(screen.queryByRole('listbox', { name: '经销商' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it('/distributors 加载中：触发器不可用并提示正在加载；失败：显示错误和重试，「平台」分组仍可选', async () => {
    let release = () => {}
    let fail = true
    backend({
      '/distributors': async (_c, n) => { if (n === 1) await new Promise<void>((r) => { release = r }); return fail ? text('no permission', 403) : json({ distributor_entities: DEALERS }) },
      '/integrated-projects': (c) => json({ entities: (c.body as Record<string, unknown>).distributor_id ? [] : [...GROUPS, { id: 'g0', code: '1', name: '平台建的集成项目', project_ids: ['p3'] }] }),
    })
    await signIn('u', 'pw', true)
    mountAt('/groups')
    await waitFor(() => expect(trigger().textContent).toContain('正在加载经销商…'))
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) })
    const alert = await screen.findByText(/经销商列表加载失败：/)
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy()
    expect(trigger().textContent).toContain('平台')
    expect((await screen.findAllByText('平台建的集成项目')).length).toBeGreaterThan(0)
    fail = false
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: '重试' })) })
    await waitFor(() => expect(screen.queryByText(/经销商列表加载失败：/)).toBeNull())
  })
})

describe('首页统计卡与常用项目', () => {
  const cards = (c: HTMLElement) => [...c.querySelectorAll('.stat')].map((x) => x.textContent)

  it('统计卡用 /integrated-projects/stat；常用项目只显示可见范围里的，显示 code 和应用类别；点卡片切换并上报', async () => {
    const be = backend({
      '/projects/frequent': () => json({ project_entities: [{ id: 'not-visible' }, { id: 'p3' }, { id: 'p1' }] }),
      '/project/click/p3': () => json({}),
    })
    await signIn('u', 'pw', true)
    const { container } = mountAt('/home')
    await waitFor(() => expect(cards(container)).toEqual(['集成项目3', '项目总数4', '在线项目1 / 4', '离线项目3 / 4']))
    await waitFor(() => expect(container.querySelectorAll('.proj-card').length).toBe(2))
    const [c3, c1] = [...container.querySelectorAll('.proj-card')]
    expect(c3.textContent).toContain('科希家办公室')
    expect(c3.textContent).toContain('221031001')
    expect(c3.querySelector('.pc-loc')?.textContent).toBe('五恒')
    expect(c1.querySelector('.pc-loc')?.textContent).toBe('通用版') // 没有应用类别时用应用名称
    expect(container.textContent).not.toMatch(/undefined|NaN|最后在线|ppm/)
    expect(screen.queryByText('演示计数')).toBeNull()
    await act(async () => { fireEvent.click(c3) })
    await screen.findByText('传感器页内容')
    expect(localStorage.getItem('hjc-project')).toBe('p3')
    await waitFor(() => expect(be.callsTo('/project/click/p3')).toHaveLength(1))
  })

  it('经销商账号没有常用项目 / 统计权限：显示「常用项目暂不可用」，统计卡按可见范围算，不发这两个请求', async () => {
    const be = backend({}, { type: 1, paths: [] })
    await signIn('d', 'pw', true)
    const { container } = mountAt('/home')
    expect(await screen.findByText('常用项目暂不可用')).toBeTruthy()
    await waitFor(() => expect(cards(container)).toEqual(['集成项目3', '项目总数4', '在线项目1 / 4', '离线项目3 / 4']))
    expect(be.callsTo('/projects/frequent')).toEqual([])
    expect(be.callsTo('/integrated-projects/stat')).toEqual([])
  })

  it('常用项目失败：显示错误和重试', async () => {
    let fail = true
    backend({ '/projects/frequent': () => (fail ? json({ code: 13, message: '常用项目查询失败' }, 500) : json({ project_entities: [{ id: 'p1' }] })) })
    await signIn('u', 'pw', true)
    const { container } = mountAt('/home')
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert.textContent).toContain('常用项目查询失败')
    fail = false
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: '重试' })) })
    await waitFor(() => expect(container.querySelectorAll('.proj-card').length).toBe(1))
  })
})

describe('侧栏项目菜单的提示', () => {
  const openMenu = async () => { await act(async () => { fireEvent.click(screen.getByText('当前项目').closest('[role="button"]')!) }) }

  it('/distributors 失败：集成项目归到「其他」，菜单里不丢项目，并提示可重试', async () => {
    backend({ '/distributors': () => text('no permission', 403) })
    await signIn('u', 'pw', true)
    mountAt('/home')
    await screen.findAllByText('测试项目0829')
    await waitFor(async () => { await openMenu(); expect(screen.getByText(/经销商列表加载失败，部分分组暂按「其他」显示/)).toBeTruthy() })
    expect(screen.getByRole('group', { name: '其他 · 五恒集成项目' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '其他 · 南京集成项目' })).toBeTruthy()
  })

  it('后台刷新失败（有旧数据）：菜单顶部提示数据可能已过期', async () => {
    let fail = false
    const client = createQueryClient()
    backend({ '/ctrl/projects': () => (fail ? text('no permission', 403) : json({ project_entities: PROJECTS })) })
    await signIn('u', 'pw', true)
    render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
      createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(Routes, null,
        createElement(Route, { element: createElement(Layout) }, createElement(Route, { path: '/home', element: createElement('div', null, '首页') })))))))
    await screen.findByText('首页')
    fail = true
    await act(async () => { await client.refetchQueries({ queryKey: ['org'] }); await new Promise((r) => setTimeout(r, 20)) })
    await openMenu()
    expect(screen.getByText('项目列表刷新失败，数据可能已过期')).toBeTruthy()
  })
})

describe('顶栏搜索', () => {
  it('项目属于两个同名集成项目时，组名后面带编码区分', async () => {
    backend({ '/integrated-projects': () => json({ entities: [...GROUPS, { id: 'g5', code: '1', name: '五恒集成项目', project_ids: ['p1'] }] }) })
    await signIn('u', 'pw', true)
    mountAt('/home')
    await screen.findAllByText('测试项目0829')
    await act(async () => { fireEvent.change(screen.getByPlaceholderText('搜索项目名称 / 项目ID'), { target: { value: '240829' } }) })
    expect(await screen.findByText(/五恒集成项目（2）、五恒集成项目（1）/)).toBeTruthy()
  })
})

describe('切换失败的提示文案', () => {
  it('Groups「查看数据」范围外：先「项目列表正在刷新，请稍后重试」，刷新后仍不在范围：「无权查看该项目」', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 按经销商取的集成项目里有 p9，但全量集成项目里一直没有它（例如后端两处范围不一致）
    const P9 = { id: 'p9', code: '261200001', name: '范围外的项目', app_code: '1' }
    backend({
      '/ctrl/projects': () => json({ project_entities: [...PROJECTS, P9] }),
      '/integrated-projects': (c) => (c.body as Record<string, unknown>).distributor_id === 'D1'
        ? json({ entities: [{ ...GROUPS[0], project_ids: ['p1', 'p3', 'p9'] }, GROUPS[1]] })
        : json({ entities: GROUPS }),
    })
    await signIn('u', 'pw', true)
    mountAt('/groups')
    const row = (await screen.findByText('范围外的项目')).closest('tr')!
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: /查看数据/ })) })
    expect(toasts()).toContain('项目列表正在刷新，请稍后重试')
    await flush()
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: /查看数据/ })) })
    expect(toasts()).toContain('无权查看该项目')
    expect(screen.queryByText('传感器页内容')).toBeNull()
  })
})
