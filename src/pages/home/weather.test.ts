// @vitest-environment jsdom
// 首页天气（S7b）：真实接口模式 + 假后端（/weather、/weather24 用演示回包，即 11/24 苏州实测原文），不连任何真实服务。
// 覆盖：默认无锡、六格（改动 1）、三块各自的失败态互不影响、/weather 失败时用小时预报顶替、ret_code 非 0、无权限不发请求、
// 选过的城市按账号恢复（损坏回退无锡）、城市选择写缓存并按新城市请求、按名称查的城市（大理）。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../../api/config'
import { __resetHttpForTests } from '../../api/http'
import { createQueryClient } from '../../api/query'
import { __resetSessionForTests, signIn } from '../../api/session'
import { clearTokens } from '../../api/tokens'
import { fakeBackend, json, type Call } from '../../api/__tests__/helpers'
import { AppProvider } from '../../app/store'
import Layout from '../../components/Layout'
import { __resetCurrentForTests } from '../../data/org/current'
import { __resetSessionViewForTests } from '../../data/session'
import { weather24Raw, weatherRaw } from '../../mock/weather'
import Home from '../Home'
import { iconOf, matchCity, nearestHour } from './weatherUi'

vi.mock('../../components/legacy', async (orig) => {
  const m = await orig<typeof import('../../components/legacy')>()
  const { createElement: h } = await import('react')
  return { ...m, Chart: ({ option }: { option: unknown }) => h('div', { 'data-testid': 'chart', 'data-option': JSON.stringify(option) }) }
})

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

type Handler = (call: Call, n: number) => Response | Promise<Response>
const WEATHER_PATHS = ['/v1/weather', '/v1/weather24']
const PROJECTS = [{ id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', online: true }]
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p1'] }]
const cityOf = (c: Call) => (c.body as { city?: string }).city

function backend(routes: Record<string, Handler> = {}, opts: { paths?: string[] } = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: opts.paths ?? WEATHER_PATHS }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    '/weather': () => json(weatherRaw),
    '/weather24': () => json(weather24Raw),
    ...routes,
  })
}

function mount() {
  const client = createQueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(Routes, null,
      createElement(Route, { element: createElement(Layout) }, createElement(Route, { path: '/home', element: createElement(Home) })))))))
  return client
}

const wx = () => document.querySelector('.wx') as HTMLElement
const tileTexts = () => [...wx().querySelectorAll('.wx-grid > div')].map((d) => d.textContent)
const trigger = () => screen.getByRole('button', { name: /^天气城市：/ })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-11-24T12:10:00+08:00'))
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setConfig(null) })

describe('首页天气', () => {
  it('默认无锡：两个接口都按 320200 请求；六格是湿度、露点、风向、风力、气压、紫外线（没有能见度、体感）', async () => {
    const b = backend()
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().querySelector('.wx-grid')).toBeTruthy())
    // 挂载时会话会再校验一次（/me），查询可能重发一次；这里只断言查询的城市
    expect(new Set(b.callsTo('/weather').map(cityOf))).toEqual(new Set(['320200']))
    expect(new Set(b.callsTo('/weather24').map(cityOf))).toEqual(new Set(['320200']))
    expect(trigger().textContent).toContain('无锡市')
    expect(tileTexts()).toEqual(['相对湿度51%', '露点0.3°', '风向西北风', '风力3级', '气压1031.3hPa', '紫外线强'])
    expect(document.body.textContent).not.toMatch(/能见度|体感/)
    expect(wx().textContent).toContain('日出 06:31')
    expect(wx().textContent).toContain('降水概率 0%')
    // 7 天：f1–f7；24 小时：只画温度
    expect(document.querySelectorAll('.week .wd')).toHaveLength(7)
    const opt = JSON.parse(screen.getByTestId('chart').getAttribute('data-option')!) as { series: { name: string }[] }
    expect(opt.series.map((s) => s.name)).toEqual(['温度 °C'])
  })

  it('/weather 500：实时块用最近一小时的小时预报顶替（隐藏湿度、露点、气压、紫外线），7 天显示不可用和重试，24 小时照常', async () => {
    backend({ '/weather': () => json({ message: 'boom' }, 500) })
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().textContent).toContain('小时预报'), { timeout: 5000 })
    expect(wx().textContent).toContain('12时')
    expect(wx().querySelector('.wx-temp')!.textContent).toBe('12°C')
    expect(tileTexts()).toEqual(['风向北风', '风力0-3级'])
    const week = document.querySelector('.week') as HTMLElement
    expect(within(week).getByRole('alert').textContent).toContain('7 天预报暂不可用')
    expect(within(week).getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.getByTestId('chart')).toBeTruthy()
  })

  it('weatherNowFallback 关掉时：/weather 失败只显示错误和重试，不顶替', async () => {
    setConfig({ apiBase: '/api', dataSource: 'real', features: { weatherNowFallback: false } })
    backend({ '/weather': () => json({ message: 'boom' }, 500) })
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().getAttribute('role')).toBe('alert'), { timeout: 5000 })
    expect(wx().textContent).toContain('实时天气：暂无天气数据')
    expect(wx().textContent).not.toContain('小时预报')
  })

  it('/weather24 ret_code 非 0：24 小时显示暂无天气数据；实时和 7 天照常', async () => {
    backend({ '/weather24': () => json({ weather: { ret_code: -1 } }) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('24 小时预报暂不可用：暂无天气数据')
    expect(document.querySelectorAll('.week .wd')).toHaveLength(7)
  })

  it('没有天气权限：整块显示「当前账号未开通天气功能」，没有城市选择，不发天气请求', async () => {
    const b = backend({}, { paths: [] })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('当前账号未开通天气功能')
    expect(screen.queryByRole('button', { name: /^天气城市：/ })).toBeNull()
    expect(b.callsTo('/weather')).toHaveLength(0)
    expect(b.callsTo('/weather24')).toHaveLength(0)
  })

  it('只有 /weather24 权限、没有 /weather 权限：实时块也用小时预报顶替；两个都没有才整块说明', async () => {
    const b = backend({}, { paths: ['/v1/weather24'] })
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().textContent).toContain('小时预报'), { timeout: 3000 })
    expect(wx().querySelector('.wx-temp')!.textContent).toBe('12°C')
    expect(b.callsTo('/weather')).toHaveLength(0)
    expect(screen.getByTestId('chart')).toBeTruthy()
  })

  it('小时预报离现在超过 2 小时：不顶替，实时块显示无数据', async () => {
    vi.setSystemTime(Date.parse('2026-11-26T12:10:00+08:00')) // 回包里的小时都在 11/24 前后，差一天多
    backend({ '/weather': () => json({ message: 'boom' }, 500) })
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().getAttribute('role')).toBe('alert'), { timeout: 5000 })
    expect(wx().textContent).toContain('实时天气：暂无天气数据')
    expect(wx().textContent).not.toContain('小时预报')
  })

  it('点「重试」：请求期间按钮显示加载态并禁用，回来后恢复', async () => {
    let release: (r: Response) => void = () => {}
    let hold = false // 先一直失败（数据层可能自动重试），点重试前再改成挂起
    backend({ '/weather24': () => (!hold ? json({ message: 'boom' }, 500) : new Promise<Response>((r) => { release = r })) })
    await signIn('u', 'pw', true)
    mount()
    const hoursCard = async () => (await screen.findByText('24 小时预报暂不可用：暂无天气数据', {}, { timeout: 5000 })).closest('[role="alert"]') as HTMLElement
    const box = await hoursCard()
    hold = true
    fireEvent.click(within(box).getByRole('button', { name: '重试' }))
    const busy = await within(box).findByRole('button', { name: '重试中…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { release(json(weather24Raw)) })
    await waitFor(() => expect(screen.getByTestId('chart')).toBeTruthy())
  })
})

describe('刷新天气按钮', () => {
  const refreshBtn = () => screen.getByRole('button', { name: '刷新天气' })
  const toastText = () => document.querySelector('[data-sonner-toaster]')?.textContent ?? ''

  it('刷新成功：等请求回来后提示「天气已更新」', async () => {
    let release: (r: Response) => void = () => {}
    let n = 0
    const b = backend({ '/weather': () => (++n <= 1 ? json(weatherRaw) : new Promise<Response>((r) => { release = r })) })
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().querySelector('.wx-grid')).toBeTruthy())
    await waitFor(() => expect(b.callsTo('/me')).toHaveLength(2))
    await act(async () => { fireEvent.click(refreshBtn()) })
    await act(async () => { await new Promise((r) => setTimeout(r, 1000)) })
    expect(toastText()).not.toContain('天气已更新') // 请求还没回来，不能先报成功
    await act(async () => { release(json(weatherRaw)) })
    await waitFor(() => expect(toastText()).toContain('天气已更新'))
  })

  it('刷新失败：提示「更新失败，沿用上次数据」，页面仍是上次数据', async () => {
    let fail = false
    const b = backend({ '/weather': () => (fail ? json({ message: 'boom' }, 500) : json(weatherRaw)) })
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().querySelector('.wx-grid')).toBeTruthy())
    await waitFor(() => expect(b.callsTo('/me')).toHaveLength(2))
    fail = true
    await act(async () => { fireEvent.click(refreshBtn()) })
    await waitFor(() => expect(toastText()).toContain('更新失败，沿用上次数据'), { timeout: 5000 })
    expect(tileTexts()).toContain('相对湿度51%')
  })

  it('点刷新后离开页面（卸载）：计时器被清掉，不再提示', async () => {
    const b = backend()
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().querySelector('.wx-grid')).toBeTruthy())
    await waitFor(() => expect(b.callsTo('/me')).toHaveLength(2))
    const set = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    await act(async () => { fireEvent.click(refreshBtn()) })
    // 刷新那一刻排的 800ms 计时器，卸载时要被清掉
    const idx = set.mock.calls.findIndex((c) => c[1] === 800)
    expect(idx).toBeGreaterThanOrEqual(0)
    const handle = set.mock.results[idx].value
    cleanup()
    expect(clear).toHaveBeenCalledWith(handle)
    await new Promise((r) => setTimeout(r, 1000))
    expect(toastText()).not.toContain('天气已更新')
  })
})

describe('首页天气（续）', () => {
  it('选过的城市按账号恢复；缓存损坏回退无锡', async () => {
    localStorage.setItem('hjc-weather-city:user:admin-1', '{"code":"320500"}')
    const b = backend()
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(b.callsTo('/weather').length).toBeGreaterThan(0))
    expect(new Set(b.callsTo('/weather').map(cityOf))).toEqual(new Set(['320500']))
    expect(trigger().textContent).toContain('苏州市')
    cleanup()
    localStorage.setItem('hjc-weather-city:user:admin-1', '{bad')
    mount()
    await waitFor(() => expect(trigger().textContent).toContain('无锡市'))
  })

  it('城市选择：搜索「大理」回车 → 写缓存、按名称「大理白族自治州」请求、提示已切换', async () => {
    const b = backend()
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().querySelector('.wx-grid')).toBeTruthy())
    await waitFor(() => expect(b.callsTo('/me')).toHaveLength(2)) // 挂载后的会话再校验结束，页面不再重挂
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await act(async () => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }) })
    const input = await screen.findByRole('combobox', { name: '搜索城市' })
    await act(async () => { fireEvent.change(input, { target: { value: '大理' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await waitFor(() => expect(b.callsTo('/weather').map(cityOf)).toContain('大理白族自治州'))
    expect(b.callsTo('/weather24').map(cityOf)).toContain('大理白族自治州')
    expect(localStorage.getItem('hjc-weather-city:user:admin-1')).toBe('{"code":"532900"}')
    expect(trigger().textContent).toContain('大理白族自治州')
    await waitFor(() => expect(document.querySelector('[data-sonner-toaster]')?.textContent).toContain('天气城市已切换为 大理白族自治州'))
  })
})

describe('weatherUi 纯函数', () => {
  it('nearestHour 取离现在最近的一小时；没有可用时间返回 null', () => {
    const hs = [{ time: '2026-11-24 11:00' }, { time: '2026-11-24 12:00' }, { time: null }].map((h) => ({ text: null, code: null, temp: 1, windDirection: null, windPower: null, ...h }))
    expect(nearestHour(hs, Date.parse('2026-11-24T12:20:00+08:00'))?.time).toBe('2026-11-24 12:00')
    expect(nearestHour([], 0)).toBeNull()
  })
  it('nearestHour：差正好 2 小时仍顶替，超过 2 小时返回 null', () => {
    const hs = [{ text: null, code: null, temp: 1, windDirection: null, windPower: null, time: '2026-11-24 12:00' }]
    expect(nearestHour(hs, Date.parse('2026-11-24T14:00:00+08:00'))).not.toBeNull()
    expect(nearestHour(hs, Date.parse('2026-11-24T14:00:01+08:00'))).toBeNull()
    expect(nearestHour(hs, Date.parse('2026-11-24T09:59:00+08:00'))).toBeNull()
  })
  it('api 里的 getWeather 死代码已删', async () => {
    expect('getWeather' in (await import('../../api'))).toBe(false)
    expect('weather' in (await import('../../mock/data'))).toBe(false)
  })
  it('matchCity：「无锡」匹配「无锡市」，省名也能匹配', () => {
    expect(matchCity({ code: '320200', name: '无锡市' }, '江苏省', '无锡')).toBe(true)
    expect(matchCity({ code: '320200', name: '无锡市' }, '江苏省', '江苏')).toBe(true)
    expect(matchCity({ code: '320200', name: '无锡市' }, '江苏省', '苏州')).toBe(false)
  })
  it('iconOf：按天气代码，代码缺失时按文字', () => {
    expect(iconOf('00', null)[0].iconName).toBe('sun')
    expect(iconOf('07', '小雨')[0].iconName).toBe('cloud-rain')
    expect(iconOf(null, '多云')[0].iconName).toBe('cloud-sun')
    expect(iconOf(null, null)[0].iconName).toBe('cloud')
  })
})
