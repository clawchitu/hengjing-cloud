// @vitest-environment jsdom
// 页面级用例：真实数据形状（无区县名、app_code 字符串、一个项目属于两个集成项目、经销商列表晚到）
// 驱动 Groups、Control 和 OrgGate。只用假后端，不连任何真实服务。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json, text, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { OrgGate } from '../app/OrgGate'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import Control from './Control'
import Groups from './Groups'
import Home from './Home'
import Layout from '../components/Layout'
import { MemoryRouter as Router, Route, Routes } from 'react-router-dom'

beforeAll(() => {
  // Radix 在 jsdom 里需要的几个浏览器接口
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

type Route = (call: Call, n: number) => Response | Promise<Response>
// p1 同时属于 g1、g2；真实项目没有区县名（只有行政区划码）
const PROJECTS = [
  { id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', app_name: '通用版', customer_region: '320000/320500/320506', online: true },
  { id: 'p2', code: '260911001', name: '独立空气系统测试', app_code: '12', app_name: '独立空气系统', online: true },
  { id: 'p3', code: '221031001', name: '科希家办公室', app_code: '1', app_name: '通用版' },
]
const GROUPS = [
  { id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p1', 'p3'] },
  { id: 'g2', code: '3', name: '单机版', distributor_id: 'D1', project_ids: ['p2', 'p1'] },
  { id: 'g9', code: '9', name: '空集成项目', distributor_id: 'D1', project_ids: [] },
]
function backend(routes: Record<string, Route> = {}, type?: number) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: type === 1 ? 'dealer-1' : 'admin-1', name: '测试', type } }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    ...routes,
  })
}
function deferred() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { gate, release }
}
function mount(node: ReactNode) {
  const client = createQueryClient()
  return render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null, createElement(MemoryRouter, null, node))))
}

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setConfig(null) })

describe('Groups（真实数据形状）', () => {
  it('区域下拉能打开：没有区县名的项目归到「未知区域」，不产生空值选项', async () => {
    backend()
    await signIn('u', 'pw', true)
    mount(createElement(Groups))
    await screen.findByText('测试项目0829')
    const trigger = screen.getByRole('combobox', { name: '区域' })
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Enter' }) })
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['全部区域', '未知区域'])
    await act(async () => { fireEvent.click(within(list).getByRole('option', { name: '未知区域' })) })
    expect(screen.getAllByText('未知区域').length).toBeGreaterThan(1) // 表格里的区域列
  })

  it('项目显示 code 和应用名称（appName），空集成项目的在线比例不出现 NaN', async () => {
    backend()
    await signIn('u', 'pw', true)
    const { container } = mount(createElement(Groups))
    await screen.findByText('测试项目0829')
    expect(screen.getByText('240829001')).toBeTruthy()
    expect(screen.getAllByText(/通用版/).length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(/NaN|undefined/)
    await act(async () => { fireEvent.click(screen.getByText('空集成项目')) })
    expect(container.textContent).toContain('0.0%')
    expect(container.innerHTML).not.toMatch(/NaN/)
  })

  it('一个项目属于两个集成项目：两张卡的项目数都算上它，切到第二个集成项目也能看到', async () => {
    backend()
    await signIn('u', 'pw', true)
    mount(createElement(Groups))
    await screen.findByText('测试项目0829')
    expect(screen.getAllByText('2 个项目').length).toBe(2) // g1、g2 各 2 个
    await act(async () => { fireEvent.click(screen.getByText('单机版')) })
    expect(screen.getByText('独立空气系统测试')).toBeTruthy()
    expect(screen.getByText('测试项目0829')).toBeTruthy()
  })

  it('平台账号：经销商列表晚到时自动选中第一个经销商并显示其集成项目', async () => {
    const d = deferred()
    backend({ '/distributors': async () => { await d.gate; return json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }) } })
    await signIn('u', 'pw', true)
    mount(createElement(Groups))
    expect(await screen.findByText('正在加载经销商…', { selector: 'b' })).toBeTruthy()
    await act(async () => { d.release() })
    await screen.findByText('测试项目0829')
    expect(screen.getByText(/科希家研发苏州main/, { selector: '.sub' })).toBeTruthy()
  })
})

describe('Control（真实数据形状）', () => {
  it('经销商账号：没有选择器，直接看到账号范围内第一个集成项目的项目（列表晚到也行）', async () => {
    const d = deferred()
    backend({ '/integrated-projects': async () => { await d.gate; return json({ entities: GROUPS }) } }, 1)
    await signIn('d', 'pw', true)
    mount(createElement(Control))
    await act(async () => { d.release() })
    await screen.findByText('测试项目0829')
    expect(screen.getByText('科希家办公室')).toBeTruthy()
  })

  it('平台账号：经销商列表晚到时取到默认经销商；一个项目属于两个集成项目时两组都能看到它', async () => {
    const d = deferred()
    backend({ '/distributors': async () => { await d.gate; return json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }) } })
    await signIn('u', 'pw', true)
    mount(createElement(Control))
    await act(async () => { d.release() })
    await screen.findByText('测试项目0829') // g1
    const groupSel = screen.getAllByRole('combobox').find((el) => el.textContent?.includes('五恒集成项目'))!
    await act(async () => { fireEvent.keyDown(groupSel, { key: 'Enter' }) })
    await act(async () => { fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: '单机版' })) })
    await screen.findByText('独立空气系统测试')
    expect(screen.getByText('测试项目0829')).toBeTruthy() // 也在 g2 里
  })
})

describe('OrgGate', () => {
  const child = createElement('div', null, '设备页内容')
  it('加载中不渲染里面的页面（不会把占位项目显示成离线）', async () => {
    const d = deferred()
    backend({ '/ctrl/projects': async () => { await d.gate; return json({ project_entities: PROJECTS }) } })
    await signIn('u', 'pw', true)
    mount(createElement(OrgGate, null, child))
    expect(screen.getByText('正在加载')).toBeTruthy()
    expect(screen.queryByText('设备页内容')).toBeNull()
    await act(async () => { d.release() })
    await screen.findByText('设备页内容')
  })

  it('失败显示错误和重试，重试成功后渲染', async () => {
    let fail = true
    backend({ '/ctrl/projects': () => (fail ? text('no permission', 403) : json({ project_entities: PROJECTS })) })
    await signIn('u', 'pw', true)
    mount(createElement(OrgGate, null, child))
    await screen.findByText('加载失败')
    expect(screen.getByText('无权限')).toBeTruthy()
    expect(screen.queryByText('设备页内容')).toBeNull()
    fail = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    await screen.findByText('设备页内容')
  })

  it('加载中和失败页都有「退出登录」', async () => {
    const d = deferred()
    backend({ '/ctrl/projects': async () => { await d.gate; return text('no permission', 403) } })
    await signIn('u', 'pw', true)
    mount(createElement(OrgGate, null, child))
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy()
    await act(async () => { d.release() })
    await screen.findByText('加载失败')
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy()
  })

  it('没有可见项目不拦整页（首页等照常渲染）', async () => {
    backend({ '/integrated-projects': () => json({}) })
    await signIn('u', 'pw', true)
    mount(createElement(OrgGate, null, child))
    await screen.findByText('设备页内容')
  })

  it('mock 模式首屏同步渲染（截图不变的前提）', () => {
    setConfig({ dataSource: 'mock' })
    localStorage.setItem('hjc-auth', JSON.stringify({ username: 'cosyhome', role: 'dealer' }))
    mount(createElement(OrgGate, null, child))
    expect(screen.getByText('设备页内容')).toBeTruthy()
  })
})

/** Layout + 一个子路由（不截图，只断言结构） */
function mountLayout(path: string) {
  const client = createQueryClient()
  const page = (name: string) => createElement('div', null, name + '页内容')
  return Object.assign(render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(Router, { initialEntries: [path] }, createElement(Routes, null,
      createElement(Route, { element: createElement(Layout) },
        createElement(Route, { path: '/home', element: page('首页') }),
        createElement(Route, { path: '/sensors', element: page('传感器') }),
      )))))), { client })
}

describe('Layout（真实数据形状）', () => {
  it('侧栏项目切换：一个项目属于两个集成项目时两组下都有它，显示 code', async () => {
    backend()
    await signIn('u', 'pw', true)
    mountLayout('/home')
    await screen.findByText('首页页内容')
    await act(async () => { fireEvent.click(screen.getByText('当前项目').closest('[role="button"]')!) })
    const g1 = await screen.findByRole('group', { name: /五恒集成项目/ })
    const g2 = screen.getByRole('group', { name: /单机版/ })
    expect(within(g1).getByText('测试项目0829')).toBeTruthy()
    expect(within(g2).getByText('测试项目0829')).toBeTruthy()
    expect(within(g1).getByText('240829001')).toBeTruthy() // 在线项目显示 code，不是后端 id
    expect(screen.queryByText('p1')).toBeNull()
  })

  it('顶栏搜索：按 code 搜得到，组名列出全部所属集成项目', async () => {
    backend()
    await signIn('u', 'pw', true)
    mountLayout('/home')
    await screen.findByText('首页页内容')
    await act(async () => { fireEvent.change(screen.getByPlaceholderText('搜索项目名称 / 项目ID'), { target: { value: '240829' } }) })
    expect(await screen.findByText(/五恒集成项目、单机版/)).toBeTruthy()
  })

  it('没有可见项目：首页照常渲染；设备页显示空态、不挂载页面，也不显示离线', async () => {
    backend({ '/integrated-projects': () => json({}) })
    await signIn('u', 'pw', true)
    const r = mountLayout('/home')
    await screen.findByText('首页页内容')
    expect(screen.getByText('暂无可用项目')).toBeTruthy() // 侧栏
    expect(screen.queryByText('离线')).toBeNull()
    r.unmount()
    mountLayout('/sensors')
    await screen.findAllByText('暂无可用项目')
    expect(screen.queryByText('传感器页内容')).toBeNull()
    // 面包屑不渲染空的项目名链接：只剩「集成项目」一个链接
    expect([...document.querySelectorAll('.crumbs a')].map((a) => a.textContent)).toEqual(['集成项目'])
    expect(screen.queryByRole('alert')).toBeNull() // 离线横幅是 role=alert
    expect(screen.queryByText('离线')).toBeNull()
  })

  it('有项目且离线时照常显示离线横幅（门控不影响真实离线）', async () => {
    localStorage.setItem('hjc-project', 'p3')
    backend()
    await signIn('u', 'pw', true)
    mountLayout('/sensors')
    await screen.findByText('传感器页内容')
    expect(screen.getByRole('alert').textContent).toContain('项目离线')
  })
})

describe('/distributors 失败但其他成功', () => {
  it('Groups：经销商选择处显示错误和重试，「平台」分组仍可选并显示其集成项目；重试成功后出现真实经销商', async () => {
    let fail = true
    backend({
      '/distributors': () => (fail ? text('no permission', 403) : json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] })),
      '/integrated-projects': () => json({ entities: [...GROUPS, { id: 'g0', code: '1', name: '平台建的集成项目', project_ids: ['p3'] }] }),
    })
    await signIn('u', 'pw', true)
    mount(createElement(Groups))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('经销商列表加载失败')
    expect((await screen.findAllByText('平台建的集成项目')).length).toBeGreaterThan(0)
    fail = false
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: '重试' })) })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(await screen.findByText(/科希家研发苏州main/, { selector: '.sub' })).toBeTruthy()
  })

  it('Control：经销商选择处显示错误和重试', async () => {
    backend({ '/distributors': () => text('no permission', 403) })
    await signIn('u', 'pw', true)
    mount(createElement(Control))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('经销商列表加载失败')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy()
  })
})

describe('Home（真实平台账号、组织范围为空）', () => {
  it('不显示演示数据的常用项目卡片，也不会把演示 id 写进当前项目存储', async () => {
    backend({ '/integrated-projects': () => json({}), '/ctrl/projects': () => json({}), '/projects/frequent': () => json({}), '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: ['/v1/projects/frequent'] }) })
    await signIn('u', 'pw', true)
    const { container } = mount(createElement(Home))
    await screen.findByText('暂无常用项目', {}, { timeout: 3000 })
    // 演示数据里管理员的常用项目（西溪蝶园 3号、河西府 会所新风等）一个都不出现
    expect(container.textContent).not.toMatch(/西溪蝶园|河西府|朝阳壹号院|PRJ-/)
    expect(container.querySelectorAll('.proj-card').length).toBe(0)
    expect(localStorage.getItem('hjc-project')).toBeNull()
  })
})

describe('侧栏菜单键盘导航（多组重复项）', () => {
  const highlighted = () => document.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')
  const groupOf = (el: Element | null) => el?.closest('[role="group"]')?.getAttribute('aria-label') ?? ''
  const key = async (k: string) => { await act(async () => { fireEvent.keyDown(document.activeElement!, { key: k }) }) }

  it('从第一组导航到第二组的重复项、继续导航、回车选中：高亮与 aria-activedescendant 指向正确的那一项', async () => {
    localStorage.setItem('hjc-project', 'p3')
    backend()
    await signIn('u', 'pw', true)
    const { client } = mountLayout('/home')
    await screen.findByText('首页页内容')
    // 侧栏按经销商分组，等经销商列表也到了再开菜单
    await waitFor(() => expect(client.getQueryState(['org', 'user:admin-1', 'dealers'])?.status).toBe('success'))
    const trigger = screen.getByText('当前项目').closest<HTMLElement>('[role="button"]')!
    trigger.focus()
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Enter' }) })
    // 菜单顺序：g1: p1, p3；g2: p1, p2。键盘打开先高亮当前项目 p3（在第一组）
    await waitFor(() => expect(highlighted()?.textContent).toContain('科希家办公室'))
    expect(groupOf(highlighted())).toContain('五恒集成项目')
    await key('ArrowDown') // → 第二组里重复出现的 p1
    expect(highlighted()?.textContent).toContain('测试项目0829')
    expect(groupOf(highlighted())).toContain('单机版')
    const list = document.querySelector('[cmdk-list]')!
    expect(list.getAttribute('aria-activedescendant')).toBe(highlighted()!.id)
    await key('ArrowDown') // → p2
    expect(highlighted()?.textContent).toContain('独立空气系统测试')
    await key('ArrowUp') // ← 回到第二组的 p1，不会跳到第一组的同名项
    expect(groupOf(highlighted())).toContain('单机版')
    expect(highlighted()?.textContent).toContain('测试项目0829')
    expect(list.getAttribute('aria-activedescendant')).toBe(highlighted()!.id)
    await key('Enter')
    expect(localStorage.getItem('hjc-project')).toBe('p1') // 选中时传的仍是项目 id
  })
})

describe('Groups「查看数据」：按经销商取的集成项目比全量缓存新', () => {
  const P4 = { id: 'p4', code: '261124001', name: '新加的项目', app_code: '1', online: true }
  const NEW_G1 = { ...GROUPS[0], project_ids: ['p1', 'p3', 'p4'] }
  /** 全量集成项目（不带 distributor_id）：第一次返回旧版本（g1 里还没有 p4），之后返回新版本；可以挂起后面的返回 */
  function setup() {
    let full = 0
    let gate: Promise<void> = Promise.resolve()
    let release = () => {}
    backend({
      '/ctrl/projects': () => json({ project_entities: [...PROJECTS, P4] }),
      '/integrated-projects': async (c) => {
        const body = (c.body ?? {}) as Record<string, unknown>
        if (body.distributor_id) return json({ entities: [NEW_G1, ...GROUPS.slice(1)] })
        full += 1
        if (full === 1) return json({ entities: GROUPS })
        await gate
        return json({ entities: [NEW_G1, ...GROUPS.slice(1)] })
      },
    })
    return {
      fullCalls: () => full,
      hold: () => { gate = new Promise((r) => { release = r }) },
      release: () => release(),
    }
  }
  function mountGroups() {
    const client = createQueryClient()
    return render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
      createElement(Router, { initialEntries: ['/groups'] }, createElement(Routes, null,
        createElement(Route, { path: '/groups', element: createElement(Groups) }),
        createElement(Route, { path: '/sensors', element: createElement('div', null, '传感器页内容') }),
      )))))
  }
  const clickView = async (name: string) => {
    const row = (await screen.findByText(name)).closest('tr')!
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: /查看数据/ })) })
  }
  const toasts = () => document.querySelector('.toasts')?.textContent ?? ''

  it('范围外：同步失败、提示稍后重试、不跳转、不写存储，并在后台刷新一次；刷新到达后再点一次成功', async () => {
    const be = setup()
    await signIn('u', 'pw', true)
    mountGroups()
    await screen.findByText('新加的项目')
    expect(be.fullCalls()).toBe(1)
    be.hold() // 让后台刷新先挂着：失败提示必须是同步给出的，不等刷新
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await clickView('新加的项目')
    expect(toasts()).toContain('项目列表正在刷新，请稍后重试')
    expect(toasts()).not.toContain('已进入')
    expect(screen.queryByText('传感器页内容')).toBeNull()
    expect(localStorage.getItem('hjc-project')).toBeNull()
    expect(be.fullCalls()).toBe(2) // 触发了一次后台刷新
    // 刷新结果到达：只更新数据，不提交选择
    await act(async () => { be.release(); await new Promise((r) => setTimeout(r, 20)) })
    expect(localStorage.getItem('hjc-project')).toBeNull()
    expect(screen.queryByText('传感器页内容')).toBeNull()
    warn.mockRestore()
    // 用户再点一次：按新数据判断，成功
    await clickView('新加的项目')
    await screen.findByText('传感器页内容')
    expect(localStorage.getItem('hjc-project')).toBe('p4')
    expect(toasts()).toContain('已进入「新加的项目」')
  })
})
