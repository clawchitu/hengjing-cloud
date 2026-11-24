// @vitest-environment jsdom
// 室内空气传感器页（S8）：真实接口模式 + 假后端（ctrl 207 / 208 按 protobuf 编码），不连任何真实服务。
// 覆盖：请求用 project.id、208 时间为毫秒；65536 隐藏；统计从 208 小时数据算、无「超标时长」；
// 三态（加载 / 失败 / 空）；项目离线、无权限、控制屏未连接不发或不重试；切换传感器不串数据。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter as Router, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire'
import { base64Encode } from '@bufbuild/protobuf/wire'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json, text, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import Layout from '../components/Layout'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { HOUR_MS, SENSOR_ROUTES } from '../data/sensors'
import Sensors from './Sensors'

// ECharts 在 jsdom 里量不到尺寸：换成一个把 option 挂在属性上的占位，断言系列数据
vi.mock('../components/legacy', async (orig) => {
  const m = await orig<typeof import('../components/legacy')>()
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

const cst = (s: string) => Date.parse(s + '+08:00')
const NOW = cst('2026-11-24T07:42:10')

const PROJECTS = [
  { id: 'p1-entity', code: '240829001', name: '测试项目0829', app_code: '1', online: true },
  { id: 'p2-entity', code: '260911001', name: '独立空气系统测试', app_code: '12' },
]
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p1-entity', 'p2-entity'] }]
const PERMS = [SENSOR_ROUTES.live, SENSOR_ROUTES.hours]

type Handler = (call: Call, n: number) => Response | Promise<Response>
const body207 = (data: object[]) => json({ body: encodeMessage(pb.TPAirSensorGetReplySchema, { data }) })
const body208 = (data: object[]) => json({ body: encodeMessage(pb.TPAirSensorDataHourGetReplySchema, { data }) })
const ctrlError = (msg: string) => json({ body: base64Encode(new BinaryWriter().tag(2, WireType.LengthDelimited).string(msg).finish()) })
const q208 = (c: Call) => decodeReply(pb.TPAirSensorDataHourGetQuerySchema, (c.body as { body: string }).body) as { deviceId: number; startTime: number; endTime: number }

// 实测样本 KC2；B 没有 PM2.5 / CO₂ 探头（65536）；C 离线
const KC2 = { id: 2042830592, name: 'KC2', temperature: 25.5, humidity: 55, pm25: 5, co2: 580, dewPoint: 15.8, isConnected: true }
const NOPROBE = { id: 31, name: '主卧', temperature: 26, humidity: 50, pm25: 65536, co2: 65536, dewPoint: 15, isConnected: true }
const OFF = { id: 32, name: '影音室', temperature: 0, humidity: 0, pm25: 0, co2: 0, dewPoint: 0, isConnected: false }

/** 当前小时往前 n 小时的一条 208 记录 */
const hourRec = (id: number, back: number, v: object = {}) => {
  const date = Math.floor(NOW / HOUR_MS) * HOUR_MS - back * HOUR_MS
  return { id, date, hour: new Date(date + 8 * HOUR_MS).getUTCHours(), temperature: 25, humidity: 50, dewPoint: 14, co2: 600, pm25: 10, ...v }
}

function backend(routes: Record<string, Handler> = {}, opts: { perms?: string[]; projects?: object[] } = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: opts.perms ?? PERMS }),
    '/ctrl/projects': () => json({ project_entities: opts.projects ?? PROJECTS }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    ...routes,
  })
}

function mount() {
  const client = createQueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(Router, { initialEntries: ['/sensors'] }, createElement(Routes, null,
      createElement(Route, { element: createElement(Layout) }, createElement(Route, { path: '/sensors', element: createElement(Sensors) })))))))
  return client
}

function deferred() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { gate, release }
}

const chartOption = () => JSON.parse(screen.getByTestId('chart').getAttribute('data-option')!) as { series: { name: string; data: (number | null | { value: number })[] }[]; xAxis: { data: string[] } }
const summaryTable = () => screen.getByText('指标统计汇总').closest('[data-slot=card]') as HTMLElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setConfig(null) })

describe('请求', () => {
  it('207 / 208 的 project_id 用项目的后端实体 id（界面显示 code）；208 的时间是毫秒、窗口为最近 24 个整点', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(KC2.id, 0)]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('KC2', { selector: 'b' })
    await waitFor(() => expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(1))
    expect(within(document.querySelector('.page-head') as HTMLElement).getByText('240829001')).toBeTruthy()
    const live = b.callsTo('/ctrl/air-sensor-get')[0]
    expect(live.body).toMatchObject({ project_id: 'p1-entity', body: '' })
    const hc = b.callsTo('/ctrl/air-sensor-data-hour-get')[0]
    expect((hc.body as { project_id: string }).project_id).toBe('p1-entity')
    const q = q208(hc)
    expect(q.deviceId).toBe(KC2.id)
    expect(q.startTime).toBe(cst('2026-11-23T08:00:00'))
    expect(q.endTime).toBe(NOW)
  })

  it('切到 7 日 / 30 日：start 是最早那天北京时间 0 点（毫秒）', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('KC2', { selector: 'b' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '7日' })) })
    await waitFor(() => expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(2))
    expect(q208(b.callsTo('/ctrl/air-sensor-data-hour-get')[1]).startTime).toBe(cst('2026-11-18T00:00:00'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '30日' })) })
    await waitFor(() => expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(3))
    expect(q208(b.callsTo('/ctrl/air-sensor-data-hour-get')[2]).startTime).toBe(cst('2026-10-26T00:00:00'))
  })
})

describe('数据与统计', () => {
  it('65536：无探头的 PM2.5 / CO₂ 在卡片、KPI、指标切换、汇总里都隐藏', async () => {
    backend({
      '/ctrl/air-sensor-get': () => body207([NOPROBE]),
      '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(31, 1, { pm25: 65536, co2: 65536 })]),
    })
    await signIn('u', 'pw', true)
    mount()
    const card = (await screen.findByText('主卧', { selector: 'b' })).closest('.sensor') as HTMLElement
    expect(within(card).getByText('该型号无 PM2.5 / CO₂ 探头')).toBeTruthy()
    expect(within(card).queryByText('PM2.5')).toBeNull()
    expect(screen.queryByText('平均 PM2.5')).toBeNull()
    expect(screen.queryByText('平均 CO₂')).toBeNull()
    expect(screen.getByText('平均 温度')).toBeTruthy()
    await waitFor(() => expect(within(summaryTable()).getByText('温度 (°C)')).toBeTruthy())
    expect(within(summaryTable()).queryByText('PM2.5 (μg/m³)')).toBeNull()
    expect(screen.queryByRole('button', { name: 'PM2.5' })).toBeNull()
    expect(screen.getByRole('button', { name: '温度' })).toBeTruthy()
    // 没有 65536 原样显示出来
    expect(document.body.textContent).not.toMatch(/65,?536/)
  })

  it('汇总：平均 / 最大 / 最小 / 达标率由 208 小时数据算，无效值不参与；没有「超标时长 / 超标天数」列', async () => {
    backend({
      '/ctrl/air-sensor-get': () => body207([KC2]),
      '/ctrl/air-sensor-data-hour-get': () => body208([
        hourRec(KC2.id, 4, { temperature: 23 }), hourRec(KC2.id, 3, { temperature: 25 }), hourRec(KC2.id, 2, { temperature: 65536 }),
        hourRec(KC2.id, 1, { temperature: 26 }), hourRec(KC2.id, 0, { temperature: 28 }), hourRec(KC2.id, 5, { temperature: -100 }),
      ]),
    })
    await signIn('u', 'pw', true)
    mount()
    const row = (await within(await screen.findByText('指标统计汇总').then((e) => e.closest('[data-slot=card]') as HTMLElement)).findByText('温度 (°C)')).closest('tr')!
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent)
    expect(cells).toEqual(['温度 (°C)', '25.5', '28.0', '23.0', '24 – 27', '50%'])
    const heads = [...summaryTable().querySelectorAll('th')].map((th) => th.textContent)
    expect(heads).toEqual(['指标', '平均值', '最大值', '最小值', '标准范围', '达标率'])
    expect(document.body.textContent).not.toMatch(/超标时长|超标天数/)
  })

  it('24 小时图：24 个整点，没有数据和无效值的小时是断点（null）；孤立的点单独画出来', async () => {
    backend({
      '/ctrl/air-sensor-get': () => body207([KC2]),
      '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(KC2.id, 0, { temperature: 25 }), hourRec(KC2.id, 1, { temperature: 65536 }), hourRec(KC2.id, 5, { temperature: 24 }), hourRec(KC2.id, 6, { temperature: 24.5 })]),
    })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByTestId('chart')
    const o = chartOption()
    expect(o.xAxis.data).toHaveLength(24)
    expect(o.xAxis.data.at(-1)).toBe('07:00')
    const d = o.series[0].data
    expect(d.at(-1)).toMatchObject({ value: 25 })
    expect(d.at(-2)).toBeNull()
    expect(d.at(-6)).toBe(24)
    expect(d.at(-7)).toBe(24.5)
    expect(d.filter((v) => v !== null)).toHaveLength(3)
  })

  it('7 日图：按天聚合为日均 / 日最高 / 日最低', async () => {
    const day = (d: string, h: number, t: number) => ({ ...hourRec(KC2.id, 0), date: cst(`2026-11-${d}T00:00:00`) + h * HOUR_MS, temperature: t })
    backend({
      '/ctrl/air-sensor-get': () => body207([KC2]),
      '/ctrl/air-sensor-data-hour-get': (c) => body208(q208(c).startTime < cst('2026-11-23T00:00:00') ? [day('22', 1, 22), day('22', 9, 26), day('24', 2, 25)] : []),
    })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('KC2', { selector: 'b' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '7日' })) })
    await waitFor(() => expect(chartOption().series.map((s) => s.name).slice(0, 3)).toEqual(['日均值', '日最高', '日最低']))
    const o = chartOption()
    expect(o.xAxis.data).toEqual(['11-18', '11-19', '11-20', '11-21', '11-22', '11-23', '11-24'])
    const plain = (v: unknown) => (v && typeof v === 'object' ? (v as { value: number }).value : v)
    expect(o.series[0].data.map(plain)).toEqual([null, null, null, null, 24, null, 25])
    expect(o.series[1].data.map(plain)).toEqual([null, null, null, null, 26, null, 25])
    expect(o.series[2].data.map(plain)).toEqual([null, null, null, null, 22, null, 25])
  })

  it('离线传感器：读数显示「—」，不显示「最后在线」；点它不切换', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2, OFF]), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    mount()
    const card = (await screen.findByText('影音室', { selector: 'b' })).closest('.sensor') as HTMLElement
    expect(within(card).getAllByText('—')).toHaveLength(3)
    expect(document.body.textContent).not.toContain('最后在线')
    await waitFor(() => expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(1))
    await act(async () => { fireEvent.click(card) })
    expect(b.callsTo('/ctrl/air-sensor-data-hour-get').every((c) => q208(c).deviceId === KC2.id)).toBe(true)
    expect(screen.getByText('数据统计 · KC2')).toBeTruthy()
  })

  it('导出：CSV 内容是汇总表（无超标时长），按钮在没有数据时禁用', async () => {
    let blob: Blob | undefined
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { blob = b; return 'blob:x' }, revokeObjectURL: () => {} }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(KC2.id, 0, { temperature: 25, co2: 900 })]) })
    await signIn('u', 'pw', true)
    mount()
    const btn = await screen.findByRole('button', { name: '导出' })
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false))
    await act(async () => { fireEvent.click(btn) })
    expect(click).toHaveBeenCalledTimes(1)
    const bytes = new Uint8Array(await blob!.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // BOM：Excel 直接打开不乱码
    const csv = await blob!.text()
    expect(csv.replace(/^﻿/, '').split('\r\n')[0]).toBe('指标,平均值,最大值,最小值,标准范围,达标率,有效小时数')
    expect(csv).toContain('温度 (°C),25.0,25.0,25.0,24 – 27,100%,1')
    expect(csv).toContain('CO₂ (ppm),900,900,900,≤ 1000,100%,1')
    expect(csv).not.toContain('超标')
  })
})

describe('三态', () => {
  it('加载中：显示「正在读取」，208 不发；207 返回后显示列表', async () => {
    const d = deferred()
    const b = backend({ '/ctrl/air-sensor-get': async () => { await d.gate; return body207([KC2]) }, '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('正在读取')
    expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(0)
    await act(async () => { d.release() })
    await screen.findByText('KC2', { selector: 'b' })
  })

  it('失败：显示错误和「重试」，重试成功后显示列表', async () => {
    let fail = true
    backend({ '/ctrl/air-sensor-get': () => (fail ? json({ code: 3, message: '参数错误' }, 400) : body207([KC2])), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('空气传感器数据加载失败')
    expect(screen.getByText('参数错误')).toBeTruthy()
    fail = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    await screen.findByText('KC2', { selector: 'b' })
  })

  it('空：项目下没有传感器', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('暂无空气传感器数据')
    expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(0)
  })

  it('208 失败（ctrl 业务错误）：只影响统计区，显示原因和重试；列表照常', async () => {
    let n = 0
    backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => (++n === 1 ? ctrlError('错误的传感器id') : body208([hourRec(KC2.id, 0)])) })
    await signIn('u', 'pw', true)
    mount()
    expect(await screen.findAllByText('统计数据加载失败：错误的传感器id')).toHaveLength(2)
    expect(screen.getByText('KC2', { selector: 'b' })).toBeTruthy()
    expect(within(summaryTable()).getByText('统计数据加载失败：错误的传感器id')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]) })
    await screen.findByTestId('chart')
  })

  it('208 成功但没有数据：图和汇总显示「暂无数据」', async () => {
    backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(KC2.id, 0, { temperature: 65536, humidity: -100, dewPoint: 65536, co2: 65536, pm25: 65536 })]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('该时段暂无数据')
    expect(within(summaryTable()).getByText('该时段暂无统计数据')).toBeTruthy()
    expect(within(summaryTable()).queryByText('温度 (°C)')).toBeNull()
    expect((screen.getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('项目离线 / 无项目 / 无权限 / 控制屏未连接', () => {
  it('项目离线：显示「控制屏离线」空态，不发任何 ctrl 请求', async () => {
    localStorage.setItem('hjc-project', 'p2-entity')
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('控制屏离线')
    expect(within(document.querySelector('.page-head') as HTMLElement).getByText('260911001')).toBeTruthy()
    expect(b.calls.filter((c) => c.url.includes('/ctrl/air-sensor'))).toHaveLength(0)
  })

  it('没有可见项目：设备页显示空态，不发 ctrl 请求', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]) }, { projects: [] })
    await signIn('u', 'pw', true)
    mount()
    expect((await screen.findAllByText('暂无可用项目')).length).toBeGreaterThan(0)
    expect(b.calls.filter((c) => c.url.includes('/ctrl/air-sensor'))).toHaveLength(0)
  })

  it('账号没有 207 权限：显示「未开通」，不发请求', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]) }, { perms: [] })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('未开通空气传感器数据')
    expect(b.calls.filter((c) => c.url.includes('/ctrl/air-sensor'))).toHaveLength(0)
  })

  it('有 207 没有 208 权限：列表照常，统计区提示未开通，不发 208', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]) }, { perms: [SENSOR_ROUTES.live] })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('KC2', { selector: 'b' })
    expect(screen.getAllByText('当前账号未开通统计数据权限')).toHaveLength(2)
    expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(0)
  })

  it('207 返回 503（控制屏未连接）：显示空态，不自动重试，不发 208', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => json({ code: 14, message: '控制屏消息发送失败' }, 503) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('控制屏未连接')
    expect(b.callsTo('/ctrl/air-sensor-get')).toHaveLength(1)
    expect(b.callsTo('/ctrl/air-sensor-data-hour-get')).toHaveLength(0)
  })

  it('后台刷新 503：不再显示旧读数', async () => {
    let n = 0
    backend({ '/ctrl/air-sensor-get': () => (++n === 1 ? body207([KC2]) : json({ code: 14, message: '控制屏消息发送失败' }, 503)), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    const client = mount()
    await screen.findByText('KC2', { selector: 'b' })
    await act(async () => { await client.refetchQueries({ queryKey: ['ctrl', 207] }) })
    await screen.findByText('控制屏未连接')
    expect(screen.queryByText('KC2', { selector: 'b' })).toBeNull()
  })

  it('后台刷新失败（非 503）：保留旧数据并提示刷新失败', async () => {
    let n = 0
    backend({ '/ctrl/air-sensor-get': () => (++n === 1 ? body207([KC2]) : text('bad', 400)), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    const client = mount()
    await screen.findByText('07:42:10 更新')
    await act(async () => { await client.refetchQueries({ queryKey: ['ctrl', 207] }) })
    await screen.findByText(/刷新失败，显示 07:42:10 的数据/)
    expect(screen.getByText('KC2', { selector: 'b' })).toBeTruthy()
  })
})

describe('并发', () => {
  it('切换传感器时上一台的 208 晚到：不会显示到新选的传感器下', async () => {
    const slowA = deferred()
    const A = { ...KC2, id: 1, name: '客厅' }
    const B = { ...KC2, id: 2, name: '书房' }
    backend({
      '/ctrl/air-sensor-get': () => body207([A, B]),
      '/ctrl/air-sensor-data-hour-get': async (c) => {
        if (q208(c).deviceId === 1) { await slowA.gate; return body208([hourRec(1, 0, { temperature: 99 })]) }
        return body208([hourRec(2, 0, { temperature: 21 })])
      },
    })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('数据统计 · 客厅')
    await act(async () => { fireEvent.click(screen.getByText('书房', { selector: 'b' }).closest('.sensor')!) })
    await screen.findByText('数据统计 · 书房')
    await screen.findByTestId('chart')
    await act(async () => { slowA.release() })
    await act(async () => {})
    const d = chartOption().series[0].data
    expect(d.filter((v) => v !== null).map((v) => (typeof v === 'object' ? v!.value : v))).toEqual([21])
    const row = within(summaryTable()).getByText('温度 (°C)').closest('tr')!
    expect(row.querySelectorAll('td')[1].textContent).toBe('21.0')
  })
})
