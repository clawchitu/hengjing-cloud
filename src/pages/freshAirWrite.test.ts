// @vitest-environment jsdom
// S10c 新风运行设置下发（ctrl 204）页面用例：真实接口模式 + 假后端（202 / 210 / 204 按 protobuf 编解码），不连任何真实服务。
// 204 一律经真实写入口（writeCtrl → encodeWrite / assertNoImplicitZero → requestWrite → guard.ts → fetch），这里只把 fetch 换成假后端，
// 解码实际发出的请求体断言：只有改了的字段不是 -1，其余 -1；明确选的 0（低、关、湿度控制）照发。
// 覆盖：control_type = -1 时露点 / 湿度禁用、风速 / 开关可设；确认取消 / 离开 / 切项目不发；预检读数变化不发；四态与 settling；
// 只比对改动字段；freshAirWrite = off、没有 204 权限、非 12 项目、210「不支持」都没有下发入口。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { toast as sonner } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinaryWriter, WireType, base64Encode } from '@bufbuild/protobuf/wire'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { __resetWriteLockForTests, lockOf, RETRY_DELAYS_MS } from '../api/writeLock'
import { BLOCK_204_CONTROL_TYPE } from '../api/writeLockVerify'
import { fakeBackend, json, type Call } from '../api/__tests__/helpers'
import { isWritePath } from '../api/guard'
import { AppProvider } from '../app/store'
import { OrgGate } from '../app/OrgGate'
import Layout from '../components/Layout'
import { __resetCurrentForTests, setStoredProjectId } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetFreshAirForTests, FRESH_ROUTES, TEXT_DEVICE_OFF, TEXT_STALE, TEXT_WRITE_FORBIDDEN, TEXT_WRITE_OFF } from '../features/freshAir'
import { __resetWritesForTests } from '../features/thermostat/writes'
import FreshAir from './FreshAir'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

/** 带 sub 的假 JWT（写入口要求令牌能解析出账号才发） */
const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub }))}.s`
const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001', name: '测试项目0829', app_code: '1', online: true, control_screen_id: 'SCREEN-T' }
const P12 = { id: '6aa3a0ade8f3372b86b15b05', code: '260911001', name: '独立空气系统测试', app_code: '12', online: true, control_screen_id: 'SCREEN-T' }
/** 另一个 app 12 项目（不在下发名单里，切项目用） */
const P12B = { id: 'p12b', code: '261124012', name: '另一个新风项目', app_code: '12', online: true }
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: [P1.id, P12.id, P12B.id] }]
const PERMS = [FRESH_ROUTES.units, FRESH_ROUTES.settings, FRESH_ROUTES.write]
const R202 = '/ctrl/fresh-dehumidifier-get'
const R210 = '/ctrl/running-ctrl-get'
const R204 = '/ctrl/running-ctrl-set'
const ID = 1514027092

type Handler = (call: Call, n: number) => Response | Promise<Response>
const UNIT = (o: object = {}) => ({ id: ID, name: 'TXFS500', supplyTemp: 18.5, returnTemp: 25.5, windLevel: 2, windSpeed: 1300, dehumidifierStatus: 1, dehumidifierFreq: 20, filterLife: 100, filterLifeP: 1, runningMode: '除湿', runningTime: 5, switch: 1, isConnected: true, ...o })
/** 11/25 10:08 实测 260911001 的 210（开关改为开，便于改风速）：湿度控制、露点 13、湿度 55、风速自动、can_change */
const S210 = (o: object = {}) => ({ id: ID, name: 'TXFS500', controlType: 0, dewPoint: 13, humiditySet: 55, windSpeed: 2, switch: 1, canChange: true, ...o })

/** 可变的读数：测试里改它，下一次读取就读到 */
let units: object[] = []
let r210: Record<string, unknown> = {}
let apply204 = true
const body204 = (c: Call) => decodeReply(pb.RunningCtrlSetQuerySchema, (c.body as { body: string }).body) as Record<string, number | string>
/** 204 应答 success；apply204 为真时设备真的按下发值生效（之后的 210 读到新值） */
const ok204: Handler = (c) => {
  if (apply204) {
    const q = body204(c)
    for (const k of ['controlType', 'dewPoint', 'humiditySet', 'windSpeed', 'switch']) if (q[k] !== -1) r210 = { ...r210, [k]: q[k] }
  }
  return json({ body: encodeMessage(pb.RunningCtrlSetReplySchema, { success: true }) })
}
const ctrlError = (msg: string) => json({ body: base64Encode(new BinaryWriter().tag(2, WireType.LengthDelimited).string(msg).finish()) })

let current: ReturnType<typeof fakeBackend> | null = null
function backend(routes: Record<string, Handler> = {}, opts: { perms?: string[] } = {}) {
  return current = fakeBackend({
    '/auth/login': () => json({ access_token: jwt('admin-1'), refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: opts.perms ?? PERMS }),
    '/ctrl/projects': () => json({ project_entities: [P1, P12, P12B] }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    '/auth/invalidate': () => json({}),
    [R202]: () => json({ body: encodeMessage(pb.FreshDehumidifierGetReplySchema, { data: units }) }),
    [R210]: () => json({ body: encodeMessage(pb.RunningCtrlGetReplySchema, r210) }),
    [R204]: ok204,
    ...routes,
  })
}
const pathOf = (c: Call) => new URL(c.url, 'http://x').pathname.replace(/^\/api/, '')
const writes = (be: ReturnType<typeof fakeBackend>) => be.calls.filter((c) => isWritePath(pathOf(c)))

function Away() {
  const nav = useNavigate()
  return createElement('span', null, createElement('button', { onClick: () => nav('/home') }, '去首页'))
}
function mount(projectId: string) {
  localStorage.setItem('hjc-project', projectId)
  const client = createQueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: ['/fresh-air'] },
      createElement(Away),
      createElement(Routes, null,
        createElement(Route, { element: createElement(OrgGate, null, createElement(Layout)) },
          createElement(Route, { path: '/fresh-air', element: createElement(FreshAir) }),
          createElement(Route, { path: '/home', element: createElement('div', null, '首页内容') })))))))
  return client
}

let toastLog: string[] = []
const toasts = () => toastLog.join('\n')
const flush = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const fakeClock = () => vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
async function runRetries() { for (const d of RETRY_DELAYS_MS) { await advance(d); await flush() } }

const panel = () => screen.getByRole('region', { name: '运行设置' })
const group = (name: string) => within(panel()).getByRole('group', { name })
const opt = (g: string, t: string) => within(group(g)).getByRole('button', { name: t }) as HTMLButtonElement
const sendBtn = () => within(panel()).getByRole('button', { name: '下发设置' }) as HTMLButtonElement
const stepBtn = (label: string) => within(panel()).getByRole('button', { name: label }) as HTMLButtonElement
const dialog = () => screen.findByRole('alertdialog')
const rawButton = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
const confirmOk = async () => fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))

async function open(projectId = P12.id) {
  await signIn('u', 'pw', true)
  mount(projectId)
  await waitFor(() => expect(within(panel()).queryByRole('group', { name: '风速' })).toBeTruthy())
}
/** 风速 自动 → 高，点下发（弹出确认） */
async function draftWindAndSend(to = '高') {
  await open()
  fireEvent.click(opt('风速', to))
  fireEvent.click(sendBtn())
  return dialog()
}

beforeEach(() => {
  toastLog = []
  units = [UNIT()]
  r210 = S210()
  apply204 = true
  for (const k of ['success', 'error'] as const) vi.spyOn(sonner, k).mockImplementation((m) => { toastLog.push(String(m)); return 0 })
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); __resetFreshAirForTests(); __resetWritesForTests(); __resetWriteLockForTests(); clearTokens()
})
afterEach(() => {
  const calls = current?.calls ?? []
  current = null
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null)
  // 任何用例都只可能发 204，不会发别的写消息
  expect(calls.filter((c) => isWritePath(pathOf(c))).map(pathOf).filter((p) => p !== R204)).toEqual([])
})

describe('204 组装（经真实写入口，解码实际请求体）', () => {
  it('风速 自动 → 高：确认文案含项目名、编号、设备和原值 → 新值；只发一条 204，wind_speed = 1，其余 -1，id / name 取预检读数；回读一致才提示已生效并清草稿、放锁', async () => {
    const be = backend()
    await open()
    fireEvent.click(opt('风速', '高'))
    expect(panel().textContent).toContain('待下发：风速 自动 → 高')
    expect(writes(be)).toHaveLength(0)
    fireEvent.click(sendBtn())
    const dlg = await dialog()
    for (const t of ['独立空气系统测试', '260911001', 'TXFS500', '风速 自动 → 高']) expect(dlg.textContent).toContain(t)
    expect(writes(be)).toHaveLength(0)
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(toasts()).toContain('TXFS500 已生效：风速 高'))
    const w = writes(be)
    expect(w).toHaveLength(1)
    expect(w[0].url).toBe('/api/ctrl/running-ctrl-set')
    expect((w[0].body as { project_id: string }).project_id).toBe(P12.id)
    expect(body204(w[0])).toEqual({ id: ID, name: 'TXFS500', controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 1, switch: -1 })
    await waitFor(() => expect(panel().textContent).not.toContain('待下发'))
    expect(lockOf(P12 as never)).toBeNull()
  })

  for (const [what, act0, want] of [
    ['风速 高 → 低（明确的 0）', () => { r210 = S210({ windSpeed: 1 }); return () => fireEvent.click(opt('风速', '低')) }, { windSpeed: 0 }],
    ['开关 开 → 关（明确的 0）', () => () => fireEvent.click(opt('开关', '关')), { switch: 0 }],
    ['控制类型 露点 → 湿度（明确的 0）', () => { r210 = S210({ controlType: 1 }); return () => fireEvent.click(opt('控制类型', '湿度控制')) }, { controlType: 0 }],
  ] as const) {
    it(`${what}：0 原样上线，其余 -1`, async () => {
      const go = act0()
      const be = backend()
      await open()
      go()
      fireEvent.click(sendBtn())
      await confirmOk()
      await waitFor(() => expect(writes(be)).toHaveLength(1))
      expect(body204(writes(be)[0])).toEqual({ id: ID, name: 'TXFS500', controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: -1, switch: -1, ...want })
    })
  }

  it('湿度设定 55 → 56：只有 humidity_set，控制类型等 -1；露点不生效（湿度控制）时步进禁用', async () => {
    const be = backend()
    await open()
    expect(stepBtn('露点设定升高').disabled).toBe(true)
    fireEvent.click(stepBtn('湿度设定升高'))
    fireEvent.click(sendBtn())
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body204(writes(be)[0])).toEqual({ id: ID, name: 'TXFS500', controlType: -1, dewPoint: -1, humiditySet: 56, windSpeed: -1, switch: -1 })
  })

  it('没有改动时下发按钮禁用', async () => {
    backend()
    await open()
    expect(sendBtn().disabled).toBe(true)
    fireEvent.click(opt('风速', '高'))
    expect(sendBtn().disabled).toBe(false)
    fireEvent.click(opt('风速', '自动')) // 改回读数值 = 没有改动
    expect(sendBtn().disabled).toBe(true)
  })
})

describe('可改项', () => {
  it('control_type = -1：控制类型、露点、湿度禁用（锁图标写明原因）；风速、开关照常可设，只改风速能发', async () => {
    r210 = S210({ controlType: -1, dewPoint: -1, humiditySet: -1 })
    const be = backend()
    await open()
    for (const t of ['露点控制', '湿度控制']) expect(opt('控制类型', t).disabled).toBe(true)
    for (const l of ['露点设定升高', '露点设定降低', '湿度设定升高', '湿度设定降低']) expect(stepBtn(l).disabled).toBe(true)
    const why = (f: string) => within(panel().querySelector(`[data-field="${f}"]`) as HTMLElement).getByRole('img', { name: /不能设置/ }).getAttribute('aria-label')
    expect(why('controlType')).toContain('控制类型不能设置')
    for (const f of ['dewPoint', 'humiditySet']) expect(why(f)).toContain(BLOCK_204_CONTROL_TYPE)
    for (const t of ['低', '高', '自动']) expect(opt('风速', t).disabled).toBe(false)
    for (const t of ['开', '关']) expect(opt('开关', t).disabled).toBe(false)
    fireEvent.click(opt('风速', '低'))
    fireEvent.click(sendBtn())
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('已生效：风速 低'))
    expect(body204(writes(be)[0])).toEqual({ id: ID, name: 'TXFS500', controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 0, switch: -1 })
  })

  it('210 某项读到 -1：只禁用那一项（11/25 实测 humidity_set = -1），其余照常', async () => {
    r210 = S210({ humiditySet: -1 })
    backend()
    await open()
    expect(stepBtn('湿度设定升高').disabled).toBe(true)
    expect(opt('风速', '高').disabled).toBe(false)
    expect(opt('控制类型', '露点控制').disabled).toBe(false)
  })

  it('设备关着：只能改开关（其余禁用，提示先开启）；can_change = false：控制类型不可切换', async () => {
    r210 = S210({ switch: 0, canChange: false })
    backend()
    await open()
    expect(panel().textContent).toContain(TEXT_DEVICE_OFF)
    expect(opt('风速', '高').disabled).toBe(true)
    expect(opt('开关', '开').disabled).toBe(false)
    fireEvent.click(opt('开关', '开'))
    expect(opt('风速', '高').disabled).toBe(false)
    expect(opt('控制类型', '露点控制').disabled).toBe(true)
  })
})

describe('草稿生命周期', () => {
  it('回读到改动项变得不能设置（风速 -1）：草稿清除并提示一次；回读已等于草稿：草稿清除、不提示', async () => {
    backend()
    await signIn('u', 'pw', true)
    const client = mount(P12.id)
    await waitFor(() => expect(within(panel()).queryByRole('group', { name: '风速' })).toBeTruthy())
    fireEvent.click(opt('风速', '高'))
    expect(panel().textContent).toContain('待下发：风速 自动 → 高')
    r210 = S210({ windSpeed: -1 })
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(panel().textContent).not.toContain('待下发'))
    await flush(50)
    expect(toastLog.filter((t) => t.includes('已不能设置'))).toHaveLength(1)
    r210 = S210()
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    fireEvent.click(opt('风速', '高'))
    r210 = S210({ windSpeed: 1 })
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(panel().textContent).not.toContain('待下发'))
    await flush(50)
    expect(toastLog.filter((t) => t.includes('未下发的修改已清除'))).toHaveLength(1)
  })
})

describe('210 读取失败时保留草稿', () => {
  /** 210 按 fail 回 500（有旧读数 = staleError） */
  let fail = false
  const flaky: Handler = () => (fail ? json({ code: 13, message: 'x' }, 500) : json({ body: encodeMessage(pb.RunningCtrlGetReplySchema, r210) }))
  beforeEach(() => { fail = false })

  it('一次读取失败：草稿保留、下发禁用并写明原因、不提示清除；恢复后草稿仍在，可下发', async () => {
    const be = backend({ [R210]: flaky })
    await signIn('u', 'pw', true)
    const client = mount(P12.id)
    await waitFor(() => expect(within(panel()).queryByRole('group', { name: '风速' })).toBeTruthy())
    fireEvent.click(opt('风速', '高'))
    expect(sendBtn().disabled).toBe(false)
    fail = true
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await waitFor(() => expect(panel().textContent).toContain('刷新失败'))
    await flush(50)
    expect(panel().textContent).toContain('待下发：风速 自动 → 高')
    expect(sendBtn().disabled).toBe(true)
    expect(sendBtn().title).toBe(TEXT_STALE)
    expect(panel().textContent).toContain(TEXT_STALE)
    expect(toasts()).not.toContain('未下发的修改已清除')
    fail = false
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(panel().textContent).not.toContain('刷新失败'))
    expect(panel().textContent).toContain('待下发：风速 自动 → 高')
    await waitFor(() => expect(sendBtn().disabled).toBe(false))
    fireEvent.click(sendBtn())
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body204(writes(be)[0])).toMatchObject({ windSpeed: 1, controlType: -1 })
    expect(toasts()).not.toContain('未下发的修改已清除')
  })

  it('读取失败期间设备真正离线（202 未连接）：照旧清草稿并提示一次', async () => {
    backend({ [R210]: flaky })
    await signIn('u', 'pw', true)
    const client = mount(P12.id)
    await waitFor(() => expect(within(panel()).queryByRole('group', { name: '风速' })).toBeTruthy())
    fireEvent.click(opt('风速', '高'))
    fail = true
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await waitFor(() => expect(panel().textContent).toContain('刷新失败'))
    expect(panel().textContent).toContain('待下发：风速 自动 → 高')
    units = [UNIT({ isConnected: false })]
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await flush(50)
    expect(screen.queryByText(/待下发/)).toBeNull()
    expect(toastLog.filter((x) => x.includes('未下发的修改已清除'))).toHaveLength(1)
    fail = false
    units = [UNIT()]
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(within(panel()).queryByRole('group', { name: '风速' })).toBeTruthy())
    expect(panel().textContent).not.toContain('待下发')
  })
})

describe('确认：取消 / 离开 / 切项目', () => {
  it('点「取消」：不下发，草稿保留', async () => {
    const be = backend()
    fireEvent.click(within(await draftWindAndSend()).getByRole('button', { name: '取消' }))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(panel().textContent).toContain('待下发：风速 自动 → 高')
  })

  it('弹窗打开时离开页面：按取消结算，不下发', async () => {
    const be = backend()
    await draftWindAndSend()
    fireEvent.click(rawButton('去首页'))
    await screen.findByText('首页内容')
    await flush(50)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes(be)).toHaveLength(0)
  })

  it('弹窗打开时切换项目：不下发', async () => {
    const be = backend()
    const dlg = await draftWindAndSend()
    const ok = within(dlg).getByRole('button', { name: '确认下发' })
    act(() => { setStoredProjectId(P12B.id) })
    fireEvent.click(ok)
    await flush(80)
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).not.toContain('已生效')
  })
})

describe('预检（确认后新读 202 + 210）', () => {
  for (const [what, change] of [
    ['没改的露点被外部修改', () => { r210 = { ...r210, dewPoint: 14 } }],
    ['控制类型被外部切换', () => { r210 = { ...r210, controlType: 1 } }],
    ['210 回包 id 不符', () => { r210 = { ...r210, id: 999 } }],
    ['设备变成未连接（202）', () => { units = [UNIT({ isConnected: false })] }],
    ['202 里设备 id 重复', () => { units = [UNIT(), UNIT({ name: '另一台' })] }],
  ] as const) {
    it(`${what}：不下发，提示重新核对，草稿保留`, async () => {
      const be = backend()
      await draftWindAndSend()
      change() // 读数在确认之后、预检读取之前变化（页面还没轮询到）
      await confirmOk()
      await waitFor(() => expect(toasts()).toContain('本次未下发'))
      expect(writes(be)).toHaveLength(0)
      expect(lockOf(P12 as never)).toBeNull()
    })
  }

  // #68 Codex 必须修 1：预检比对 210 原始读数，不比折叠后的视图（control_type = -1 时露点 / 湿度在视图里都是 null）、不取整
  for (const [what, start, change] of [
    ['control_type = -1 时露点 13 → 14', { controlType: -1, dewPoint: 13, humiditySet: 55 }, { dewPoint: 14 }],
    ['control_type = -1 时湿度 55 → 56', { controlType: -1, dewPoint: 13, humiditySet: 55 }, { humiditySet: 56 }],
    ['湿度在两个不同的无效值之间变化（65536 → -100）', { humiditySet: 65536 }, { humiditySet: -100 }],
    ['露点设定值的小数差异（13 → 13.004，取整到 0.01 时相同）', { controlType: 0, dewPoint: 13 }, { dewPoint: 13.004 }],
  ] as const) {
    it(`预检读到${what}：不下发（0 个 204 请求），提示重新核对`, async () => {
      r210 = S210(start)
      const be = backend()
      await draftWindAndSend()
      r210 = { ...r210, ...change }
      await confirmOk()
      await waitFor(() => expect(toasts()).toContain('确认后重新读取到的新风设置与确认时不一致，本次未下发'))
      expect(be.callsTo(R204)).toHaveLength(0)
      expect(writes(be)).toHaveLength(0)
      expect(lockOf(P12 as never)).toBeNull()
    })
  }

  it('确认后、预检读取期间离开页面：不下发、放锁，不向别处提示', async () => {
    let gate = () => {}
    let hold = false
    const be = backend({ [R202]: async () => {
      if (hold) await new Promise<void>((r) => { gate = r })
      return json({ body: encodeMessage(pb.FreshDehumidifierGetReplySchema, { data: units }) })
    } })
    await draftWindAndSend()
    hold = true
    await confirmOk()
    await flush(50)
    fireEvent.click(rawButton('去首页'))
    await screen.findByText('首页内容')
    await act(async () => { gate(); await new Promise((r) => setTimeout(r, 80)) })
    expect(writes(be)).toHaveLength(0)
    expect(lockOf(P12 as never)).toBeNull()
    expect(toasts()).not.toContain('已生效')
  })

  it('预检读取失败（503）：不下发、放锁', async () => {
    let fail = false
    const be = backend({ [R202]: () => (fail ? json({ code: 14, message: 'unavailable' }, 503) : json({ body: encodeMessage(pb.FreshDehumidifierGetReplySchema, { data: units }) })) })
    await draftWindAndSend()
    fail = true
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('本次未下发'))
    expect(writes(be)).toHaveLength(0)
    expect(lockOf(P12 as never)).toBeNull()
  })
})

describe('下发结果四态（只比对改动字段）', () => {
  it('首次回读未变化：先显示「已下发，正在核对 …」，退避用完才显示「指令已下发，设备状态暂未变化」；草稿保留、写锁保持', async () => {
    fakeClock()
    apply204 = false
    const be = backend()
    await draftWindAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await flush(100)
    expect(panel().textContent).toContain('已下发，正在核对')
    expect(panel().textContent).not.toContain('设备状态暂未变化')
    await runRetries()
    await waitFor(() => expect(within(panel()).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(toasts()).not.toContain('已生效')
    expect(panel().textContent).toContain('风速 自动 → 高') // 草稿保留（待确认）
    expect(lockOf(P12 as never)).toBeTruthy()
  })

  it('改风速后 210 风速读到 -1：无法核对（没改的露点 / 湿度读到 -1 不参与）', async () => {
    fakeClock()
    r210 = S210({ controlType: -1, dewPoint: -1, humiditySet: -1 })
    apply204 = false
    const be = backend({ [R204]: (c) => { r210 = { ...r210, windSpeed: -1 }; return ok204(c, 1) } })
    await open()
    fireEvent.click(opt('风速', '高'))
    fireEvent.click(sendBtn())
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await flush(100); await runRetries()
    await waitFor(() => expect(within(panel()).getAllByRole('alert').map((a) => a.textContent).join()).toContain('该项暂无回读，无法确认'))
    expect(lockOf(P12 as never)?.lastFields).toEqual({ windSpeed: 'unverifiable' })
  })

  it('control_type = -1 的设备改风速：回读风速一致就算已生效（露点 / 湿度回读 -1 不比对）', async () => {
    r210 = S210({ controlType: -1, dewPoint: -1, humiditySet: -1 })
    backend()
    await open()
    fireEvent.click(opt('风速', '高'))
    fireEvent.click(sendBtn())
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('已生效：风速 高'))
    expect(lockOf(P12 as never)).toBeNull()
  })

  it('回读失败（210 500）：结果未知，锁保持', async () => {
    fakeClock()
    let n = 0
    const be = backend({ [R210]: () => (++n > 2 ? json({ code: 13, message: 'x' }, 500) : json({ body: encodeMessage(pb.RunningCtrlGetReplySchema, r210) })) })
    await draftWindAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await flush(100); await runRetries()
    await waitFor(() => expect(panel().textContent).toMatch(/结果未知/))
    expect(lockOf(P12 as never)).toBeTruthy()
    expect(toasts()).not.toContain('已生效')
  })

  it('503 + code 14：未下发，草稿保留、放锁', async () => {
    const be = backend({ [R204]: () => json({ code: 14, message: 'unavailable' }, 503) })
    await draftWindAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('未下发'))
    expect(writes(be)).toHaveLength(1)
    expect(panel().textContent).toContain('风速 自动 → 高')
    await waitFor(() => expect(lockOf(P12 as never)).toBeNull())
  })

  it('控制屏回 success=false：下发失败，放锁，草稿清掉', async () => {
    backend({ [R204]: () => json({ body: encodeMessage(pb.RunningCtrlSetReplySchema, { success: false, msg: '参数错误' }) }) })
    await draftWindAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('下发失败：参数错误'))
    await waitFor(() => expect(lockOf(P12 as never)).toBeNull())
  })
})

describe('没有下发入口 / 只读', () => {
  it('240829001（app_code 1）：没有运行设置面板，不发 210', async () => {
    const be = backend({ [R210]: () => ctrlError('该软件类型不支持此控制') })
    await signIn('u', 'pw', true)
    mount(P1.id)
    await screen.findByText('实时数据', { exact: false })
    expect(screen.queryByRole('region', { name: '运行设置' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下发设置' })).toBeNull()
    expect(be.callsTo(R210)).toHaveLength(0)
  })

  it('210 回「该软件类型不支持此控制」：面板只有说明，没有下发按钮', async () => {
    backend({ [R210]: () => ctrlError('该软件类型不支持此控制') })
    await signIn('u', 'pw', true)
    mount(P12.id)
    await within(await screen.findByRole('region', { name: '运行设置' })).findByText('该项目不支持新风控制')
    expect(within(panel()).queryByRole('button', { name: '下发设置' })).toBeNull()
  })

  for (const [what, setup, text] of [
    ['features.freshAirWrite = off', () => setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', features: { freshAirWrite: 'off' } }), TEXT_WRITE_OFF],
    ['账号没有 204 权限', () => {}, TEXT_WRITE_FORBIDDEN],
  ] as const) {
    it(`${what}：只读形态（没有选项按钮），下发按钮禁用并写明原因`, async () => {
      setup()
      backend({}, text === TEXT_WRITE_FORBIDDEN ? { perms: [FRESH_ROUTES.units, FRESH_ROUTES.settings] } : {})
      await signIn('u', 'pw', true)
      mount(P12.id)
      await waitFor(() => expect(panel().querySelector('[data-field="windSpeed"]')).toBeTruthy())
      expect(within(panel()).queryByRole('group', { name: '风速' })).toBeNull()
      expect(sendBtn().disabled).toBe(true)
      expect(within(panel()).getByText(text)).toBeTruthy()
    })
  }
})
