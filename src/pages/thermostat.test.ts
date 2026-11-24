// @vitest-environment jsdom
// S9 温控面板页面用例（真实接口形状，只用假后端，绝不连真实后端）：
// 读取映射；温度步进边界；房间关闭 / 读不到末端禁止设置；节能锁温度；201 / 206 请求体（不改的标量 -1、只发改了的字段、
// end_modes 用确认后重新核对的最新读数原样传回）；确认取消 / 离开 / 切项目后不下发；确认期间状态变化（轮询回读）取消下发；
// 在途下发跨卸载 / 切项目仍串行、不在别的项目弹成功；草稿生命周期；success 才提示成功；失败与结果未知（含回读状态）。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { toast as sonner } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn, signOut } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests, setStoredProjectId } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetWritesForTests, LIMITS } from '../features/thermostat'
import Layout from '../components/Layout'
import { OrgGate } from '../app/OrgGate'
import { __resetWriteLockForTests, acquire as acquireLock, release as releaseLock, STORAGE_PREFIX } from '../api/writeLock'
import Thermostat from './Thermostat'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

type Handler = (call: Call, n: number) => Response | Promise<Response>
const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001', name: '测试项目0829', app_code: '1', app_name: '通用版', online: true, control_screen_id: 'SCREEN-T' }
const P2 = { id: 'p2', code: '261124009', name: '另一个项目', app_code: '1', app_name: '通用版', online: true, control_screen_id: 'SCREEN-T' }
const P12 = { id: 'p12', code: '260911001', name: '独立空气系统测试', app_code: '12', app_name: '独立空气系统', online: true }
const POFF = { id: 'poff', code: '221031001', name: '科希家办公室', app_code: '1', app_name: '通用版' }
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: [P1.id, P2.id, P12.id, POFF.id] }]

const ENDS = [
  { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
  { optionName: '顶辐射', type: 1, isSelected: true, isChange: true, switch: 0 },
  { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 },
]
const ROOM = { id: 406658286, name: '客厅', temperature: 25.8, humidity: 51, dewPoint: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0, switch: 1, mode: 0, isConnected: true, endModes: ENDS }
const OFF_ROOM = { ...ROOM, id: 406658291, name: '主卧', switch: 0, setTemp: 26, windSpeed: 100, humidity: 65536, endModes: [ENDS[0]] }
const reply200 = (rooms: object[]) => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: rooms }) })
const ok201 = () => json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: true }) })
const ok206 = () => json({ body: encodeMessage(pb.ProjectRoomSwitchSetReplySchema, { success: true }) })

/** 可变的 200：测试里改 rooms 再触发回读，模拟轮询读到的新状态 */
let rooms: object[] = []
function backend(routes: Record<string, Handler> = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: [] }),
    '/ctrl/projects': () => json({ project_entities: [P1, P2, P12, POFF] }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    '/apps': () => json({}),
    '/auth/invalidate': () => json({}),
    '/ctrl/room-temperature-data-get': () => reply200(rooms),
    '/ctrl/room-temperature-data-hour-get': () => json({ body: '' }),
    ...routes,
  })
}
/** 可手动放行的响应（模拟慢的控制屏） */
function deferred(make: () => Response) {
  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  return { handler: async () => { await gate; return make() }, release: () => act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) }) }
}

function Away() {
  const nav = useNavigate()
  return createElement('span', null,
    createElement('button', { onClick: () => nav('/home') }, '去首页'),
    createElement('button', { onClick: () => nav('/thermostat') }, '回温控'))
}
let client: QueryClient
function mount() {
  client = createQueryClient()
  return render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: ['/thermostat'] },
      createElement(Away),
      createElement(Routes, null,
        createElement(Route, { element: createElement(OrgGate, null, createElement(Layout)) },
          createElement(Route, { path: '/thermostat', element: createElement(Thermostat) }),
          createElement(Route, { path: '/home', element: createElement('div', null, '首页内容') }),
        ))))))
}
// 轻提示：记录本用例里 showToast 转调 Sonner 的文案（Sonner 的列表跨用例保留，不能直接读 DOM）
let toastLog: string[] = []
const toasts = () => toastLog.join('\n')
const flush = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const writes = (be: ReturnType<typeof backend>) => be.calls.filter((c) => /-set$/.test(new URL(c.url, 'http://x').pathname))
const body201 = (c: Call) => decodeReply(pb.RoomTemperatureSetQuerySchema, (c.body as { body: string }).body) as Record<string, unknown>
const card = (name: string) => [...document.querySelectorAll('[data-room]')].find((c) => c.querySelector('.room-name')?.textContent === name) as HTMLElement
const btn = (c: HTMLElement, name: string) => within(c).getByRole('button', { name }) as HTMLButtonElement
const dialog = () => screen.findByRole('alertdialog')
/** 弹窗打开时页面其余部分对读屏隐藏，按文字直接找按钮 */
const rawButton = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
/** 模拟一次轮询回读：换掉 200 的内容并让当前查询重读 */
async function poll(next: object[]) {
  rooms = next
  await act(async () => { await client.refetchQueries({ type: 'active' }) })
  await flush()
}
const confirmOk = async () => fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))

async function open(project: { id: string } = P1) {
  localStorage.setItem('hjc-project', project.id)
  await signIn('u', 'pw', true)
  mount()
}
async function openRooms() {
  await open()
  await screen.findByText('客厅')
  return card('客厅')
}
/** 客厅温度 +0.5 后点下发（弹出确认） */
async function draftAndSend() {
  const c = await openRooms()
  fireEvent.click(btn(c, '客厅 设定温度升高'))
  fireEvent.click(btn(card('客厅'), '下发'))
  return dialog()
}

beforeEach(() => {
  toastLog = []
  rooms = [ROOM, OFF_ROOM]
  for (const k of ['success', 'error'] as const) vi.spyOn(sonner, k).mockImplementation((m) => { toastLog.push(String(m)); return 0 })
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); __resetWritesForTests(); __resetWriteLockForTests(); clearTokens()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null) })

describe('读取（ctrl 200）', () => {
  it('房间卡：末端按 end_modes 动态显示（选中蓝 / 未选中灰，开 / 关取 switch），风速档位与自动，65536 隐藏，设定湿度去除', async () => {
    const be = backend()
    const c = await openRooms()
    const ends = [...c.querySelectorAll('.modes-row [data-slot=badge]')].map((b) => [b.textContent, b.getAttribute('data-variant')])
    expect(ends).toEqual([['风盘 开', 'blue'], ['顶辐射 关', 'blue'], ['地冷 关', 'gray']])
    expect(c.textContent).toContain('3 档')
    expect(c.textContent).toContain('湿度 51%')
    expect(c.textContent).not.toContain('设定湿度')
    expect(c.textContent).toContain('406658286 · 制冷')
    const off = card('主卧')
    expect(off.textContent).not.toContain('湿度') // 65536 隐藏
    expect(off.querySelectorAll('.modes-row [data-slot=badge]')).toHaveLength(1)
    expect((be.callsTo('/ctrl/room-temperature-data-get')[0].body as { project_id: string }).project_id).toBe(P1.id)
  })

  it('风速 100 显示「自动」', async () => {
    rooms = [{ ...ROOM, windSpeed: 100 }]
    backend()
    expect((await openRooms()).textContent).toContain('自动')
  })

  it('app_code 12：显示「该项目无房间温控面板」，不读 ctrl 200', async () => {
    const be = backend()
    await open(P12)
    await screen.findByText('该项目无房间温控面板')
    await flush(50)
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(0)
  })

  it('项目离线：设备页不挂载（Layout 空态，S11），不读 ctrl 200', async () => {
    const be = backend()
    await open(POFF)
    await screen.findByText('项目离线，暂无数据')
    await flush(50)
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(0)
    expect(document.querySelector('[data-room]')).toBeNull()
  })
  it('控制屏 503：显示「控制屏未连接」', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => json({ code: 14, message: '控制屏消息发送失败' }, 503) })
    await open()
    await screen.findByText('控制屏未连接')
  })
})

describe('修改设定温度与节能（ctrl 201）', () => {
  it('− / + 只改草稿；下发 → 确认（含项目编号）→ 只发一条 201：温度是真实值，其余 -1，end_modes 是最新读数原样；success 才提示成功并回读', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(btn(c, '客厅 设定温度降低'))
    fireEvent.click(btn(c, '客厅 设定温度降低'))
    expect(within(c).getByLabelText('客厅 设定温度').textContent).toBe('24.5°C')
    expect(c.textContent).toContain('原 25.5')
    expect(c.textContent).toContain('待下发：设定温度 25.5 → 24.5°C')
    expect(writes(be)).toHaveLength(0)
    const reads = be.callsTo('/ctrl/room-temperature-data-get').length
    fireEvent.click(btn(c, '下发'))
    const dlg = await dialog()
    for (const t of ['测试项目0829', '240829001', '客厅', '设定温度 25.5 → 24.5°C']) expect(dlg.textContent).toContain(t)
    expect(writes(be)).toHaveLength(0)
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(toasts()).toContain('客厅 已下发：设定温度 24.5°C'))
    const w = writes(be)
    expect(w).toHaveLength(1)
    expect(w[0].url).toBe('/api/ctrl/room-temperature-set')
    expect((w[0].body as { project_id: string }).project_id).toBe(P1.id)
    expect(body201(w[0])).toEqual({ equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: ENDS })
    await waitFor(() => expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(reads))
    await waitFor(() => expect(card('客厅').textContent).not.toContain('待下发'))
  })

  it('end_modes 取确认后重新核对时的最新读数：确认期间轮询读到同样的末端 → 照发且等于最新读数；末端变了 → 不下发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    await draftAndSend()
    const latestEnds = ENDS.map((m) => ({ ...m }))
    await poll([{ ...ROOM, endModes: latestEnds }, OFF_ROOM])
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0]).endModes).toEqual(latestEnds)

    cleanup(); __resetWritesForTests(); toastLog = []; rooms = [ROOM, OFF_ROOM]
    __resetCurrentForTests(); __resetSessionForTests(); __resetSessionViewForTests()
    const be2 = backend({ '/ctrl/room-temperature-set': ok201 })
    await draftAndSend()
    await poll([{ ...ROOM, endModes: [{ ...ENDS[0], switch: 0 }, ENDS[1], ENDS[2]] }, OFF_ROOM])
    await confirmOk()
    await flush(50)
    expect(writes(be2)).toHaveLength(0)
    expect(toasts()).toContain('本次未下发')
  })

  it('读不到末端（end_modes 为空）：温度、节能、开关都禁用，不能下发', async () => {
    rooms = [{ ...ROOM, endModes: [] }]
    const be = backend()
    const c = await openRooms()
    for (const n of ['客厅 设定温度降低', '客厅 设定温度升高']) expect(btn(c, n).disabled).toBe(true)
    expect(btn(c, '客厅 设定温度升高').title).toContain('末端')
    for (const n of ['客厅 节能模式', '客厅 开关']) expect((within(c).getByRole('switch', { name: n }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes(be)).toHaveLength(0)
  })

  it('最近一次读取失败（有旧数据）：不能下发', async () => {
    backend()
    const c = await openRooms()
    expect(btn(c, '客厅 设定温度升高').disabled).toBe(false)
    fakeBackend({ '/ctrl/room-temperature-data-get': () => json({ code: 13, message: 'x' }, 500) })
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await waitFor(() => expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true))
  })

  it('只改节能：eco=1，温度等其余 -1', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 节能模式' }))
    expect(c.textContent).toContain('节能模式 标准 → 节能')
    fireEvent.click(btn(c, '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: 1, switch: -1, endModes: ENDS })
    await waitFor(() => expect(toasts()).toContain('节能模式 开'))
  })

  it('节能锁温度：先改温度再开节能 → 温度改动被去掉、步进禁用（提示由系统设定），下发只有 eco=1', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(btn(c, '客厅 设定温度升高'))
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 节能模式' }))
    const after = card('客厅')
    expect(within(after).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
    expect(btn(after, '客厅 设定温度升高').disabled).toBe(true)
    expect(btn(after, '客厅 设定温度升高').title).toBe('节能模式下温度由系统设定')
    expect(after.textContent).not.toContain('设定温度 25.5 →')
    fireEvent.click(btn(after, '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toMatchObject({ temperature: -1, eco: 1 })
  })

  it('面板是节能：温度步进禁用；切回标准只发 eco=0、温度 -1', async () => {
    rooms = [{ ...ROOM, eco: 1, setTemp: 27 }]
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    expect(btn(c, '客厅 设定温度降低').disabled).toBe(true)
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 节能模式' }))
    expect(btn(card('客厅'), '客厅 设定温度降低').disabled).toBe(true) // 面板还在节能，仍不能改
    fireEvent.click(btn(card('客厅'), '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toMatchObject({ temperature: -1, eco: 0 })
  })

  it('温度上限 30 / 下限 16：到边界后对应按钮禁用；改另一个房间先确认放弃', async () => {
    rooms = [{ ...ROOM, setTemp: 29.5 }, { ...ROOM, id: 9, name: '书房', setTemp: 16.5 }]
    backend()
    const c = await openRooms()
    fireEvent.click(btn(c, '客厅 设定温度升高'))
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('30.0°C')
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true)
    fireEvent.click(btn(card('书房'), '书房 设定温度降低'))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(within(card('书房')).getByLabelText('书房 设定温度').textContent).toBe('16.0°C'))
    expect(btn(card('书房'), '书房 设定温度降低').disabled).toBe(true)
    expect(card('客厅').textContent).not.toContain('待下发')
  })

  it('房间关闭：温度和节能控件禁用，没有任何写请求', async () => {
    const be = backend()
    await openRooms()
    const off = card('主卧')
    for (const name of ['主卧 设定温度降低', '主卧 设定温度升高']) expect(btn(off, name).disabled).toBe(true)
    expect((within(off).getByRole('switch', { name: '主卧 节能模式' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(btn(off, '主卧 设定温度升高'))
    expect(off.textContent).not.toContain('待下发')
    expect(writes(be)).toHaveLength(0)
  })
})

describe('确认：取消 / 离开 / 切项目 / 确认期间状态变化', () => {
  it('点「取消」：不下发，草稿保留', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    fireEvent.click(within(await draftAndSend()).getByRole('button', { name: '取消' }))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(card('客厅').textContent).toContain('待下发')
  })

  it('弹窗打开时离开页面：按取消结算，不下发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    await draftAndSend()
    fireEvent.click(rawButton('去首页'))
    await screen.findByText('首页内容')
    await flush(50)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).not.toContain('已下发')
  })

  it('弹窗打开时切换项目：不下发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const dlg = await draftAndSend()
    const ok = within(dlg).getByRole('button', { name: '确认下发' })
    act(() => { setStoredProjectId(P2.id) })
    fireEvent.click(ok)
    await flush(80)
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).not.toContain('已下发')
  })

  for (const [what, next, why] of [
    ['房间被关闭', { ...ROOM, switch: 0 }, '本次未下发'],
    ['面板离线', { ...ROOM, isConnected: false }, '本次未下发'],
    ['设定温度被外部修改', { ...ROOM, setTemp: 23 }, '本次未下发'],
  ] as const) {
    it(`确认期间回读到${what}：取消本次下发，提示重新核对`, async () => {
      const be = backend({ '/ctrl/room-temperature-set': ok201 })
      await draftAndSend()
      await poll([next, OFF_ROOM])
      fireEvent.click(rawButton('确认下发'))
      await flush(50)
      expect(writes(be)).toHaveLength(0)
      expect(toasts()).toContain(why)
      expect(toasts()).not.toContain('已下发')
    })
  }

  it('房间开关：确认期间面板离线 → 不下发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 开关' }))
    await dialog()
    await poll([{ ...ROOM, isConnected: false }, OFF_ROOM])
    fireEvent.click(rawButton('确认下发'))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).toContain('本次未下发')
  })

  it('房间开关：确认期间末端变了 → 不下发（用的是最新读数，不是弹窗前的）', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 开关' }))
    await dialog()
    await poll([{ ...ROOM, endModes: [ENDS[0]] }, OFF_ROOM])
    fireEvent.click(rawButton('确认下发'))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).toContain('本次未下发')
  })

  it('切换项目：草稿作废（房间编号相同的另一个项目里不出现待下发）', async () => {
    backend()
    fireEvent.click(btn(await openRooms(), '客厅 设定温度升高'))
    expect(card('客厅').textContent).toContain('待下发')
    act(() => { setStoredProjectId(P2.id) })
    await waitFor(() => expect(document.querySelector('.page-head .sub')?.textContent).toContain('另一个项目'))
    expect(card('客厅').textContent).not.toContain('待下发')
  })

  it('全部开关点「取消」：写请求 0', async () => {
    const be = backend({ '/ctrl/project-room-switch-set': ok206 })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部关闭' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '取消' }))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
  })
})

describe('在途下发跨卸载 / 切项目', () => {
  it('201 在途时离开再回来：页面保持禁用，不能并发第二条；返回后提示成功、恢复可用', async () => {
    const slow = deferred(ok201)
    const be = backend({ '/ctrl/room-temperature-set': slow.handler })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    fireEvent.click(rawButton('去首页'))
    await screen.findByText('首页内容')
    fireEvent.click(rawButton('回温控'))
    await screen.findByText('客厅')
    const c = card('客厅')
    expect(btn(c, '客厅 设定温度升高').disabled).toBe(true)
    expect((within(c).getByRole('switch', { name: '客厅 开关' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(true)
    expect(c.textContent).toContain('正在下发')
    await slow.release()
    await waitFor(() => expect(toasts()).toContain('客厅 已下发'))
    await waitFor(() => expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(false))
    expect(writes(be)).toHaveLength(1)
  })

  it('201 在途时切到别的项目：完成时不在当前项目弹成功；回到原项目在房间卡上看到结果', async () => {
    const slow = deferred(ok201)
    const be = backend({ '/ctrl/room-temperature-set': slow.handler })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    act(() => { setStoredProjectId(P2.id) })
    await flush(50)
    await slow.release()
    await flush(80)
    expect(toasts()).not.toContain('已下发')
    act(() => { setStoredProjectId(P1.id) })
    await waitFor(() => expect(card('客厅')?.textContent).toContain('客厅 已下发：设定温度 26.0°C'))
  })

  it('206 在途时离开再回来：全部开关保持禁用', async () => {
    const slow = deferred(ok206)
    const be = backend({ '/ctrl/project-room-switch-set': slow.handler })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    fireEvent.click(rawButton('去首页'))
    await screen.findByText('首页内容')
    fireEvent.click(rawButton('回温控'))
    await screen.findByText('客厅')
    expect((screen.getByRole('button', { name: '全部关闭' }) as HTMLButtonElement).disabled).toBe(true)
    await slow.release()
    await waitFor(() => expect(toasts()).toContain('已下发：全部开启'))
    await waitFor(() => expect((screen.getByRole('button', { name: '全部关闭' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('草稿生命周期', () => {
  it('回读到房间关闭：草稿真正清除（提示一次）；房间再开启后旧草稿不复活', async () => {
    backend()
    const c = await openRooms()
    fireEvent.click(btn(c, '客厅 设定温度升高'))
    await poll([{ ...ROOM, switch: 0 }, OFF_ROOM])
    expect(toasts()).toContain('未下发的修改已清除')
    await poll([ROOM, OFF_ROOM])
    expect(card('客厅').textContent).not.toContain('待下发')
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
  })

  it('面板离线再恢复：旧草稿不复活', async () => {
    backend()
    fireEvent.click(btn(await openRooms(), '客厅 设定温度升高'))
    await poll([{ ...ROOM, isConnected: false }, OFF_ROOM])
    await poll([ROOM, OFF_ROOM])
    expect(card('客厅').textContent).not.toContain('待下发')
  })

  it('回读值等于草稿：清除；之后面板值再变，旧改动不复活', async () => {
    backend()
    fireEvent.click(btn(await openRooms(), '客厅 设定温度升高'))
    await poll([{ ...ROOM, setTemp: 26 }, OFF_ROOM])
    expect(card('客厅').textContent).not.toContain('待下发')
    await poll([{ ...ROOM, setTemp: 25.5 }, OFF_ROOM])
    expect(card('客厅').textContent).not.toContain('待下发')
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
  })

  it('编辑期间外部改了设定值：显示冲突、没有「下发」，只能放弃后重新编辑', async () => {
    backend()
    fireEvent.click(btn(await openRooms(), '客厅 设定温度升高'))
    await poll([{ ...ROOM, setTemp: 23 }, OFF_ROOM])
    const c = card('客厅')
    expect(within(c).getByRole('alert').textContent).toContain('已在外部变化')
    expect(within(c).queryByRole('button', { name: '下发' })).toBeNull()
    fireEvent.click(btn(c, '放弃修改'))
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('23.0°C')
  })
})

describe('结果：失败、结果未知与回读', () => {
  it('Reply success=false：提示后端 msg，卡片内红条，草稿回退，不提示成功', async () => {
    const be = backend({ '/ctrl/room-temperature-set': () => json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: false, msg: '该软件类型不支持此控制' }) }) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅 下发失败：该软件类型不支持此控制'))
    expect(toasts()).not.toContain('已下发')
    await waitFor(() => expect(within(card('客厅')).getByRole('alert').textContent).toContain('下发失败：该软件类型不支持此控制'))
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
    expect(writes(be)).toHaveLength(1)
  })

  it('504：结果未知（不说失败）；写锁自动核对，回读进行中 → 读到与下发值不一致 → 保持暂停下发，草稿保留、没有重试', async () => {
    let wrote = false
    const slowRead = deferred(() => reply200(rooms))
    const be = backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return json({ code: 4, message: 'deadline exceeded' }, 504) },
      '/ctrl/room-temperature-data-get': () => (wrote ? slowRead.handler() : reply200(rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(card('客厅').textContent).toContain('正在重新读取面板当前值'))
    expect(toasts()).toContain('客厅 下发结果未知')
    expect(toasts()).not.toContain('下发失败')
    await slowRead.release()
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('与下发值不一致'))
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C')
    expect(within(card('客厅')).queryByRole('button', { name: '重试' })).toBeNull()
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true)
    expect(writes(be)).toHaveLength(1)
  })
  it('504 且回读失败：说明无法核对，不给重试', async () => {
    let fail = false
    backend({
      '/ctrl/room-temperature-set': () => { fail = true; return json({ code: 4, message: 'deadline exceeded' }, 504) },
      '/ctrl/room-temperature-data-get': () => (fail ? json({ code: 14, message: 'x' }, 503) : reply200(rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('无法核对'))
    expect(within(card('客厅')).queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('500 / 回复无法解析：按结果未知处理，不说下发失败，草稿保留', async () => {
    for (const make of [() => json({ code: 13, message: 'internal' }, 500), () => json({ body: '!!!不是base64' })]) {
      const be = backend({ '/ctrl/room-temperature-set': make })
      await draftAndSend()
      await confirmOk()
      await waitFor(() => expect(toasts()).toContain('客厅 下发结果未知'))
      expect(toasts()).not.toContain('下发失败')
      expect(writes(be)).toHaveLength(1)
      await waitFor(() => expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C'))
      cleanup(); vi.unstubAllGlobals(); __resetWritesForTests(); __resetWriteLockForTests(); toastLog = []
      __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
    }
  })

  it('写防护拦截（code 不在名单 / writeMode=off / 生产环境）：写请求 0，提示未下发', async () => {
    for (const cfg of [{ writeProjectCodes: ['260911001'] }, { writeMode: 'off' as const }, { apiEnv: 'prod' as const }]) {
      setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', ...cfg })
      const be = backend({ '/ctrl/room-temperature-set': ok201 })
      await draftAndSend()
      await confirmOk()
      await waitFor(() => expect(within(card('客厅')).getByRole('alert').textContent).toContain('未下发'))
      expect(writes(be)).toHaveLength(0)
      expect(toasts()).not.toContain('已下发')
      cleanup(); vi.unstubAllGlobals(); __resetWritesForTests(); __resetWriteLockForTests(); toastLog = []
      __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
    }
  })
})

describe('房间开关（201 switch）与全部开关（206）', () => {
  it('房间开关：确认后只发 switch，其余 -1，末端原样；取消则不发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 开关' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '取消' }))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    fireEvent.click(within(card('客厅')).getByRole('switch', { name: '客厅 开关' }))
    const dlg = await dialog()
    expect(dlg.textContent).toContain('「客厅」下发「关闭」')
    expect(dlg.textContent).toContain('240829001')
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: 0, endModes: ENDS })
    await waitFor(() => expect(toasts()).toContain('客厅 已关闭'))
  })

  it('有未下发草稿时房间开关禁用', async () => {
    backend()
    fireEvent.click(btn(await openRooms(), '客厅 设定温度升高'))
    expect((within(card('客厅')).getByRole('switch', { name: '客厅 开关' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('全部开启：确认后发 206 switch=1；全部关闭的确认是危险样式', async () => {
    const be = backend({ '/ctrl/project-room-switch-set': ok206 })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    const w = writes(be)[0]
    expect(w.url).toBe('/api/ctrl/project-room-switch-set')
    expect((w.body as { project_id: string }).project_id).toBe(P1.id)
    expect(decodeReply(pb.ProjectRoomSwitchSetQuerySchema, (w.body as { body: string }).body)).toEqual({ switch: 1 })
    await waitFor(() => expect(toasts()).toContain('已下发：全部开启（2 个房间）'))
  })

  it('全部关闭失败（success=false）：提示失败；504：结果未知', async () => {
    let mode: 'fail' | 'timeout' = 'fail'
    backend({ '/ctrl/project-room-switch-set': () => (mode === 'fail' ? json({ body: encodeMessage(pb.ProjectRoomSwitchSetReplySchema, { success: false, msg: '控制屏拒绝' }) }) : json({ code: 4, message: 'x' }, 504)) })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部关闭' }))
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('全部关闭 下发失败：控制屏拒绝'))
    await waitFor(() => expect((screen.getByRole('button', { name: '全部关闭' }) as HTMLButtonElement).disabled).toBe(false))
    mode = 'timeout'
    fireEvent.click(screen.getByRole('button', { name: '全部关闭' }))
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('全部关闭 下发结果未知'))
    expect(toasts()).not.toContain('已下发')
  })
})

/** 某条请求在全部请求里的序号（看先后） */
const order = (be: ReturnType<typeof backend>, pred: (c: Call) => boolean) => be.calls.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0)
const is200 = (c: Call) => c.url.endsWith('/ctrl/room-temperature-data-get')
const is201 = (c: Call) => c.url.endsWith('/ctrl/room-temperature-set')

describe('下发状态机：确认后新读、写后新读、会话、期限', () => {
  it('确认后不等轮询：先新发一次 200，再用这份读数组装 201（末端等于这次新读数）', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    await draftAndSend()
    const before = be.callsTo('/ctrl/room-temperature-data-get').length
    // 弹窗打开期间设备数据变了（风速变化不影响 Query），但不触发任何轮询
    rooms = [{ ...ROOM, windSpeed: 5, endModes: ENDS.map((m) => ({ ...m })) }, OFF_ROOM]
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    const reads = order(be, is200)
    const w = order(be, is201)[0]
    expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(before)
    expect(reads.some((i) => i > reads[before - 1] && i < w)).toBe(true) // 确认之后、201 之前有一次新的 200
    expect(body201(writes(be)[0]).endModes).toEqual(ENDS)
  })

  it('确认后不等轮询：设备的末端 / 开关已变 → 新读到后取消，不写', async () => {
    for (const next of [{ ...ROOM, endModes: [ENDS[0]] }, { ...ROOM, switch: 0 }, { ...ROOM, isConnected: false }]) {
      const be = backend({ '/ctrl/room-temperature-set': ok201 })
      await draftAndSend()
      rooms = [next, OFF_ROOM]
      await confirmOk()
      await flush(80)
      expect(writes(be)).toHaveLength(0)
      expect(toasts()).toContain('本次未下发')
      cleanup(); vi.unstubAllGlobals(); __resetWritesForTests(); toastLog = []; rooms = [ROOM, OFF_ROOM]
      __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
    }
  })

  it('写前启动的轮询在写后才返回旧读数：不算回读；回读是 201 之后新发的 200，界面以它为准', async () => {
    let phase: 'before' | 'stale' | 'after' = 'before'
    const stale = deferred(() => reply200([ROOM, OFF_ROOM])) // 旧读数：设定 25.5
    const slow201 = deferred(ok201)
    const be = backend({
      '/ctrl/room-temperature-set': async () => { const r = await slow201.handler(); phase = 'after'; return r },
      '/ctrl/room-temperature-data-get': () => (phase === 'stale' ? stale.handler() : reply200(phase === 'after' ? [{ ...ROOM, setTemp: 26 }, OFF_ROOM] : rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    // 201 在途时启动一次轮询，它会一直挂着、最后返回写前的旧值
    phase = 'stale'
    void client.refetchQueries({ type: 'active' }).catch(() => {})
    await flush()
    phase = 'after'
    await slow201.release()
    await waitFor(() => expect(toasts()).toContain('客厅 已下发'))
    await waitFor(() => expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('26.0°C'))
    const w = order(be, is201)[0]
    expect(order(be, is200).some((i) => i > w)).toBe(true)
    await stale.release() // 旧轮询这时才返回：已被取消，不覆盖界面
    await flush(50)
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('26.0°C')
  })

  it('等应答到期 → 结果未知、原写未结束：不能核对；原写迟到成功 → 写锁自动放开，之后才能再下发', async () => {
    const late = deferred(ok201)
    const be = backend({ '/ctrl/room-temperature-set': late.handler })
    LIMITS.writeDeadlineMs = 150
    await draftAndSend()
    await confirmOk()
    const lockBar = () => document.querySelector('[data-lock="unknown"]') as HTMLElement
    await waitFor(() => expect(lockBar()).toBeTruthy())
    expect(lockBar().textContent).toContain('上次下发（客厅）结果未知')
    expect(lockBar().textContent).toContain('上一条指令尚未结束')
    expect((within(lockBar()).getByRole('button', { name: '核对' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(true)
    expect(btn(card('主卧'), '主卧 设定温度升高').disabled).toBe(true)
    await late.release() // 原写迟到 success=true：生效证据
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    fireEvent.click(within(card('主卧')).getByRole('switch', { name: '主卧 开关' }))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(2))
  })
  it('http 层超时会中止底层请求（AbortController），原写因此结算：超时后核对一致即可解锁', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', ctrlTimeoutMs: 100 })
    let aborted = false
    const be = backend()
    const orig = be.fetchMock.getMockImplementation()!
    be.fetchMock.mockImplementation(async (input: string, init: RequestInit = {}) => {
      if (input.endsWith('/ctrl/room-temperature-set')) {
        be.calls.push({ url: input, method: 'POST', headers: {}, body: JSON.parse(String(init.body)) })
        return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) }))
      }
      return orig(input, init)
    })
    let wroteOnce = false
    const read = be.fetchMock.getMockImplementation()!
    be.fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/ctrl/room-temperature-set')) wroteOnce = true
      // 写后的回读失败，进入 unknown-locked
      if (wroteOnce && input.endsWith('/ctrl/room-temperature-data-get')) return json({ code: 14, message: 'x' }, 503)
      return read(input, init)
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅 下发结果未知：未收到控制屏应答'))
    expect(aborted).toBe(true) // 底层 fetch 确实被 abort，原写因此结算
    const bar = await waitFor(() => { const b = document.querySelector('[data-lock="unknown"]') as HTMLElement; expect(b).toBeTruthy(); expect(b.textContent).toContain('可点「核对」'); return b })
    expect(bar.textContent).not.toContain('上一条指令尚未结束')
    // 自动核对读失败（503）→ 保持；读到与下发值一致 → 核对解锁
    wroteOnce = false
    rooms = [{ ...ROOM, setTemp: 26 }, OFF_ROOM]
    fireEvent.click(within(bar).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    expect(toasts()).toContain('核对一致，已恢复下发')
  })

  it('核对读取途中换账号：结果作废，不解锁，旧读数不写进新会话的缓存', async () => {
    let mode: 'normal' | 'fail' | 'slow' = 'normal'
    const slowRead = deferred(() => reply200([{ ...ROOM, setTemp: 26 }, OFF_ROOM]))
    backend({
      '/ctrl/room-temperature-set': () => { mode = 'fail'; return json({ code: 4, message: 'x' }, 504) },
      '/ctrl/room-temperature-data-get': () => (mode === 'fail' ? json({ code: 14, message: 'x' }, 503) : mode === 'slow' ? slowRead.handler() : reply200(rooms)),
    })
    await draftAndSend()
    await confirmOk()
    const bar = await waitFor(() => { const b = document.querySelector('[data-lock="unknown"]') as HTMLElement; expect(b).toBeTruthy(); expect(b.textContent).toContain('可点「核对」'); return b })
    mode = 'slow'
    fireEvent.click(within(bar).getByRole('button', { name: '核对' }))
    await flush()
    await act(async () => { await signOut() })
    mode = 'normal'
    await act(async () => { await signIn('u2', 'pw', true) })
    await screen.findByText('客厅')
    await slowRead.release()
    await flush(80)
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
  })
  it('预检读取途中退出登录：读数丢弃、不写', async () => {
    const slowRead = deferred(() => reply200(rooms))
    let slow = false
    const be = backend({
      '/ctrl/room-temperature-set': ok201,
      '/ctrl/room-temperature-data-get': () => (slow ? slowRead.handler() : reply200(rooms)),
    })
    await draftAndSend()
    slow = true
    await confirmOk()
    await flush()
    await act(async () => { await signOut() })
    await slowRead.release()
    await flush(80)
    expect(writes(be)).toHaveLength(0)
    expect(document.querySelector('[data-lock]')).toBeNull()
  })

  it('锁定后重新挂载，首次读取 503 / 空列表：空态里也有锁提示和「核对」；503 按屏离线保持锁，读到一致才解锁', async () => {
    let mode: 'normal' | 'down' | 'empty' | 'applied' = 'normal'
    let wrote = false
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return json({ code: 4, message: 'x' }, 504) },
      '/ctrl/room-temperature-data-get': () => (mode === 'applied' ? reply200([{ ...ROOM, setTemp: 26 }, OFF_ROOM])
        : wrote && mode !== 'empty' ? json({ code: 14, message: '控制屏消息发送失败' }, 503) : reply200(mode === 'empty' ? [] : rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
    const bar = () => document.querySelector('[data-lock="unknown"]') as HTMLElement
    fireEvent.click(rawButton('去首页'))
    await screen.findByText('首页内容')
    await act(async () => { client.removeQueries({ queryKey: ['ctrl'] }) })
    mode = 'down'
    fireEvent.click(rawButton('回温控'))
    await screen.findByText('控制屏当前不在线，无法读取房间温控面板。', { exact: false })
    expect(bar()).toBeTruthy()
    fireEvent.click(within(bar()).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(toasts()).toContain('控制屏离线，暂时无法核对，可稍后再试'))
    expect(bar()).toBeTruthy()
    mode = 'empty'
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('未读到房间温控面板')
    expect(bar()).toBeTruthy()
    fireEvent.click(within(bar()).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(toasts()).toContain('面板当前值与下发值不一致，仍暂停下发'))
    mode = 'applied'
    fireEvent.click(within(bar()).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
  })
  it('写的过程中退出登录：旧操作不回读、不提示；同账号重新登录后看不到旧结果，可以正常下发', async () => {
    const slow = deferred(ok201)
    const be = backend({ '/ctrl/room-temperature-set': slow.handler })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await act(async () => { await signOut() })
    const readsAtLogout = be.callsTo('/ctrl/room-temperature-data-get').length
    await slow.release()
    await flush(80)
    expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBe(readsAtLogout) // 没用（新）凭据回读
    expect(toasts()).not.toContain('已下发')
    await act(async () => { await signIn('u', 'pw', true) })
    await screen.findByText('客厅')
    expect(card('客厅').textContent).not.toContain('已下发')
    expect(document.querySelector('[data-lock]')).toBeNull()
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(false)
  })

  it('写的过程中换账号、结果未知：写锁保留，新账号只看到泛化提示（不带房间名），房间禁用', async () => {
    const slow = deferred(() => json({ code: 4, message: 'x' }, 504))
    let user = 'admin-1'
    const be = backend({
      '/ctrl/room-temperature-set': slow.handler,
      '/me': () => json({ user_entity: { id: user, name: '测试' }, permission_paths: [] }),
      '/ctrl/room-temperature-data-get': () => reply200(rooms), // 与下发值不一致：核对不会解锁
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await act(async () => { await signOut() })
    await slow.release()
    user = 'admin-2'
    await act(async () => { await signIn('u2', 'pw', true) })
    await screen.findByText('客厅')
    const bar = await waitFor(() => { const b = document.querySelector('[data-lock="unknown"]') as HTMLElement; expect(b).toBeTruthy(); return b })
    expect(bar.textContent).toContain('上一账号的下发结果未知，请稍后再试或联系有权限的账号')
    expect(bar.textContent).not.toContain('客厅')
    expect(card('客厅').textContent).not.toContain('结果未知')
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true)
  })
  it('206：确认后新读到的房间列表变了 → 取消，要求重新确认', async () => {
    const be = backend({ '/ctrl/project-room-switch-set': ok206 })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部关闭' }))
    await dialog()
    rooms = [ROOM] // 少了一个房间，不触发轮询
    await confirmOk()
    await flush(80)
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).toContain('房间列表已变化（现为 1 个）')
  })
})

describe('共用写锁（按控制屏）', () => {
  it('同一块控制屏的另一个项目在下发：本项目全部下发禁用，并提示；对方放锁后恢复', async () => {
    backend()
    await openRooms()
    let r!: ReturnType<typeof acquireLock>
    act(() => { r = acquireLock({ id: 'p2', controlScreenId: 'SCREEN-T' }, '全部开启') })
    expect(r.ok).toBe(true)
    await waitFor(() => expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(true))
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true)
    expect(document.querySelector('[data-lock="held"]')?.textContent).toContain('同一控制屏上有一条下发正在进行')
    act(() => { if (r.ok) releaseLock(r.token) })
    await waitFor(() => expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('别的标签页放锁（写锁按到期处理、发强制重读）：本页重读设备状态', async () => {
    const be = backend()
    await openRooms()
    const key = 'screen:SCREEN-T'
    const rec = { v: 1, op: 'other-tab', keys: [key, 'project:' + P1.id], projectId: P1.id, userId: 'admin-1', sentAt: Date.now() - 1000, msg: 201, deviceId: ROOM.id, target: { temperature: 26 } }
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + key, newValue: JSON.stringify(rec) })) })
    await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')?.textContent).toContain('另一个标签页'))
    const reads = be.callsTo('/ctrl/room-temperature-data-get').length
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + key, newValue: null })) })
    await waitFor(() => expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(reads))
    expect(document.querySelector('[data-lock]')).toBeNull()
  })
})
