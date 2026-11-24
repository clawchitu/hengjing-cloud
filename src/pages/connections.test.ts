// @vitest-environment jsdom
// 设备连接状态页与项目离线态（S11）：真实数据形状，假后端驱动，不连任何真实服务。
// 覆盖：205 字段上屏、三种状态筛选、缺失字段 / 65536、控制屏离线（503）、无权限、无项目、离线项目不挂载不请求、
// 30 秒轮询与「立即检测」（都只读 205）。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { CONN_POLL_MS, CONN_ROUTE } from '../data/connections'
import Layout from '../components/Layout'
import Connections from './Connections'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const PROJECTS = [
  { id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', control_screen_id: '667b7cc60b7d46467c424d33', online: true },
  { id: 'p2', code: '261103001', name: '离线项目', app_code: '1', control_screen_id: 'cs-off', dtu_id: 'dtu-off' },
  { id: 'p3', code: '260911001', name: '只有 DTU', app_code: '12', dtu_id: 'dtu-9', online: true },
]
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p1', 'p2', 'p3'] }]
const PATHS = ['/v1/ctrl/projects', '/v1/integrated-projects', '/v1/distributors', CONN_ROUTE]

type Row = { deviceId?: number; deviceName?: string; model?: string; address?: string; connStatus?: number }
const reply = (data: Row[]) => json({ body: encodeMessage(pb.DeviceSummaryGetReplySchema, { data }) })
const unavailable = () => json({ code: 14, message: '控制屏消息发送失败' }, 503)

// 10 台：5 在线、2 离线、2 异常、1 未知（65536）；有缺省字段
const ROWS: Row[] = [
  { deviceName: '网络HUB', model: '485网络集线器', address: '192.168.0.102', connStatus: 1 },
  { deviceName: '房间11', model: '房间面板', address: '11', connStatus: 1 },
  { deviceName: '房间12', model: '房间面板', address: '12', connStatus: 0 },
  { deviceName: 'KC2', model: '空气传感器', address: '32', connStatus: 2 },
  { deviceName: 'CS10', model: '集中控制器', address: '64', connStatus: 1 },
  { deviceName: 'TXFS500', model: '空气处理机', address: '111', connStatus: 1 },
  { deviceName: '空调', model: '空调主机', address: '176', connStatus: 2 },
  { deviceName: 'JMWG', model: '网关', address: '218', connStatus: 1 },
  { model: '房间面板', address: '13' }, // 名称缺省、conn_status 缺省（= 0 离线）
  { deviceName: '未初始化', model: '', address: '', connStatus: 65536 },
]

function backend(routes: Record<string, (c: Call, n: number) => Response | Promise<Response>> = {}, paths = PATHS) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: paths }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    '/ctrl/device-summary-get': () => reply(ROWS),
    ...routes,
  })
}

function mountAt(path: string) {
  const client = createQueryClient()
  const page = (name: string) => createElement('div', null, name + '页内容')
  return render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null,
      createElement(Route, { element: createElement(Layout) },
        createElement(Route, { path: '/connections', element: createElement(Connections) }),
        createElement(Route, { path: '/sensors', element: page('传感器') }),
        createElement(Route, { path: '/thermostat', element: page('温控') }),
        createElement(Route, { path: '/fresh-air', element: page('新风') }),
      ))))))
}
const tableNames = () => [...document.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent)
const seg = (name: string) => screen.getAllByRole('button').find((b) => b.textContent?.startsWith(name))!
const toasts = () => document.querySelector('[data-sonner-toaster]')?.textContent ?? ''
const kpi = (label: string) => [...document.querySelectorAll('.kpi')].find((k) => k.querySelector('.k-label')?.textContent === label)

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setConfig(null) })

describe('设备连接状态页（ctrl 205）', () => {
  it('请求体：project_id 用实体 id、user_id 用当前用户、空 Query 传空串；页头显示控制屏编号', async () => {
    const be = backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    expect(be.callsTo('/ctrl/device-summary-get').map((c) => c.body)).toEqual([{ project_id: 'p1', user_id: 'admin-1', body: '' }])
    const sub = document.querySelector('.page-head .sub')!.textContent
    expect(sub).toContain('测试项目0829')
    expect(sub).toContain('控制屏 667b7cc60b7d46467c424d33')
    expect(sub).not.toContain('DTU')
    expect(sub).toContain('每 30 秒检测一次')
  })

  it('字段上屏：型号列、地址原样、缺省显示 --、65536 显示未知；KPI 按 conn_status 统计，没有最长离线 / 丢包率', async () => {
    backend()
    await signIn('u', 'pw', true)
    const { container } = mountAt('/connections')
    await screen.findByText('网络HUB')
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['设备名称', '型号', '地址', '连接状态'])
    const first = container.querySelector('tbody tr')!
    expect([...first.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['网络HUB', '485网络集线器', '192.168.0.102', '在线'])
    expect(kpi('接入设备')!.textContent).toContain('10')
    expect(kpi('在线')!.textContent).toContain('5')
    expect(kpi('在线')!.textContent).toContain('在线率 50.0%')
    expect(kpi('离线')!.textContent).toContain('2')
    expect(kpi('通讯异常')!.textContent).toContain('2')
    expect(container.textContent).not.toMatch(/最长|丢包率|NaN|undefined|网关 GW/)
    // 第 2 页（每页 7 条）：缺省名称的行和 65536 的行
    await act(async () => { fireEvent.click(within(container.querySelector('.pager .pages') as HTMLElement).getByRole('button', { name: '2' })) })
    const cells = [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    expect(cells).toEqual([
      ['JMWG', '网关', '218', '在线'],
      ['--', '房间面板', '13', '离线'],
      ['未初始化', '--', '--', '未知'],
    ])
  })

  it('三种连接状态筛选：在线 / 离线 / 异常各自只显示对应设备，计数一致；未知只在「全部」里', async () => {
    backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    expect(seg('全部').textContent).toBe('全部10')
    await act(async () => { fireEvent.click(seg('在线')) })
    expect(seg('在线').textContent).toBe('在线5')
    expect(tableNames()).toEqual(['网络HUB', '房间11', 'CS10', 'TXFS500', 'JMWG'])
    await act(async () => { fireEvent.click(seg('离线')) })
    expect(tableNames()).toEqual(['房间12', '--'])
    expect([...document.querySelectorAll('tbody tr')].every((tr) => tr.className.includes('st-off'))).toBe(true)
    await act(async () => { fireEvent.click(seg('异常')) })
    expect(tableNames()).toEqual(['KC2', '空调'])
    expect([...document.querySelectorAll('tbody tr')].every((tr) => tr.className.includes('st-err'))).toBe(true)
    expect(screen.queryByText('未初始化')).toBeNull()
  })

  it('只有 DTU 的项目：页头显示 DTU 编号', async () => {
    localStorage.setItem('hjc-project', 'p3')
    backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    const sub = document.querySelector('.page-head .sub')!.textContent
    expect(sub).toContain('DTU dtu-9')
    expect(sub).not.toContain('控制屏')
  })

  it('控制屏未连接（503）：显示空态，不显示表格，不弹 toast；之后恢复则自动显示（轮询）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let down = true
    const be = backend({ '/ctrl/device-summary-get': () => (down ? unavailable() : reply(ROWS)) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    expect(await screen.findByText('控制屏未连接')).toBeTruthy()
    expect(document.querySelector('table')).toBeNull()
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(1) // 503 不重试
    expect(toasts()).not.toContain('控制屏')
    down = false
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
    expect(await screen.findByText('网络HUB')).toBeTruthy()
    expect(screen.queryByText('控制屏未连接')).toBeNull()
  })

  it('有数据后轮询遇到 503：不再显示旧明细，改为「控制屏未连接」；其他错误保留旧数据并提示', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let mode: 'ok' | '503' | '500' = 'ok'
    backend({ '/ctrl/device-summary-get': () => (mode === 'ok' ? reply(ROWS) : mode === '503' ? unavailable() : json({ code: 13, message: '内部错误' }, 500)) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    mode = '500'
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) }) // 500 会重试 1 次
    expect(await screen.findByText(/最近一次刷新失败/)).toBeTruthy()
    expect(screen.getByText('网络HUB')).toBeTruthy()
    mode = '503'
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
    expect(await screen.findByText('控制屏未连接')).toBeTruthy()
    expect(screen.queryByText('网络HUB')).toBeNull()
  })

  it('每 30 秒重新读一次 205；「立即检测」立刻再读一次并提示结果；全程只调 205 这一个 ctrl 路由', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const be = backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS - 1_000) })
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(2)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '立即检测' })) })
    await waitFor(() => expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(3))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    await waitFor(() => expect(toasts()).toContain('检测完成：5 台在线，2 台离线，2 台通讯异常'))
    const ctrlRoutes = new Set(be.calls.map((c) => new URL(c.url, 'http://x').pathname).filter((p) => p.includes('/ctrl/') && p !== '/api/ctrl/projects'))
    expect([...ctrlRoutes]).toEqual(['/api/ctrl/device-summary-get'])
  })

  it('返回空列表：显示「暂无设备连接数据」', async () => {
    backend({ '/ctrl/device-summary-get': () => json({ body: '' }) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    expect(await screen.findByText('暂无设备连接数据')).toBeTruthy()
  })

  it('其他读取失败（无旧数据）：显示错误和重试；重试成功后显示明细', async () => {
    let fail = true
    backend({ '/ctrl/device-summary-get': () => (fail ? json({ code: 13, message: '内部错误' }, 500) : reply(ROWS)) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    // 500 会自动重试 1 次（约 1 秒后），之后才进错误态
    const box = (await screen.findByText('读取失败', undefined, { timeout: 4000 })).closest('[role=status]') as HTMLElement
    fail = false
    await act(async () => { fireEvent.click(within(box).getByRole('button', { name: '重试' })) })
    expect(await screen.findByText('网络HUB')).toBeTruthy()
  })

  it('账号没有 205 的权限：显示「未开通」，不发请求，不显示「立即检测」', async () => {
    const be = backend({}, PATHS.filter((p) => p !== CONN_ROUTE))
    await signIn('u', 'pw', true)
    mountAt('/connections')
    expect(await screen.findByText('未开通设备连接状态')).toBeTruthy()
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '立即检测' })).toBeNull()
  })

  it('没有可见项目：设备页显示「暂无可用项目」，不挂载页面，不请求 205', async () => {
    const be = backend({ '/integrated-projects': () => json({}) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    expect((await screen.findAllByText('暂无可用项目')).length).toBeGreaterThan(0)
    expect(document.querySelector('h1')).toBeNull()
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(0)
  })

  it('页面直接渲染（不经 Layout）且没有项目：空态兜底，不请求 205', async () => {
    const be = backend({ '/integrated-projects': () => json({}) })
    await signIn('u', 'pw', true)
    const client = createQueryClient()
    render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null, createElement(MemoryRouter, null, createElement(Connections)))))
    expect(await screen.findByText('当前账号下没有可查看的项目。')).toBeTruthy()
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(0)
  })
})

describe('项目离线态（S11）', () => {
  for (const [path, page] of [['/sensors', '传感器'], ['/thermostat', '温控'], ['/fresh-air', '新风'], ['/connections', '']] as const) {
    it(`${path}：离线横幅 + 空态，不挂载页面、不显示旧数据、不请求任何 ctrl`, async () => {
      localStorage.setItem('hjc-project', 'p2')
      const be = backend()
      await signIn('u', 'pw', true)
      mountAt(path)
      expect(await screen.findByText('项目离线，暂无数据')).toBeTruthy()
      const banner = screen.getByRole('alert').textContent
      expect(banner).toContain('项目离线 · 离线项目')
      expect(banner).toContain('控制屏 cs-off、DTU dtu-off 未连接')
      expect(banner).not.toMatch(/最后在线|仅供参考|GW-/)
      if (page) expect(screen.queryByText(page + '页内容')).toBeNull()
      expect(screen.queryByText('设备连接明细')).toBeNull()
      expect(document.querySelector('.offline-data')).toBeNull()
      expect(document.querySelector('h1')?.textContent).toBeTruthy()
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
      expect(be.calls.filter((c) => c.url.includes('/ctrl/') && !c.url.endsWith('/ctrl/projects'))).toHaveLength(0)
    })
  }

  it('online 不是 true（字符串 "true"、缺省）都按离线', async () => {
    localStorage.setItem('hjc-project', 'px')
    backend({
      '/ctrl/projects': () => json({ project_entities: [{ id: 'px', code: '1', name: '字符串在线', online: 'true', control_screen_id: 'cs' }] }),
      '/integrated-projects': () => json({ entities: [{ id: 'g1', name: 'g', distributor_id: 'D1', project_ids: ['px'] }] }),
    })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    expect(await screen.findByText('项目离线，暂无数据')).toBeTruthy()
  })

  it('没有控制屏和 DTU 编号的离线项目：横幅写「控制屏 未连接」', async () => {
    localStorage.setItem('hjc-project', 'px')
    backend({
      '/ctrl/projects': () => json({ project_entities: [{ id: 'px', code: '1', name: '无编号' }] }),
      '/integrated-projects': () => json({ entities: [{ id: 'g1', name: 'g', distributor_id: 'D1', project_ids: ['px'] }] }),
    })
    await signIn('u', 'pw', true)
    mountAt('/sensors')
    expect((await screen.findByRole('alert')).textContent).toContain('控制屏 未连接')
  })

  it('「重新获取在线状态」只重取项目列表等只读接口；项目恢复在线后显示页面', async () => {
    localStorage.setItem('hjc-project', 'p2')
    let online = false
    const be = backend({ '/ctrl/projects': () => json({ project_entities: PROJECTS.map((p) => (p.id === 'p2' ? { ...p, online: online || undefined } : p)) }) })
    await signIn('u', 'pw', true)
    mountAt('/sensors')
    await screen.findByText('项目离线，暂无数据')
    const before = be.callsTo('/ctrl/projects').length
    online = true
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新获取在线状态' })) })
    expect(await screen.findByText('传感器页内容')).toBeTruthy()
    expect(be.callsTo('/ctrl/projects').length).toBeGreaterThan(before)
    expect(screen.queryByRole('alert')).toBeNull()
    const writes = be.calls.filter((c) => /set|send|invalidate|click/.test(c.url))
    expect(writes).toEqual([])
  })
})
