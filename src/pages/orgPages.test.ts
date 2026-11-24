// @vitest-environment jsdom
// 页面级用例：真实数据形状（无区县名、app_code 字符串、一个项目属于两个集成项目、经销商列表晚到）
// 驱动 Groups、Control 和 OrgGate。只用假后端，不连任何真实服务。
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

beforeAll(() => {
  // Radix 在 jsdom 里需要的几个浏览器接口
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
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
    expect((await screen.findAllByText('暂无集成项目')).length).toBeGreaterThan(0)
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

  it('没有可见项目显示空态，不渲染页面', async () => {
    backend({ '/integrated-projects': () => json({}) })
    await signIn('u', 'pw', true)
    mount(createElement(OrgGate, null, child))
    await screen.findByText('暂无可用项目')
    expect(screen.queryByText('设备页内容')).toBeNull()
  })

  it('mock 模式首屏同步渲染（截图不变的前提）', () => {
    setConfig({ dataSource: 'mock' })
    localStorage.setItem('hjc-auth', JSON.stringify({ username: 'cosyhome', role: 'dealer' }))
    mount(createElement(OrgGate, null, child))
    expect(screen.getByText('设备页内容')).toBeTruthy()
  })
})
