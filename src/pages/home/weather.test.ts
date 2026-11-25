// @vitest-environment jsdom
// 首页天气（S7b）：真实接口模式 + 假后端（/weather、/weather24 用演示回包，即 11/24 苏州实测原文），不连任何真实服务。
// 覆盖：默认无锡、六格（改动 1）、三块各自的失败态互不影响、/weather 失败时用小时预报顶替、ret_code 非 0、无权限不发请求、
// 选过的城市按账号恢复（损坏回退无锡）、城市选择写缓存并按新城市请求、按名称查的城市（大理）；
// 城市选择省 → 市两级（打开定位到当前省、返回、直辖市直接选中、搜索平铺带省名、高度上限）。
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
import { CityPicker } from './WeatherSection'
import { iconOf, isSingleCity, matchCity, nearestHour, searchCities } from './weatherUi'
import { findCity, PROVINCES, type City } from '../../features/weather'

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
    const opt = JSON.parse(screen.getByTestId('chart').getAttribute('data-option')!) as { series: { name: string }[]; yAxis: { axisLabel: { showMinLabel?: boolean; showMaxLabel?: boolean } } }
    expect(opt.series.map((s) => s.name)).toEqual(['温度 °C'])
    // S13 P13：上下界刻度字不画，免得「5°」压住「6°」
    expect(opt.yAxis.axisLabel).toMatchObject({ showMinLabel: false, showMaxLabel: false })
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

  it('只有 /weather24 权限：刷新成功提示「天气已更新」（无权限的一路不算失败）', async () => {
    const b = backend({}, { paths: ['/v1/weather24'] })
    await signIn('u', 'pw', true)
    mount()
    await waitFor(() => expect(wx().textContent).toContain('小时预报'), { timeout: 3000 })
    await waitFor(() => expect(b.callsTo('/me')).toHaveLength(2))
    // 提示区是全局的，前面用例的提示可能还在：按出现次数比较这次新增的
    const count = (t: string) => toastText().split(t).length - 1
    const ok0 = count('天气已更新'), fail0 = count('更新失败')
    await act(async () => { fireEvent.click(refreshBtn()) })
    await waitFor(() => expect(count('天气已更新') + count('更新失败')).toBeGreaterThan(ok0 + fail0), { timeout: 5000 })
    expect(count('更新失败')).toBe(fail0)
    expect(count('天气已更新')).toBe(ok0 + 1)
    expect(b.callsTo('/weather')).toHaveLength(0)
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

describe('城市选择：省 → 市两级', () => {
  const items = () => [...document.querySelectorAll('[cmdk-item]')]
  const texts = () => items().map((e) => e.textContent)
  const selected = () => document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent
  const input = () => screen.getByRole('combobox', { name: '搜索城市' })
  const back = () => screen.getByRole('option', { name: /^返回省份列表/ })
  function open(city: City = findCity('320200')!) {
    const onPick = vi.fn()
    render(createElement(CityPicker, { city, onPick }))
    fireEvent.click(screen.getByRole('button', { name: /^天气城市：/ }))
    return onPick
  }
  const jiangsu = PROVINCES.find((p) => p.name === '江苏省')!

  it('打开时定位到当前城市所在省的城市列表：顶部是返回，高亮当前城市；弹层高度上限 360px', () => {
    open()
    expect(texts()).toEqual(['江苏省全部省份', ...jiangsu.cities.map((c) => c.name)])
    expect(back().getAttribute('aria-label')).toBe('返回省份列表（当前：江苏省）')
    expect(document.querySelector('[cmdk-item][data-current]')?.textContent).toBe('无锡市')
    expect(selected()).toBe('无锡市')
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('江苏省')
    expect(screen.getByRole('dialog', { name: '选择天气城市' }).className).toContain('max-h-[min(360px,')
    expect(document.activeElement).toBe(input())
  })

  it('点返回 → 省份列表（31 个），高亮刚才的省，当前城市所在省有标记；焦点留在搜索框', () => {
    open()
    fireEvent.click(back())
    expect(texts()).toEqual(PROVINCES.map((p) => p.name))
    expect(selected()).toBe('江苏省')
    expect(document.querySelector('[cmdk-item][data-current-province]')?.textContent).toBe('江苏省')
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('省份')
    expect(document.activeElement).toBe(input())
  })

  it('点省份进入它的城市列表，高亮第一个市；空搜索框按退格返回省份列表', () => {
    open()
    fireEvent.click(back())
    fireEvent.click(screen.getByRole('option', { name: '浙江省' }))
    const zj = PROVINCES.find((p) => p.name === '浙江省')!
    expect(texts()).toEqual(['浙江省全部省份', ...zj.cities.map((c) => c.name)])
    expect(selected()).toBe('杭州市')
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(texts()).toEqual(PROVINCES.map((p) => p.name))
    expect(selected()).toBe('浙江省')
  })

  it.each(['北京市', '天津市', '上海市', '重庆市'])('直辖市 %s：省份列表里点了直接选中，弹层关闭', (name) => {
    const onPick = open()
    fireEvent.click(back())
    fireEvent.click(screen.getByRole('option', { name }))
    expect(onPick).toHaveBeenCalledExactlyOnceWith(PROVINCES.find((p) => p.name === name)!.code)
    expect(screen.queryByRole('combobox', { name: '搜索城市' })).toBeNull()
  })

  it('选中城市：点城市列表里的市 → onPick 这个市；点当前城市不重复回调', () => {
    let onPick = open()
    fireEvent.click(screen.getByRole('option', { name: '苏州市' }))
    expect(onPick).toHaveBeenCalledExactlyOnceWith('320500')
    cleanup()
    onPick = open()
    fireEvent.click(screen.getByRole('option', { name: '无锡市' }))
    expect(onPick).not.toHaveBeenCalled()
  })

  it('搜索：平铺显示匹配的城市并带省份名（直辖市不重复）；回车选第一个；清空回到原来的视图', () => {
    const onPick = open()
    fireEvent.change(input(), { target: { value: '苏州' } })
    expect(texts()).toEqual(['苏州市 · 江苏省'])
    expect(screen.queryByRole('option', { name: /^返回省份列表/ })).toBeNull()
    fireEvent.change(input(), { target: { value: '北京' } })
    expect(texts()).toEqual(['北京市'])
    fireEvent.change(input(), { target: { value: '江苏' } })
    expect(texts()).toEqual(jiangsu.cities.map((c) => `${c.name} · 江苏省`))
    expect(selected()).toBe('南京市 · 江苏省')
    fireEvent.change(input(), { target: { value: '' } })
    expect(texts()[0]).toBe('江苏省全部省份')
    expect(selected()).toBe('无锡市')
    fireEvent.change(input(), { target: { value: '大理' } }) // 清空后紧接着再搜：不被「恢复高亮」抢回去
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledExactlyOnceWith('532900')
  })

  it('关掉再打开：重新定位到当前城市所在省（不沿用上次浏览的省、不保留搜索词）', () => {
    open(findCity('530100')!)
    expect(texts()[0]).toBe('云南省全部省份')
    fireEvent.click(back())
    fireEvent.click(screen.getByRole('option', { name: '浙江省' }))
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('combobox', { name: '搜索城市' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^天气城市：/ }))
    expect(texts()[0]).toBe('云南省全部省份')
    expect(selected()).toBe('昆明市')
    expect((input() as HTMLInputElement).value).toBe('')
  })
})

describe('weatherUi 纯函数', () => {
  it('isSingleCity：只有北京、天津、上海、重庆四个直辖市是一个市', () => {
    expect(PROVINCES.filter(isSingleCity).map((p) => p.name)).toEqual(['北京市', '天津市', '上海市', '重庆市'])
  })
  it('searchCities：空关键字返回空；按城市名或省名匹配，带所在省', () => {
    expect(searchCities('  ')).toEqual([])
    expect(searchCities('苏州').map((h) => `${h.city.name}/${h.province.name}`)).toEqual(['苏州市/江苏省'])
    expect(searchCities('大理').map((h) => h.city.code)).toEqual(['532900'])
    expect(searchCities('江苏')).toHaveLength(13)
  })
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
