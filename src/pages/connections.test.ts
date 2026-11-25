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
import { fakeBackend, json, text, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetConnectionsForTests, CONN_POLL_MS, CONN_ROUTE, OFFLINE_RECHECK_MS } from '../data/connections'
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
        createElement(Route, { path: '/home', element: createElement('h1', null, '首页标题') }),
        createElement(Route, { path: '/connections', element: createElement(Connections) }),
        createElement(Route, { path: '/sensors', element: page('传感器') }),
        createElement(Route, { path: '/thermostat', element: page('温控') }),
        createElement(Route, { path: '/fresh-air', element: page('新风') }),
      ))))))
}
const tableNames = () => [...document.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent)
const seg = (name: string) => screen.getAllByRole('button').find((b) => b.textContent?.startsWith(name))!
const toasts = () => document.querySelector('[data-sonner-toaster]')?.textContent ?? ''
const toastType = (text: string) => [...document.querySelectorAll('[data-sonner-toast]')].find((t) => t.textContent?.includes(text))?.getAttribute('data-type')
function deferred() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { gate, release }
}
/** 模拟标签页可见 / 隐藏（TanStack 的 focusManager 听 visibilitychange） */
function setVisible(v: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') })
  document.dispatchEvent(new Event('visibilitychange'))
}
const kpi = (label: string) => [...document.querySelectorAll('.kpi')].find((k) => k.querySelector('.k-label')?.textContent === label)

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens(); __resetConnectionsForTests()
})
afterEach(() => { cleanup(); setVisible(true); vi.useRealTimers(); vi.unstubAllGlobals(); setConfig(null) })

describe('设备连接状态页（ctrl 205）', () => {
  it('请求体：project_id 用实体 id、user_id 用当前用户、空 Query 传空串；页头不显示控制屏编号（S13 P6：control_screen_id 是型号 id）', async () => {
    const be = backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    expect(be.callsTo('/ctrl/device-summary-get').map((c) => c.body)).toEqual([{ project_id: 'p1', user_id: 'admin-1', body: '' }])
    const sub = document.querySelector('.page-head .sub')!.textContent
    expect(sub).toContain('测试项目0829')
    expect(sub).toBe('测试项目0829·每 30 秒检测一次')
    expect(sub).not.toContain('667b7cc6')
    expect(sub).not.toContain('控制屏')
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
    // 每页 10 条（S13 P9）：10 台设备一页显示完，没有第 2 页；最后三行是缺省名称的行和 65536 的行
    expect(within(container.querySelector('.pager') as HTMLElement).queryByRole('button', { name: '2' })).toBeNull()
    const cells = [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    expect(cells).toHaveLength(10)
    expect(cells.slice(7)).toEqual([
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

  it('筛选后为 0 条：表格里显示空态行，不只剩表头（S13 P9）', async () => {
    backend({ '/ctrl/device-summary-get': () => reply([ROWS[0]]) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    await act(async () => { fireEvent.click(seg('离线')) })
    expect(tableNames()).toEqual(['没有离线的设备'])
    await act(async () => { fireEvent.click(seg('异常')) })
    expect(tableNames()).toEqual(['没有通讯异常的设备'])
  })

  it('只有 DTU 的项目：页头也不显示编号', async () => {
    localStorage.setItem('hjc-project', 'p3')
    backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    const sub = document.querySelector('.page-head .sub')!.textContent
    expect(sub).not.toContain('dtu-9')
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
      expect(banner).toContain('控制屏未连接，暂时读不到设备数据') // S13 P6：不显示控制屏 / DTU 编号
      expect(banner).not.toMatch(/cs-off|dtu-off/)
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

  it('没有控制屏和 DTU 编号的离线项目：横幅写「控制屏未连接」', async () => {
    localStorage.setItem('hjc-project', 'px')
    backend({
      '/ctrl/projects': () => json({ project_entities: [{ id: 'px', code: '1', name: '无编号' }] }),
      '/integrated-projects': () => json({ entities: [{ id: 'g1', name: 'g', distributor_id: 'D1', project_ids: ['px'] }] }),
    })
    await signIn('u', 'pw', true)
    mountAt('/sensors')
    expect((await screen.findByRole('alert')).textContent).toContain('控制屏未连接，暂时读不到设备数据')
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

describe('连接状态：503 之后的旧明细、轮询与并发（评审补充）', () => {
  for (const [label, fail] of [
    ['500', () => json({ code: 13, message: '内部错误' }, 500)],
    ['网络超时 / 断开', () => { throw new TypeError('Failed to fetch') }],
  ] as const) {
    it(`成功 → 503 → ${label} → 成功：503 之后旧明细不再出现，直到下一次成功`, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      let mode: 'ok' | '503' | 'fail' = 'ok'
      backend({ '/ctrl/device-summary-get': () => (mode === 'ok' ? reply(ROWS) : mode === '503' ? unavailable() : fail()) })
      await signIn('u', 'pw', true)
      mountAt('/connections')
      await screen.findByText('网络HUB')
      mode = '503'
      await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
      expect(await screen.findByText('控制屏未连接')).toBeTruthy()
      mode = 'fail'
      await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) }) // 可重试错误会重试 1 次
      expect(await screen.findByText('读取失败')).toBeTruthy()
      expect(screen.queryByText('网络HUB')).toBeNull()
      expect(screen.queryByText(/最近一次刷新失败/)).toBeNull()
      expect(document.querySelector('table')).toBeNull()
      mode = 'ok'
      await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
      expect(await screen.findByText('网络HUB')).toBeTruthy()
      expect(screen.queryByText('读取失败')).toBeNull()
    })
  }

  it('503 之后离开再进入页面（缓存里仍是旧明细）：遇到其他错误也不显示旧明细', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let mode: 'ok' | '503' | '500' = 'ok'
    backend({ '/ctrl/device-summary-get': () => (mode === 'ok' ? reply(ROWS) : mode === '503' ? unavailable() : json({ code: 13, message: '内部错误' }, 500)) })
    await signIn('u', 'pw', true)
    const r = mountAt('/connections')
    await screen.findByText('网络HUB')
    mode = '503'
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
    await screen.findByText('控制屏未连接')
    r.unmount()
    mode = '500'
    mountAt('/connections')
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(await screen.findByText('读取失败')).toBeTruthy()
    expect(screen.queryByText('网络HUB')).toBeNull()
  })

  it('标签页隐藏时暂停轮询，恢复可见后继续', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const be = backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    await act(async () => { setVisible(false) })
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS * 3) })
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(1)
    await act(async () => { setVisible(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS + 500) })
    expect(be.callsTo('/ctrl/device-summary-get').length).toBeGreaterThanOrEqual(2)
  })

  it('慢请求：上一次没返回不发下一次；进行中「立即检测」禁用、aria-busy，连点不加请求', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let gate: ReturnType<typeof deferred> | null = null
    const be = backend({ '/ctrl/device-summary-get': async () => { if (gate) await gate.gate; return reply(ROWS) } })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    gate = deferred()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONN_POLL_MS) })
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(2)
    const btn = screen.getByRole('button', { name: '立即检测' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    for (let i = 0; i < 3; i++) await act(async () => { fireEvent.click(btn) })
    // 请求挂着（服务端 10 秒、前端 12 秒超时之内）再过两个轮询周期也不叠加
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(2)
    await act(async () => { gate!.release() })
    await waitFor(() => expect(btn.disabled).toBe(false))
    expect(btn.getAttribute('aria-busy')).toBe('false')
  })

  it('切换项目后，上一个项目迟到的回复不会显示在新项目上', async () => {
    const slow = deferred()
    backend({
      '/ctrl/device-summary-get': async (c) => {
        const pid = (c.body as { project_id: string }).project_id
        if (pid === 'p1') { await slow.gate; return reply([{ deviceName: '旧项目设备', connStatus: 1 }]) }
        return reply([{ deviceName: '新项目设备', connStatus: 1 }])
      },
    })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('正在读取设备连接状态')
    const { setStoredProjectId } = await import('../data/org/current')
    await act(async () => { setStoredProjectId('p3') })
    expect(await screen.findByText('新项目设备')).toBeTruthy()
    await act(async () => { slow.release() })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByText('旧项目设备')).toBeNull()
    expect(screen.getByText('新项目设备')).toBeTruthy()
  })

  it('页面卸载后迟到的回复：不报错、不弹提示', async () => {
    const slow = deferred()
    backend({ '/ctrl/device-summary-get': async () => { await slow.gate; return reply(ROWS) } })
    const err = vi.spyOn(console, 'error')
    await signIn('u', 'pw', true)
    const r = mountAt('/connections')
    await screen.findByText('正在读取设备连接状态')
    r.unmount()
    await act(async () => { slow.release(); await new Promise((res) => setTimeout(res, 20)) })
    expect(err).not.toHaveBeenCalled()
    expect(toasts()).toBe('')
    err.mockRestore()
  })

  it('手动检测遇到 503：普通提示，不弹错误', async () => {
    let down = false
    backend({ '/ctrl/device-summary-get': () => (down ? unavailable() : reply(ROWS)) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    down = true
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '立即检测' })) })
    await waitFor(() => expect(toasts()).toContain('控制屏未连接，暂时无法检测'))
    expect(toastType('控制屏未连接')).not.toBe('error')
  })
})

describe('离线页：自动重取、按钮反馈、恢复后的焦点（评审补充）', () => {
  it('挂载期间每 60 秒只读重取一次项目列表；标签页隐藏时跳过', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.setItem('hjc-project', 'p2')
    const be = backend()
    await signIn('u', 'pw', true)
    mountAt('/sensors')
    await screen.findByText('项目离线，暂无数据')
    const n0 = be.callsTo('/ctrl/projects').length
    await act(async () => { await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS - 1_000) })
    expect(be.callsTo('/ctrl/projects')).toHaveLength(n0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    expect(be.callsTo('/ctrl/projects')).toHaveLength(n0 + 1)
    await act(async () => { setVisible(false) })
    await act(async () => { await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS * 2) })
    expect(be.callsTo('/ctrl/projects')).toHaveLength(n0 + 1)
    expect(be.calls.filter((c) => /set|send|invalidate|click|device-summary/.test(c.url))).toEqual([])
  })

  it('60 秒自动重取发现项目恢复在线：直接显示页面', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.setItem('hjc-project', 'p2')
    let online = false
    backend({ '/ctrl/projects': () => json({ project_entities: PROJECTS.map((p) => (p.id === 'p2' ? { ...p, online: online || undefined } : p)) }) })
    await signIn('u', 'pw', true)
    mountAt('/sensors')
    await screen.findByText('项目离线，暂无数据')
    online = true
    await act(async () => { await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS + 500) })
    expect(await screen.findByText('传感器页内容')).toBeTruthy()
  })

  it('「重新获取在线状态」进行中禁用；失败时提示可重试', async () => {
    localStorage.setItem('hjc-project', 'p2')
    let gate: ReturnType<typeof deferred> | null = null
    let fail = false
    backend({ '/ctrl/projects': async () => { if (gate) await gate.gate; return fail ? text('no permission', 403) : json({ project_entities: PROJECTS }) } })
    await signIn('u', 'pw', true)
    mountAt('/sensors')
    await screen.findByText('项目离线，暂无数据')
    const btn = screen.getByRole('button', { name: '重新获取在线状态' }) as HTMLButtonElement
    gate = deferred(); fail = true
    await act(async () => { fireEvent.click(btn) })
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    await act(async () => { gate!.release() })
    await waitFor(() => expect(btn.disabled).toBe(false))
    expect((await screen.findByText(/获取在线状态失败/)).textContent).toContain('请稍后重试')
  })

  it('恢复在线后焦点移到页面标题（h1，tabIndex=-1）', async () => {
    localStorage.setItem('hjc-project', 'p2')
    let online = false
    backend({ '/ctrl/projects': () => json({ project_entities: PROJECTS.map((p) => (p.id === 'p2' ? { ...p, online: online || undefined } : p)) }) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('项目离线，暂无数据')
    online = true
    const btn = screen.getByRole('button', { name: '重新获取在线状态' })
    btn.focus()
    await act(async () => { fireEvent.click(btn) })
    await screen.findByText('网络HUB')
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'))
    expect(document.activeElement?.textContent).toBe('设备连接状态')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1')
  })
})

describe('第二轮评审：手动检测的归属、503 失效按请求顺序、焦点只在离线空态里时才移', () => {
  it('已有数据 → 手动检测挂起 → 切换项目：迟到的结果不提示', async () => {
    let gate: ReturnType<typeof deferred> | null = null
    backend({ '/ctrl/device-summary-get': async () => { if (gate) await gate.gate; return reply(ROWS) } })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    gate = deferred()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '立即检测' })) })
    const { setStoredProjectId } = await import('../data/org/current')
    await act(async () => { setStoredProjectId('p3') })
    await act(async () => { gate!.release(); await new Promise((r) => setTimeout(r, 50)) })
    expect(toasts()).not.toContain('检测完成')
  })

  it('已有数据 → 手动检测挂起 → 离开页面：迟到的结果不提示', async () => {
    let gate: ReturnType<typeof deferred> | null = null
    backend({ '/ctrl/device-summary-get': async () => { if (gate) await gate.gate; return reply(ROWS) } })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    gate = deferred()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '立即检测' })) })
    await act(async () => { fireEvent.click(screen.getByText('室内空气传感器')) })
    await screen.findByText('传感器页内容')
    await act(async () => { gate!.release(); await new Promise((r) => setTimeout(r, 50)) })
    expect(toasts()).not.toContain('检测完成')
  })

  it('手动检测正常完成：提示的是这次请求的结果', async () => {
    let n = 0
    backend({ '/ctrl/device-summary-get': () => { n += 1; return reply(n === 1 ? ROWS : [{ deviceName: 'X', connStatus: 0 }]) } })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('网络HUB')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '立即检测' })) })
    await waitFor(() => expect(toasts()).toContain('检测完成：0 台在线，1 台离线，0 台通讯异常'))
  })

  // 时钟取在令牌有效期内（登录后的真实时间附近），免得会话层把令牌当过期
  const T0 = Date.now()
  for (const [label, clock] of [
    ['同一毫秒', () => T0],
    ['时钟回拨', (() => { let t = T0 + 600_000; return () => (t -= 1_000) })()],
  ] as const) {
    it(`503 之后的成功按请求顺序解除失效，与墙上时钟无关（${label}）`, async () => {
      let mode: 'ok' | '503' = 'ok'
      backend({ '/ctrl/device-summary-get': () => (mode === 'ok' ? reply(ROWS) : unavailable()) })
      await signIn('u', 'pw', true)
      mountAt('/connections')
      await screen.findByText('网络HUB')
      const now = vi.spyOn(Date, 'now').mockImplementation(clock)
      try {
        mode = '503'
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '立即检测' })) })
        expect(await screen.findByText('控制屏未连接')).toBeTruthy()
        mode = 'ok'
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '立即检测' })) })
        expect(await screen.findByText('网络HUB')).toBeTruthy()
        expect(screen.queryByText('正在读取设备连接状态')).toBeNull()
      } finally { now.mockRestore() }
    })
  }

  it('焦点在侧栏时项目自动恢复在线：焦点不动', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.setItem('hjc-project', 'p2')
    let online = false
    backend({ '/ctrl/projects': () => json({ project_entities: PROJECTS.map((p) => (p.id === 'p2' ? { ...p, online: online || undefined } : p)) }) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('项目离线，暂无数据')
    const side = screen.getByText('室内空气传感器').closest('a') as HTMLElement
    side.focus()
    online = true
    await act(async () => { await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS + 500) })
    await screen.findByText('网络HUB')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(document.activeElement).toBe(side)
  })

  it('焦点在离线空态里，但只是导航到非设备页（项目仍离线）：不移焦点到新页面标题', async () => {
    localStorage.setItem('hjc-project', 'p2')
    backend()
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('项目离线，暂无数据')
    screen.getByRole('button', { name: '重新获取在线状态' }).focus()
    await act(async () => { fireEvent.click(screen.getByText('欢迎首页')) })
    await screen.findByText('首页标题')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(document.activeElement).toBe(document.body) // 不移到新页面标题，也不移到主区域
  })

  it('没有焦点（在 body）时项目自动恢复在线：不主动移焦点', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.setItem('hjc-project', 'p2')
    let online = false
    backend({ '/ctrl/projects': () => json({ project_entities: PROJECTS.map((p) => (p.id === 'p2' ? { ...p, online: online || undefined } : p)) }) })
    await signIn('u', 'pw', true)
    mountAt('/connections')
    await screen.findByText('项目离线，暂无数据')
    ;(document.activeElement as HTMLElement | null)?.blur()
    online = true
    await act(async () => { await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS + 500) })
    await screen.findByText('网络HUB')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(document.activeElement).toBe(document.body)
  })
})
