// @vitest-environment jsdom
// 室内空气传感器页（S8）：真实接口模式 + 假后端（ctrl 207 / 208 按 protobuf 编码），不连任何真实服务。
// 覆盖：请求用 project.id、208 时间为毫秒；65536 隐藏；统计从 208 小时数据算、无「超标时长」；
// 三态（加载 / 失败 / 空）；项目离线、无权限、控制屏未连接不发或不重试；切换传感器不串数据。
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
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
import { __resetSensorsForTests, HOUR_MS, HOURS_POLL_MS, SENSOR_POLL_MS, SENSOR_ROUTES, SENSOR_UNAVAILABLE_POLL_MS, useAirSensors, useSensorHours } from '../data/sensors'
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
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); __resetSensorsForTests(); clearTokens()
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
    // 11 月是冬季：温度标准范围 18 – 22，23 / 25 / 26 / 28 都不达标
    // 有效 4 小时不到应有 24 小时的一半：照样显示达标率，下面加灰字「有效 4/24 小时」
    expect(cells).toEqual(['温度 (°C)', '25.5', '28.0', '23.0', '18 – 22', '0%有效 4/24 小时'])
    const heads = [...summaryTable().querySelectorAll('th')].map((th) => th.textContent)
    expect(heads).toEqual(['指标', '平均值', '最大值', '最小值', '标准范围', '达标率'])
    // 达标率表头带口径说明（键盘可聚焦，读屏可读）
    expect(within(summaryTable()).getByRole('img', { name: '达标率口径：统计时段内，小时读数落在标准范围内的时间占比；无数据的小时不计入。温度标准范围分冬夏（5–10 月为夏季），季节按统计窗口结束时刻判定。' }).tabIndex).toBe(0)
    expect(document.body.textContent).not.toMatch(/超标时长|超标天数/)
  })

  it('达标率：夏季按 24 – 26；有效小时为 0 显示「—」；数据过半不显示「有效 N/M」；没装探头的指标整行隐藏', async () => {
    vi.setSystemTime(cst('2026-07-10T12:30:00'))
    const at = (back: number, v: object) => ({ ...hourRec(KC2.id, 0, v), date: cst('2026-07-10T12:00:00') - back * HOUR_MS })
    backend({
      // 207：PM2.5 无探头（65536）；CO₂ 有探头
      '/ctrl/air-sensor-get': () => body207([{ ...KC2, pm25: 65536 }]),
      // 208：13 个有效小时（过半）；CO₂ 全部无效（缺省 0）；PM2.5 也全无效
      '/ctrl/air-sensor-data-hour-get': () => body208(Array.from({ length: 13 }, (_, i) => at(i, { temperature: i < 3 ? 27 : 25, co2: 0, pm25: 65536 }))),
    })
    await signIn('u', 'pw', true)
    mount()
    const t = await within(await screen.findByText('指标统计汇总').then((e) => e.closest('[data-slot=card]') as HTMLElement)).findByText('温度 (°C)')
    const cells = [...t.closest('tr')!.querySelectorAll('td')].map((td) => td.textContent)
    expect(cells).toEqual(['温度 (°C)', '25.5', '27.0', '25.0', '24 – 26', '76%'])
    const co2 = [...within(summaryTable()).getByText('CO₂ (ppm)').closest('tr')!.querySelectorAll('td')].map((td) => td.textContent)
    // 装了探头但没有有效小时：照常出行，达标率「—」，灰字「有效 0/24 小时」
    expect(co2).toEqual(['CO₂ (ppm)', '—', '—', '—', '≤ 800', '—有效 0/24 小时'])
    expect(within(summaryTable()).queryByText('PM2.5 (μg/m³)')).toBeNull()
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
    const lines = (await blob!.text()).replace(/^﻿/, '').split('\r\n')
    // 说明行：项目（名称 + code）、传感器（名称 + 设备 ID）、时间窗口与数据时间（北京时间）
    expect(lines.slice(0, 4)).toEqual([
      '项目,测试项目0829（240829001）',
      `传感器,KC2（${KC2.id}）`,
      '时间窗口,24小时：2026-11-23 08:00 至 2026-11-24 07:42（北京时间）',
      '数据时间,2026-11-24 07:42',
    ])
    const csv = lines.join('\n')
    expect(csv).toContain('温度 (°C),25.0,25.0,25.0,18 – 22,0%,1,24')
    expect(csv).toContain('CO₂ (ppm),900,900,900,≤ 800,0%,1,24')
    expect(csv).toContain('达标率口径,统计时段内，小时读数落在标准范围内的时间占比；无数据的小时不计入。温度标准范围分冬夏（5–10 月为夏季），季节按统计窗口结束时刻判定。')
    expect(lines).toContain('指标,平均值,最大值,最小值,标准范围,达标率,有效小时数,应有小时数')
    expect(csv).not.toContain('超标')
  })

  it('统计指标由 208 的有效数据决定：207 的 PM2.5 为 65536（卡片隐藏），208 有历史值时统计照样显示', async () => {
    backend({ '/ctrl/air-sensor-get': () => body207([{ ...KC2, pm25: 65536 }]), '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(KC2.id, 1, { pm25: 12 })]) })
    await signIn('u', 'pw', true)
    mount()
    const card = (await screen.findByText('KC2', { selector: 'b' })).closest('.sensor') as HTMLElement
    expect(within(card).queryByText('PM2.5')).toBeNull()
    await waitFor(() => expect(within(summaryTable()).getByText('PM2.5 (μg/m³)')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'PM2.5' })).toBeTruthy()
  })

  it('208 先成功后刷新失败：统计区提示「统计刷新失败，显示 HH:MM 的数据」并可重试；导出注明', async () => {
    let blob: Blob | undefined
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { blob = b; return 'blob:x' }, revokeObjectURL: () => {} }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    let n = 0
    backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => (++n === 1 ? body208([hourRec(KC2.id, 0, { temperature: 25 })]) : n === 2 ? json({ code: 3, message: '参数错误' }, 400) : body208([hourRec(KC2.id, 0, { temperature: 26 })])) })
    await signIn('u', 'pw', true)
    const client = mount()
    await screen.findByTestId('chart')
    vi.setSystemTime(NOW + 5 * 60_000)
    await act(async () => { await client.refetchQueries({ queryKey: ['ctrl', 208] }) })
    const alert = await screen.findByText(/统计刷新失败，显示 07:42 的数据/)
    // 旧统计仍显示（标明时间）
    expect(screen.getByTestId('chart')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '导出' })) })
    expect(await blob!.text()).toContain('数据时间,2026-11-24 07:42（统计刷新失败，为该时刻的数据）')
    await act(async () => { fireEvent.click(within(alert.closest('[role=alert]') as HTMLElement).getByRole('button', { name: '重试' })) })
    await waitFor(() => expect(screen.queryByText(/统计刷新失败/)).toBeNull())
    const row = within(summaryTable()).getByText('温度 (°C)').closest('tr')!
    expect(row.querySelectorAll('td')[1].textContent).toBe('26.0')
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

  it('208 成功但所有指标都没有有效小时：图显示「暂无数据」；汇总照常出行（「—」+「有效 0/24 小时」），导出可用', async () => {
    backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(KC2.id, 0, { temperature: 65536, humidity: -100, dewPoint: 65536, co2: 65536, pm25: 65536 })]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('该时段暂无数据')
    expect(within(summaryTable()).queryByText('该时段暂无统计数据')).toBeNull()
    const cells = [...within(summaryTable()).getByText('温度 (°C)').closest('tr')!.querySelectorAll('td')].map((td) => td.textContent)
    expect(cells).toEqual(['温度 (°C)', '—', '—', '—', '18 – 22', '—有效 0/24 小时'])
    expect(within(summaryTable()).getAllByText('有效 0/24 小时')).toHaveLength(5)
    expect((screen.getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('没有任何可展示的指标（207 全无数据、208 也没有）：整表空态，导出禁用', async () => {
    const none = { ...KC2, temperature: 65536, humidity: 65536, dewPoint: 65536, pm25: 65536, co2: 65536 }
    backend({ '/ctrl/air-sensor-get': () => body207([none]), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('KC2', { selector: 'b' })
    expect(await within(summaryTable()).findByText('该时段暂无统计数据')).toBeTruthy()
    expect((screen.getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('项目离线 / 无项目 / 无权限 / 控制屏未连接', () => {
  it('项目离线：Layout 显示离线空态、不挂载本页，不发任何 ctrl 请求', async () => {
    localStorage.setItem('hjc-project', 'p2-entity')
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByText('项目离线，暂无数据')
    expect(screen.queryByText('传感器列表', { exact: false })).toBeNull()
    expect(b.calls.filter((c) => c.url.includes('/ctrl/air-sensor'))).toHaveLength(0)
  })

  it('数据层自身也判空：没有项目、项目离线时 hook 不发请求（不依赖 Layout 不挂载）', async () => {
    const b = backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const none = renderHook(() => [useAirSensors(null), useSensorHours(null, undefined, '24小时')], { wrapper })
    const off = renderHook(() => [useAirSensors({ id: 'p2-entity', online: false }), useSensorHours({ id: 'p2-entity', online: false }, { id: 1, online: true }, '24小时')], { wrapper })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(none.result.current.map((v) => v.kind)).toEqual(['no-project', 'idle'])
    expect(off.result.current.map((v) => v.kind)).toEqual(['offline', 'idle'])
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

describe('503 之后不显示旧数据（请求序号）', () => {
  const r503 = () => json({ code: 14, message: '控制屏消息发送失败' }, 503)
  const r500 = () => json({ code: 13, message: '内部错误' }, 500)

  it('207：成功 → 503 → 500 不出旧读数 → 成功后显示新读数', async () => {
    const seq: (() => Response)[] = [() => body207([KC2]), r503, r500, r500, () => body207([{ ...KC2, temperature: 22.5 }])]
    let n = 0
    backend({ '/ctrl/air-sensor-get': () => seq[Math.min(n++, seq.length - 1)](), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    const client = mount()
    await screen.findByText('25.5°')
    const again = async () => { await act(async () => { await client.refetchQueries({ queryKey: ['ctrl', 207] }) }) }
    await again()
    await screen.findByText('控制屏未连接')
    await again() // 500（自动重试一次，仍 500）
    await screen.findByText('空气传感器数据加载失败')
    expect(screen.queryByText('25.5°')).toBeNull()
    expect(screen.queryByText('KC2', { selector: 'b' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    await screen.findByText('22.5°')
  })

  it('208：成功 → 503 → 500 不出旧统计 → 成功后显示新统计', async () => {
    const seq: (() => Response)[] = [() => body208([hourRec(KC2.id, 0, { temperature: 25 })]), r503, r500, r500, () => body208([hourRec(KC2.id, 0, { temperature: 21 })])]
    let n = 0
    backend({ '/ctrl/air-sensor-get': () => body207([KC2]), '/ctrl/air-sensor-data-hour-get': () => seq[Math.min(n++, seq.length - 1)]() })
    await signIn('u', 'pw', true)
    const client = mount()
    await screen.findByTestId('chart')
    const again = async () => { await act(async () => { await client.refetchQueries({ queryKey: ['ctrl', 208] }) }) }
    await again()
    expect(await screen.findAllByText('控制屏未连接')).toHaveLength(2)
    await again()
    expect(await screen.findAllByText('统计数据加载失败：内部错误')).toHaveLength(2)
    expect(screen.queryByTestId('chart')).toBeNull()
    expect(within(summaryTable()).queryByText('温度 (°C)')).toBeNull()
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]) })
    await screen.findByTestId('chart')
    const row = within(summaryTable()).getByText('温度 (°C)').closest('tr')!
    expect(row.querySelectorAll('td')[1].textContent).toBe('21.0')
  })
})

describe('轮询（假定时器，跨多个周期）', () => {
  // 推进假时钟，再让响应处理与 TanStack 的批量通知落地（各推进 1 毫秒，检查点都留了秒级余量）
  const tick = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    for (let i = 0; i < 3; i++) await act(async () => { await realTurn(); await vi.advanceTimersByTimeAsync(1) })
  }
  // 真实的一轮事件循环（setImmediate 不在假定时器接管的列表里）
  const realTurn = () => new Promise<void>((r) => (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(r))
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: NOW })
  const wrapperOf = () => {
    const client = createQueryClient()
    return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  }
  const r503 = () => json({ code: 14, message: '控制屏消息发送失败' }, 503)

  it('207：平时 15 秒；503 期间降到 60 秒继续探测；恢复成功后回到 15 秒', async () => {
    const plan = ['ok', '503', '503', 'ok']
    let n = 0
    const b = backend({ '/ctrl/air-sensor-get': () => (plan[Math.min(n++, plan.length - 1)] === 'ok' ? body207([KC2]) : r503()) })
    await signIn('u', 'pw', true)
    fake()
    const h = renderHook(() => useAirSensors({ id: 'p1-entity', online: true }), { wrapper: wrapperOf() })
    const calls = () => b.callsTo('/ctrl/air-sensor-get').length
    await tick(0)
    expect([calls(), h.result.current.kind]).toEqual([1, 'ready'])
    await tick(SENSOR_POLL_MS) // ≈15 秒：第 2 次，503
    expect([calls(), h.result.current.kind]).toEqual([2, 'unavailable'])
    await tick(2 * SENSOR_POLL_MS) // ≈45 秒：503 后不再按 15 秒
    await tick(SENSOR_UNAVAILABLE_POLL_MS - 2 * SENSOR_POLL_MS - 1000) // ≈74 秒
    expect(calls()).toBe(2)
    await tick(2000) // ≈76 秒：60 秒后的探测，仍 503
    expect([calls(), h.result.current.kind]).toEqual([3, 'unavailable'])
    await tick(SENSOR_UNAVAILABLE_POLL_MS - 2000) // ≈134 秒
    expect(calls()).toBe(3)
    await tick(2000) // ≈136 秒：恢复
    expect([calls(), h.result.current.kind]).toEqual([4, 'ready'])
    await tick(SENSOR_POLL_MS) // 回到 15 秒
    expect(calls()).toBe(5)
    await tick(SENSOR_POLL_MS)
    expect(calls()).toBe(6)
    h.unmount()
  })

  it('208：每 5 分钟一次，跨多个周期；503 期间不变；窗口按请求时刻滚动', async () => {
    let n = 0
    const b = backend({ '/ctrl/air-sensor-data-hour-get': () => (++n === 2 ? r503() : body208([])) })
    await signIn('u', 'pw', true)
    fake()
    const h = renderHook(() => useSensorHours({ id: 'p1-entity', online: true }, { id: KC2.id, online: true }, '24小时'), { wrapper: wrapperOf() })
    const calls = () => b.callsTo('/ctrl/air-sensor-data-hour-get').length
    await tick(0)
    expect(calls()).toBe(1)
    await tick(HOURS_POLL_MS - 2000)
    expect(calls()).toBe(1)
    await tick(2000)
    expect([calls(), h.result.current.kind]).toEqual([2, 'unavailable'])
    await tick(HOURS_POLL_MS - 2000)
    expect(calls()).toBe(2)
    await tick(2000)
    expect([calls(), h.result.current.kind]).toEqual([3, 'ready'])
    await tick(HOURS_POLL_MS)
    expect(calls()).toBe(4)
    const all = b.callsTo('/ctrl/air-sensor-data-hour-get').map(q208)
    expect(all[3].endTime - all[0].endTime).toBeGreaterThanOrEqual(3 * HOURS_POLL_MS)
    expect(all[3].endTime - all[0].endTime).toBeLessThan(3 * HOURS_POLL_MS + 10_000)
    h.unmount()
  })
})

describe('207 真实解码形状：-100 过滤，合法负值保留', () => {
  it('温度 / PM2.5 为 -100 不显示（卡片、KPI）；露点 -3.5 照常显示', async () => {
    backend({ '/ctrl/air-sensor-get': () => body207([{ ...KC2, temperature: -100, pm25: -100, dewPoint: -3.5 }]), '/ctrl/air-sensor-data-hour-get': () => body208([]) })
    await signIn('u', 'pw', true)
    mount()
    const card = (await screen.findByText('KC2', { selector: 'b' })).closest('.sensor') as HTMLElement
    expect(within(card).queryByText('温度')).toBeNull()
    expect(within(card).queryByText('PM2.5')).toBeNull()
    expect(within(card).getByText('-3.5°')).toBeTruthy()
    expect(screen.queryByText('平均 温度')).toBeNull()
    expect(screen.queryByText('平均 PM2.5')).toBeNull()
    const kpi = screen.getByText('平均 露点').closest('.kpi') as HTMLElement
    expect(kpi.querySelector('.k-val')!.textContent).toBe('-3.5°C')
    expect(document.body.textContent).not.toMatch(/-100/)
  })

  it('导出负温度：CSV 里是数值（不加 \' 前缀）', async () => {
    let blob: Blob | undefined
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { blob = b; return 'blob:x' }, revokeObjectURL: () => {} }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    backend({ '/ctrl/air-sensor-get': () => body207([{ ...KC2, temperature: -3.5 }]), '/ctrl/air-sensor-data-hour-get': () => body208([hourRec(KC2.id, 0, { temperature: -3.5, dewPoint: -12 })]) })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByTestId('chart')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '导出' })) })
    const csv = await blob!.text()
    expect(csv).toContain('温度 (°C),-3.5,-3.5,-3.5,18 – 22,0%,1,24')
    expect(csv).toContain('露点 (°C),-12.0,-12.0,-12.0,≤ 17.0,100%,1,24')
  })
})

describe('一份 208 的 503 让同项目其他 208 缓存作废后，切回时主动重取', () => {
  const r503 = () => json({ code: 14, message: '控制屏消息发送失败' }, 503)

  it('设备 A 缓存 → 切 B 遇 503 → 切回 A：A 重新请求并显示新数据，不卡在加载中', async () => {
    const A = { ...KC2, id: 1, name: '客厅' }
    const B = { ...KC2, id: 2, name: '书房' }
    let aCalls = 0
    backend({
      '/ctrl/air-sensor-get': () => body207([A, B]),
      '/ctrl/air-sensor-data-hour-get': (c) => (q208(c).deviceId === 2 ? r503() : body208([hourRec(1, 0, { temperature: ++aCalls === 1 ? 20 : 21 })])),
    })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByTestId('chart')
    await act(async () => { fireEvent.click(screen.getByText('书房', { selector: 'b' }).closest('.sensor')!) })
    expect(await screen.findAllByText('控制屏未连接')).toHaveLength(2)
    await act(async () => { fireEvent.click(screen.getByText('客厅', { selector: 'b' }).closest('.sensor')!) })
    await screen.findByTestId('chart')
    expect(aCalls).toBe(2)
    const row = within(summaryTable()).getByText('温度 (°C)').closest('tr')!
    expect(row.querySelectorAll('td')[1].textContent).toBe('21.0')
  })

  it('不同范围：24 小时缓存 → 切 7 日遇 503 → 切回 24 小时：重新请求并显示', async () => {
    let n24 = 0
    backend({
      '/ctrl/air-sensor-get': () => body207([KC2]),
      '/ctrl/air-sensor-data-hour-get': (c) => (q208(c).startTime < cst('2026-11-23T00:00:00') ? r503() : body208([hourRec(KC2.id, 0, { temperature: ++n24 === 1 ? 20 : 21 })])),
    })
    await signIn('u', 'pw', true)
    mount()
    await screen.findByTestId('chart')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '7日' })) })
    expect(await screen.findAllByText('控制屏未连接')).toHaveLength(2)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '24小时' })) })
    await screen.findByTestId('chart')
    expect(n24).toBe(2)
    const row = within(summaryTable()).getByText('温度 (°C)').closest('tr')!
    expect(row.querySelectorAll('td')[1].textContent).toBe('21.0')
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
