// @vitest-environment jsdom
// 天气 hooks：默认城市和按账号记住的选择、请求参数（按码 / 按名称）、失败降级、无权限不发请求。只用假后端
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '@/api/config'
import { __resetHttpForTests } from '@/api/http'
import { createQueryClient } from '@/api/query'
import { __resetSessionForTests, signIn } from '@/api/session'
import { clearTokens } from '@/api/tokens'
import { fakeBackend, json, text, type Call } from '@/api/__tests__/helpers'
import { __resetSessionViewForTests, mockSignIn } from '@/data/session'
import { findCity, NO_WEATHER_TEXT, useWeather24, useWeatherCity, useWeatherNow, WEATHER_FORBIDDEN_TEXT, WEATHER_STALE_MS, type City } from '..'

type Route = (call: Call, n: number) => Response | Promise<Response>
const WEATHER_PATHS = ['/v1/weather', '/v1/weather24']
const okNow = (city: string) => json({ weather: { cityInfo: { c3: city }, now: { temperature: '5', sd: '80%' }, f1: { day: '20261125' } } })
const ok24 = () => json({ weather: { area: 'x', hourList: [{ time: '202611250700', temperature: '5' }] } })

function backend(routes: Record<string, Route> = {}, paths = WEATHER_PATHS, userId = 'u1') {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A-' + userId, refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: userId, name: 'x' }, permission_paths: paths }),
    '/weather': (c) => okNow(String((c.body as { city: string }).city)),
    '/weather24': () => ok24(),
    ...routes,
  })
}
function wrapper() {
  const client = createQueryClient()
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return { client, wrapper: Wrapper }
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })
const useBoth = (city: City) => ({ now: useWeatherNow(city), hours: useWeather24(city) })

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); clearTokens()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null) })

describe('城市：默认和按账号记住', () => {
  it('没选过是无锡；选了以后重新挂载（下次打开）还是这个城市', async () => {
    backend(); await signIn('13800000000', 'pw', true)
    const { wrapper: w } = wrapper()
    const a = renderHook(() => useWeatherCity(), { wrapper: w })
    expect(a.result.current.city.code).toBe('320200')
    act(() => { expect(a.result.current.setCity('110000')).toBe(true) })
    expect(a.result.current.city.code).toBe('110000')
    a.unmount()
    const b = renderHook(() => useWeatherCity(), { wrapper: w })
    expect(b.result.current.city).toEqual({ code: '110000', name: '北京市' })
  })

  it('不在城市文件里的码不生效', async () => {
    backend(); await signIn('13800000000', 'pw', true)
    const { result } = renderHook(() => useWeatherCity(), { wrapper: wrapper().wrapper })
    act(() => { expect(result.current.setCity('110100')).toBe(false) })
    expect(result.current.city.code).toBe('320200')
  })

  it('换账号不带过去：A 选了北京，B 登录后仍是无锡', async () => {
    backend({}, WEATHER_PATHS, 'ua'); await signIn('13800000001', 'pw', true)
    const { wrapper: w } = wrapper()
    const a = renderHook(() => useWeatherCity(), { wrapper: w })
    act(() => { a.result.current.setCity('110000') })
    a.unmount()
    vi.unstubAllGlobals(); __resetSessionForTests(); __resetSessionViewForTests(); clearTokens()
    backend({}, WEATHER_PATHS, 'ub'); await signIn('13800000002', 'pw', true)
    const b = renderHook(() => useWeatherCity(), { wrapper: w })
    expect(b.result.current.city.code).toBe('320200')
    expect(localStorage.getItem('hjc-weather-city:user:ua')).toBe('{"code":"110000"}')
  })

  it('演示数据模式按演示账号分键', () => {
    setConfig({ dataSource: 'mock' })
    mockSignIn({ username: 'hjadmin', role: 'admin' }, true)
    const { result } = renderHook(() => useWeatherCity(), { wrapper: wrapper().wrapper })
    act(() => { result.current.setCity('310000') })
    expect(localStorage.getItem('hjc-weather-city:mock:hjadmin')).toBe('{"code":"310000"}')
  })
})

describe('请求参数', () => {
  it('默认城市：/weather 和 /weather24 都按码查 320200', async () => {
    const be = backend(); await signIn('13800000000', 'pw', true)
    const { result } = renderHook(() => useBoth(findCity('320200')!), { wrapper: wrapper().wrapper })
    await waitFor(() => expect(result.current.now.status).toBe('success'))
    await waitFor(() => expect(result.current.hours.status).toBe('success'))
    expect(be.callsTo('/weather').map((c) => c.body)).toEqual([{ city: '320200' }])
    expect(be.callsTo('/weather24').map((c) => c.body)).toEqual([{ city: '320200' }])
    expect(be.callsTo('/weather')[0].method).toBe('POST')
  })

  it('带按名称标记的城市（大理）按名称查；直辖市按省级码查', async () => {
    const be = backend(); await signIn('13800000000', 'pw', true)
    const { wrapper: w } = wrapper()
    const dali = renderHook(() => useBoth(findCity('532900')!), { wrapper: w })
    await waitFor(() => expect(dali.result.current.now.status).toBe('success'))
    await waitFor(() => expect(dali.result.current.hours.status).toBe('success'))
    const bj = renderHook(() => useBoth(findCity('110000')!), { wrapper: w })
    await waitFor(() => expect(bj.result.current.hours.status).toBe('success'))
    await waitFor(() => expect(bj.result.current.now.status).toBe('success'))
    expect(be.callsTo('/weather').map((c) => c.body)).toEqual([{ city: '大理白族自治州' }, { city: '110000' }])
    expect(be.callsTo('/weather24').map((c) => c.body)).toEqual([{ city: '大理白族自治州' }, { city: '110000' }])
  })

  it('30 分钟内同一城市不重复请求（react-query 缓存）', async () => {
    const be = backend(); await signIn('13800000000', 'pw', true)
    const { wrapper: w } = wrapper()
    const a = renderHook(() => useWeatherNow(findCity('320200')!), { wrapper: w })
    await waitFor(() => expect(a.result.current.status).toBe('success'))
    a.unmount()
    const b = renderHook(() => useWeatherNow(findCity('320200')!), { wrapper: w })
    expect(b.result.current.status).toBe('success')
    await flush()
    expect(be.callsTo('/weather')).toHaveLength(1)
    expect(WEATHER_STALE_MS).toBe(30 * 60_000)
  })
})

describe('失败降级：不抛到组件，给「暂无天气数据」', () => {
  it('/weather 500（重试 1 次后仍失败）→ error + 暂无天气数据；/weather24 照常', async () => {
    const be = backend({ '/weather': () => json({ code: 13, message: 'API返回的天气数据不完整' }, 500) }); await signIn('13800000000', 'pw', true)
    const { result } = renderHook(() => useBoth(findCity('320200')!), { wrapper: wrapper().wrapper })
    await waitFor(() => expect(result.current.now.status).toBe('error'), { timeout: 5000 })
    expect(result.current.now).toMatchObject({ data: null, text: NO_WEATHER_TEXT })
    expect(result.current.hours.status).toBe('success')
    expect(be.callsTo('/weather')).toHaveLength(2)
  })

  it('/weather24 回 ret_code -1（没有数据）→ error + 暂无天气数据，不重试', async () => {
    const be = backend({ '/weather24': () => json({ weather: { ret_code: -1 } }) }); await signIn('13800000000', 'pw', true)
    const { result } = renderHook(() => useBoth(findCity('320200')!), { wrapper: wrapper().wrapper })
    await waitFor(() => expect(result.current.hours.status).toBe('error'))
    expect(result.current.hours.text).toBe(NO_WEATHER_TEXT)
    await waitFor(() => expect(result.current.now.status).toBe('success'))
    expect(be.callsTo('/weather24')).toHaveLength(1)
  })

  it('断网、回包不是 JSON 也一样降级', async () => {
    backend({ '/weather': () => { throw new TypeError('Failed to fetch') }, '/weather24': () => text('oops', 200) }); await signIn('13800000000', 'pw', true)
    const { result } = renderHook(() => useBoth(findCity('320200')!), { wrapper: wrapper().wrapper })
    await waitFor(() => expect(result.current.now.status).toBe('error'), { timeout: 5000 })
    await waitFor(() => expect(result.current.hours.status).toBe('error'), { timeout: 5000 })
    expect(result.current.now.text).toBe(NO_WEATHER_TEXT)
    expect(result.current.hours.text).toBe(NO_WEATHER_TEXT)
  })

  it('没有天气接口权限：不发请求，forbidden', async () => {
    const be = backend({}, []); await signIn('13800000000', 'pw', true)
    const { result } = renderHook(() => useBoth(findCity('320200')!), { wrapper: wrapper().wrapper })
    await flush()
    expect(result.current.now).toMatchObject({ status: 'forbidden', text: WEATHER_FORBIDDEN_TEXT })
    expect(result.current.hours.status).toBe('forbidden')
    expect(be.callsTo('/weather')).toHaveLength(0)
    expect(be.callsTo('/weather24')).toHaveLength(0)
  })

  it('未登录不发请求', async () => {
    const be = backend()
    const { result } = renderHook(() => useBoth(findCity('320200')!), { wrapper: wrapper().wrapper })
    await flush()
    expect(result.current.now.status).toBe('loading')
    expect(be.callsTo('/weather')).toHaveLength(0)
  })
})

describe('演示数据模式', () => {
  it('不发请求，两块都有数据', async () => {
    setConfig({ dataSource: 'mock' })
    mockSignIn({ username: 'hjadmin', role: 'admin' }, true)
    const be = fakeBackend({})
    const { result } = renderHook(() => useBoth(findCity('320200')!), { wrapper: wrapper().wrapper })
    await waitFor(() => expect(result.current.now.status).toBe('success'))
    await waitFor(() => expect(result.current.hours.status).toBe('success'))
    expect(result.current.now.data?.days).toHaveLength(7)
    expect(result.current.hours.data?.hours).toHaveLength(24)
    expect(be.fetchMock).not.toHaveBeenCalled()
  })
})
