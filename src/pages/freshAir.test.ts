// @vitest-environment jsdom
// 新风页（S10b）：真实接口模式 + 假后端（ctrl 202 / 210 按 protobuf 编码，部分用 11/25 实测原文），不连任何真实服务。
// 覆盖：只读（afterEach 对每个用例断言不发任何写请求；本文件的账号没有 204 权限，面板是只读形态、下发按钮禁用）；非 12 项目没有设置面板也不发 210；control_type = -1 只禁用控制类型、
// 露点、湿度，风速、开关照常；-1 / -100 显示 --，0 是有效值；210「不支持」友好提示；未连接设备不显示读数、不读 210；
// 切换设备后 210 跟着换；各状态（无权限、失败可重试、空）；滤网告警受 freshAirFilterWarn 控制。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter as Router, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinaryWriter, WireType, base64Encode } from '@bufbuild/protobuf/wire'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { BLOCK_204_CONTROL_TYPE, BLOCK_204_NOT_SETTABLE } from '../api/writeLockVerify'
import { fakeBackend, json, type Call } from '../api/__tests__/helpers'
import { isWritePath } from '../api/guard'
import { AppProvider } from '../app/store'
import Layout from '../components/Layout'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetFreshAirForTests, FRESH_ROUTES, TEXT_CT_INVALID, TEXT_UNSUPPORTED, TEXT_WRITE_FORBIDDEN } from '../features/freshAir'
import { ID_260911001, R202_240829001, R202_260911001, R210_240829001, R210_260911001 } from '../features/freshAir/__tests__/fixtures'
import FreshAir, { TEXT_UNSUPPORTED_PANEL } from './FreshAir'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001', name: '测试项目0829', app_code: '1', online: true }
const P12 = { id: '6aa3a0ade8f3372b86b15b05', code: '260911001', name: '独立空气系统测试', app_code: '12', online: true }
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: [P1.id, P12.id] }]
const PERMS = [FRESH_ROUTES.units, FRESH_ROUTES.settings]
const R202 = '/ctrl/fresh-dehumidifier-get'
const R210 = '/ctrl/running-ctrl-get'

type Handler = (call: Call, n: number) => Response | Promise<Response>
const body202 = (data: object[]) => json({ body: encodeMessage(pb.FreshDehumidifierGetReplySchema, { data }) })
const body210 = (v: object) => json({ body: encodeMessage(pb.RunningCtrlGetReplySchema, v) })
const ctrlError = (msg: string) => json({ body: base64Encode(new BinaryWriter().tag(2, WireType.LengthDelimited).string(msg).finish()) })
const q210 = (c: Call) => (decodeReply(pb.RunningCtrlGetQuerySchema, (c.body as { body: string }).body) as { deviceId: bigint | number }).deviceId

/** 本用例的假后端：afterEach 统一断言整页没有发出任何写请求（判定与写防护同一个 isWritePath） */
let current: { calls: Call[] } | null = null
const pathOf = (c: Call) => new URL(c.url, 'http://x').pathname.replace(/^\/api/, '')
function backend(routes: Record<string, Handler> = {}, opts: { perms?: string[]; projects?: object[] } = {}) {
  return current = fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: opts.perms ?? PERMS }),
    '/ctrl/projects': () => json({ project_entities: opts.projects ?? [P1, P12] }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    ...routes,
  })
}

function mount(projectId: string) {
  localStorage.setItem('hjc-project', projectId)
  const client = createQueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(Router, { initialEntries: ['/fresh-air'] }, createElement(Routes, null,
      createElement(Route, { element: createElement(Layout) }, createElement(Route, { path: '/fresh-air', element: createElement(FreshAir) })))))))
  return client
}

const panel = () => screen.getByRole('region', { name: '运行设置' })
const row = (f: string) => panel().querySelector(`[data-field="${f}"]`) as HTMLElement
const lockOf = (f: string) => within(row(f)).queryByRole('img', { name: /不能设置/ })
const valueOf = (f: string) => row(f).querySelector('.sv')!.textContent

const UNIT = (o: object = {}) => ({ id: 11, name: 'TXFS500', supplyTemp: 18.5, returnTemp: 25.5, windLevel: 2, windSpeed: 1300, dehumidifierStatus: 1, dehumidifierFreq: 48, filterLife: 30, filterLifeP: 0, filterRunning: 1200, runningMode: '除湿', runningTime: 36, switch: 1, isConnected: true, ...o })

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); __resetFreshAirForTests(); clearTokens()
})
afterEach(() => {
  const calls = current?.calls ?? []
  current = null
  cleanup(); vi.unstubAllGlobals(); setConfig(null)
  expect(calls.filter((c) => isWritePath(pathOf(c))).map(pathOf)).toEqual([])
})

it('写请求判定有效：204 的路由会被识别为写，202 / 210 不会', () => {
  expect(isWritePath('/ctrl/running-ctrl-set')).toBe(true)
  expect(isWritePath(R202)).toBe(false)
  expect(isWritePath(R210)).toBe(false)
})

describe('实测回包', () => {
  it('240829001（app_code 1）：显示 1 台设备和 202 读数；没有运行设置面板，不发 210，也不发任何写请求', async () => {
    const b = backend({ [R202]: () => json({ body: R202_240829001 }), [R210]: () => json({ body: R210_240829001 }) })
    await signIn('u', 'pw', true)
    mount(P1.id)
    await screen.findByText('实时数据', { exact: false })
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByText('1 台新风除湿一体机', { exact: false })).toBeTruthy()
    // 202 实测：running_mode 除湿、running_time 1、filter_life 100 天、filter_life_p 1（100%）
    expect(screen.getAllByText('除湿').length).toBeGreaterThan(0)
    expect(screen.getByTestId('filter-text').textContent).toBe('剩余 100 天')
    expect(screen.queryByRole('region', { name: '运行设置' })).toBeNull()
    // S13 P5：没有面板时页头说明原因，不让人以为加载失败
    expect(document.querySelector('.page-head .sub')!.textContent).toContain('该应用类型不支持在平台上设置运行参数，仅显示运行数据')
    expect((b.callsTo(R202)[0].body as { project_id: string }).project_id).toBe(P1.id)
    expect(b.callsTo(R210)).toHaveLength(0)
  })

  it('260911001（app_code 12）：210 实测 humidity_set = -1 → 湿度设定 -- 且不可设置；风速「自动」、开关「关」（缺省 0）可设置', async () => {
    const b = backend({ [R202]: () => json({ body: R202_260911001 }), [R210]: () => json({ body: R210_260911001 }) })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await waitFor(() => expect(row('humiditySet')).toBeTruthy())
    expect(Number(q210(b.callsTo(R210)[0]))).toBe(ID_260911001)
    // S13 P10：202 没带名称时用 210 的名称 TXFS500（与确认框、下发请求一致），不写「新风设备 1」
    expect(screen.getAllByRole('tab')[0].textContent).toContain('TXFS500')
    expect(document.body.textContent).not.toContain('新风设备 1')
    expect(document.querySelector('.page-head .sub')!.textContent).toContain('新风单机版')
    expect(valueOf('humiditySet')).toBe('--')
    expect(lockOf('humiditySet')!.getAttribute('aria-label')).toContain(BLOCK_204_NOT_SETTABLE)
    expect(valueOf('dewPoint')).toBe('13.0 °C')
    expect(valueOf('controlType')).toBe('湿度控制')
    expect(valueOf('windSpeed')).toBe('自动')
    expect(valueOf('switch')).toBe('关')
    for (const f of ['controlType', 'dewPoint', 'windSpeed', 'switch']) expect(lockOf(f)).toBeNull()
    // 本文件的账号没有 204 权限（PERMS 只有 202 / 210）：保留 S10b 的只读形态，下发按钮禁用并写明原因（S10c 的下发见 freshAirWrite.test.ts）
    const send = within(panel()).getByRole('button', { name: '下发设置' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(within(panel()).getByText(TEXT_WRITE_FORBIDDEN)).toBeTruthy()
  })

  it('210 回「该软件类型不支持此控制」：面板友好提示，不是错误态，不重试', async () => {
    const b = backend({ [R202]: () => json({ body: R202_260911001 }), [R210]: () => json({ body: R210_240829001 }) })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await within(await screen.findByRole('region', { name: '运行设置' })).findByText(TEXT_UNSUPPORTED)
    expect(within(panel()).getByText(TEXT_UNSUPPORTED_PANEL)).toBeTruthy()
    expect(within(panel()).queryByRole('alert')).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '重试' })).toBeNull()
    expect(b.callsTo(R210)).toHaveLength(1)
  })
})

describe('运行设置的口径', () => {
  it('control_type = -1：控制类型、露点、湿度不可设置（--）；风速、开关照常显示且可设置', async () => {
    backend({ [R202]: () => body202([UNIT()]), [R210]: () => body210({ id: 11, name: 'TXFS500', controlType: -1, dewPoint: 12, humiditySet: 50, windSpeed: 1, switch: 1 }) })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await waitFor(() => expect(row('windSpeed')).toBeTruthy())
    expect([valueOf('controlType'), valueOf('dewPoint'), valueOf('humiditySet')]).toEqual(['--', '--', '--'])
    expect(lockOf('controlType')!.getAttribute('aria-label')).toContain(BLOCK_204_NOT_SETTABLE)
    expect(lockOf('dewPoint')!.getAttribute('aria-label')).toContain(BLOCK_204_CONTROL_TYPE)
    expect(lockOf('humiditySet')!.getAttribute('aria-label')).toContain(BLOCK_204_CONTROL_TYPE)
    expect([valueOf('windSpeed'), valueOf('switch')]).toEqual(['高', '开'])
    expect(lockOf('windSpeed')).toBeNull()
    expect(lockOf('switch')).toBeNull()
  })

  it('-100 显示 --（无效）；0 是有效值：露点 0.0 °C、风速「低」、湿度控制', async () => {
    backend({ [R202]: () => body202([UNIT()]), [R210]: () => body210({ id: 11, controlType: 0, dewPoint: 0, humiditySet: -100, windSpeed: 0, switch: 1 }) })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await waitFor(() => expect(row('dewPoint')).toBeTruthy())
    expect(valueOf('dewPoint')).toBe('0.0 °C')
    expect(valueOf('humiditySet')).toBe('--')
    expect(lockOf('humiditySet')).not.toBeNull()
    expect(valueOf('windSpeed')).toBe('低')
    expect(valueOf('controlType')).toBe('湿度控制')
    expect(lockOf('dewPoint')).toBeNull()
  })

  it('can_change 为假时注明控制类型不可切换；露点控制时露点设定标「生效中」', async () => {
    backend({ [R202]: () => body202([UNIT()]), [R210]: () => body210({ id: 11, controlType: 1, dewPoint: 12.5, humiditySet: 50, windSpeed: 2, switch: 1, canChange: false }) })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await waitFor(() => expect(row('dewPoint')).toBeTruthy())
    expect(within(panel()).getByText('该设备的控制类型不可切换')).toBeTruthy()
    expect(within(row('dewPoint')).getByText('生效中')).toBeTruthy()
    expect(within(row('humiditySet')).queryByText('生效中')).toBeNull()
  })
})

describe('202 读数', () => {
  it('开关读数无效（-100）时显示 --、状态「开关未知」，不当成关机', async () => {
    backend({ [R202]: () => body202([UNIT({ switch: -100 })]) }, { projects: [P1] })
    await signIn('u', 'pw', true)
    mount(P1.id)
    const summary = (await screen.findByText('设备汇总')).closest('[data-slot=card]') as HTMLElement
    const cells = within(summary).getAllByRole('row')[1].querySelectorAll('td')
    expect(cells[1].textContent).toBe('--')
    expect(screen.getAllByText('开关未知').length).toBeGreaterThan(0)
    expect(screen.queryByText('已关机')).toBeNull()
  })
  it('实时数据只放接口有的字段；65536 / -100 显示 --，0 是有效值', async () => {
    backend({ [R202]: () => body202([UNIT({ supplyTemp: 65536, returnTemp: -100, windLevel: 0, dehumidifierStatus: 0, dehumidifierFreq: 0 })]) }, { projects: [P1] })
    await signIn('u', 'pw', true)
    mount(P1.id)
    const card = (await screen.findByText('实时数据', { exact: false })).closest('[data-slot=card]') as HTMLElement
    const tile = (l: string) => within(card).getByText(l).nextSibling!.textContent
    expect(tile('送风温度')).toBe('--')
    expect(tile('回风温度')).toBe('--')
    expect(tile('风速档位')).toBe('0')
    expect(tile('压缩机状态')).toBe('停止')
    expect(tile('压缩机频率')).toBe('0 Hz')
    expect(tile('风机转速')).toBe('1300')
    expect(tile('运行时间')).toBe('36')
    for (const gone of ['新风温度', '送风湿度', '送风露点', '新风量', '回风湿度']) expect(within(card).queryByText(gone)).toBeNull()
    const summary = screen.getByText('设备汇总').closest('[data-slot=card]') as HTMLElement
    expect(within(summary).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['设备', '开关', '模式', '运行时间', '滤网运行时间', '滤网寿命'])
  })

  it('未连接的设备：不显示读数（汇总里也是 --），不读它的 210', async () => {
    const b = backend({ [R202]: () => body202([UNIT({ isConnected: false })]), [R210]: () => body210({ id: 11 }) })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await screen.findByText('设备未连接，暂不读取运行设置。')
    expect(screen.getByText('控制屏报告这台设备未连接，暂无实时数据。')).toBeTruthy()
    expect(screen.queryByText('送风温度')).toBeNull()
    const summary = screen.getByText('设备汇总').closest('[data-slot=card]') as HTMLElement
    const cells = within(summary).getAllByRole('row')[1].querySelectorAll('td')
    expect([...cells].map((c) => c.textContent)).toEqual(['TXFS500', '未连接', '--', '--', '--', '--'])
    expect(b.callsTo(R210)).toHaveLength(0)
  })

  it('滤网：告警开关关着（默认）不显示「请尽快更换」；打开后按比例显示', async () => {
    backend({ [R202]: () => body202([UNIT({ filterLifeP: 0, filterLife: 3 })]) }, { projects: [P1] })
    await signIn('u', 'pw', true)
    mount(P1.id)
    expect((await screen.findByTestId('filter-text')).textContent).toBe('剩余 3 天')
    cleanup(); __resetFreshAirForTests()
    setConfig({ apiBase: '/api', dataSource: 'real', features: { freshAirFilterWarn: true } })
    mount(P1.id)
    await waitFor(() => expect(screen.getByTestId('filter-text').textContent).toBe('滤网寿命不足，请尽快更换（剩余 3 天）'))
  })
})

describe('设备切换与状态', () => {
  it('切换设备页签后 210 用新设备的 id 读，面板换成新设备的设置', async () => {
    const b = backend({
      [R202]: () => body202([UNIT({ id: 11, name: 'A 机' }), UNIT({ id: 22, name: 'B 机' })]),
      [R210]: (c) => body210(Number(q210(c)) === 11 ? { id: 11, controlType: 1, dewPoint: 12, windSpeed: 0, switch: 1 } : { id: 22, controlType: 0, humiditySet: 55, windSpeed: 1, switch: 1 }),
    })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await waitFor(() => expect(valueOf('controlType')).toBe('露点控制'))
    const tabs = screen.getAllByRole('tab')
    await act(async () => { fireEvent.mouseDown(tabs[1], { button: 0 }); fireEvent.click(tabs[1]) })
    await waitFor(() => expect(valueOf('humiditySet')).toBe('55 %RH'))
    expect(b.callsTo(R210).map((c) => Number(q210(c)))).toEqual([11, 22])
    expect(valueOf('controlType')).toBe('湿度控制')
  })

  it('没有 202 权限：显示未开通，不发请求', async () => {
    const b = backend({ [R202]: () => body202([UNIT()]) }, { perms: [] })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await screen.findByText('未开通新风数据')
    expect(b.callsTo(R202)).toHaveLength(0)
  })

  it('有 202、没有 210 权限：面板显示未开通，不发 210', async () => {
    const b = backend({ [R202]: () => body202([UNIT()]), [R210]: () => body210({ id: 11 }) }, { perms: [FRESH_ROUTES.units] })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await screen.findByText('未开通运行设置')
    expect(b.callsTo(R210)).toHaveLength(0)
  })

  it('202 失败：错误态可重试，重试成功后显示设备', async () => {
    let fail = true
    backend({ [R202]: () => (fail ? ctrlError('读取失败X') : body202([UNIT()])) }, { projects: [P1] })
    await signIn('u', 'pw', true)
    mount(P1.id)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('新风数据加载失败')
    fail = false
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: '重试' })) })
    await screen.findByText('设备汇总')
  })

  it('202 返回空列表：空态', async () => {
    backend({ [R202]: () => body202([]) }, { projects: [P1] })
    await signIn('u', 'pw', true)
    mount(P1.id)
    await screen.findByText('暂无新风除湿机数据')
  })

  it('210 失败：面板错误态可重试，202 读数照常显示', async () => {
    backend({ [R202]: () => body202([UNIT()]), [R210]: () => ctrlError('控制屏忙') })
    await signIn('u', 'pw', true)
    mount(P12.id)
    const alert = await within(await screen.findByRole('region', { name: '运行设置' })).findByRole('alert')
    expect(alert.textContent).toContain('运行设置读取失败')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.getByText('送风温度')).toBeTruthy()
  })

  it('加载中：202、210 各自显示读取中', async () => {
    let release202!: () => void
    const gate202 = new Promise<void>((r) => { release202 = r })
    let release210!: () => void
    const gate210 = new Promise<void>((r) => { release210 = r })
    backend({ [R202]: async () => { await gate202; return body202([UNIT()]) }, [R210]: async () => { await gate210; return body210({ id: 11, controlType: 1, dewPoint: 12, windSpeed: 0, switch: 1 }) } })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await screen.findByText('正在从控制屏读取新风除湿机数据…')
    await act(async () => { release202() })
    await within(await screen.findByRole('region', { name: '运行设置' })).findByText('正在从控制屏读取运行设置…')
    await act(async () => { release210() })
    await waitFor(() => expect(valueOf('controlType')).toBe('露点控制'))
  })

  it('控制屏未连接（503）：显示控制屏未连接，不显示旧读数', async () => {
    backend({ [R202]: () => json({ code: 14, message: '控制屏消息发送失败' }, 503) }, { projects: [P1] })
    await signIn('u', 'pw', true)
    mount(P1.id)
    await screen.findByText('控制屏暂时无法连接，稍后会自动重试。')
    expect(screen.queryByText('设备汇总')).toBeNull()
  })

  it('有数据后刷新失败（500）：仍显示上次读数，页头注明「刷新失败，显示 … 的数据」', async () => {
    let fail = false
    backend({ [R202]: () => (fail ? json({ message: 'boom' }, 500) : body202([UNIT()])) }, { projects: [P1] })
    await signIn('u', 'pw', true)
    const client = mount(P1.id)
    await screen.findByText('设备汇总')
    fail = true
    await act(async () => { await client.refetchQueries().catch(() => {}) })
    await waitFor(() => expect(document.querySelector('.page-head')!.textContent).toContain('刷新失败，显示'), { timeout: 5000 })
    expect(screen.getByText('设备汇总')).toBeTruthy()
  })

  it('control_type 无效（-100）：控制类型 --，露点、湿度连带不可设置；风速、开关照常', async () => {
    backend({ [R202]: () => body202([UNIT()]), [R210]: () => body210({ id: 11, controlType: -100, dewPoint: 12, humiditySet: 50, windSpeed: 2, switch: 1 }) })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await waitFor(() => expect(row('controlType')).toBeTruthy())
    expect([valueOf('controlType'), valueOf('dewPoint'), valueOf('humiditySet')]).toEqual(['--', '--', '--'])
    expect(lockOf('dewPoint')!.getAttribute('aria-label')).toContain(TEXT_CT_INVALID)
    expect([valueOf('windSpeed'), valueOf('switch')]).toEqual(['自动', '开'])
    expect(lockOf('windSpeed')).toBeNull()
    expect(within(panel()).queryByText('该设备的控制类型不可切换')).toBeNull()
  })
})
