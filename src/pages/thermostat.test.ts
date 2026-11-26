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
import { ApiError } from '../api/errors'
import { fakeBackend, json, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests, setStoredProjectId } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetWritesForTests, LIMITS, STALE_TEXT, realSource as thermoRealSource } from '../features/thermostat'
import Layout from '../components/Layout'
import { OrgGate } from '../app/OrgGate'
import { __resetWriteLockForTests, configureWriteLock, lockOf as lockOfKey, subscribe as subscribeLock, acquire as acquireLock, release as releaseLock, STORAGE_PREFIX, verify as verifyLock, RETRY_DELAYS_MS } from '../api/writeLock'
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
/** 带 sub 的假 JWT（#24 的写入口要求令牌能解析出账号才发） */
const jwt = (sub: string, n = 1) => `h.${btoa(JSON.stringify({ sub, n }))}.s`
const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001', name: '测试项目0829', app_code: '1', app_name: '通用版', online: true, control_screen_id: 'SCREEN-T' }
const P2 = { id: 'p2', code: '261124009', name: '另一个项目', app_code: '1', app_name: '通用版', online: true, control_screen_id: 'SCREEN-T' }
const P12 = { id: 'p12', code: '260911001', name: '独立空气系统测试', app_code: '12', app_name: '独立空气系统', online: true }
const P4 = { id: 'p4', code: '230202001', name: '水舒适测试', app_code: '4', app_name: '水舒适', online: true, control_screen_id: 'SCREEN-4' }
const P8 = { id: 'p8', code: '230101001', name: '空气单机测试', app_code: '8', app_name: '空气系统单机版', online: true }
const POFF = { id: 'poff', code: '221031001', name: '科希家办公室', app_code: '1', app_name: '通用版' }
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: [P1.id, P2.id, P12.id, P8.id, P4.id, POFF.id] }]

/** 现有用例按房间开关可信写（roomSwitchReported = true）；开关未上报的情况单独一组 */
const SW = { roomSwitchReported: true }
const ENDS = [
  { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
  { optionName: '顶辐射', type: 1, isSelected: true, isChange: true, switch: 0 },
  { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 },
]
const ROOM = { id: 406658286, name: '客厅', temperature: 25.8, humidity: 51, dewPoint: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0, switch: 1, mode: 0, isConnected: true, endModes: ENDS }
const OFF_ROOM = { ...ROOM, id: 406658291, name: '主卧', switch: 0, setTemp: 26, windSpeed: 100, humidity: 65536, endModes: [ENDS[0]] }
const reply200 = (rooms: object[]) => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: rooms }) })
/** 201 应答 success，并且设备真的按下发值生效（之后的 200 读到新值）。success 只算已下发，核对一致才算已生效 */
const ok201 = (c?: Call) => {
  if (c) {
    const q = decodeReply(pb.RoomTemperatureSetQuerySchema, (c.body as { body: string }).body) as { equipmentId: number; temperature: number; eco: number; switch: number }
    rooms = rooms.map((r) => {
      const x = r as typeof ROOM
      if (x.id !== q.equipmentId) return r
      return { ...x, ...(q.temperature !== -1 ? { setTemp: q.temperature } : {}), ...(q.eco !== -1 ? { eco: q.eco } : {}), ...(q.switch !== -1 ? { switch: q.switch } : {}) }
    })
  }
  return json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: true }) })
}
/** 201 应答 success，但设备状态没有变化（回读未变化） */
const ok201NoApply = () => json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: true }) })
/** 206 应答 success，并且所有房间开关真的变了 */
const ok206 = (c?: Call) => {
  if (c) {
    const q = decodeReply(pb.ProjectRoomSwitchSetQuerySchema, (c.body as { body: string }).body) as { switch: number }
    rooms = rooms.map((r) => ({ ...(r as typeof ROOM), switch: q.switch }))
  }
  return json({ body: encodeMessage(pb.ProjectRoomSwitchSetReplySchema, { success: true }) })
}

/** 可变的 200：测试里改 rooms 再触发回读，模拟轮询读到的新状态 */
let rooms: object[] = []
function backend(routes: Record<string, Handler> = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: jwt('admin-1'), refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: ['/v1/ctrl/device-summary-get'] }),
    '/ctrl/projects': () => json({ project_entities: [P1, P2, P12, P8, P4, POFF] }),
    // 下发前的控制屏实时预检（ctrl 205）：默认在线
    '/ctrl/device-summary-get': () => json({ body: '' }),
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
function deferred(make: (c?: Call) => Response) {
  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  return { handler: async (c?: Call) => { await gate; return make(c) }, release: () => act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) }) }
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
/**
 * 假时钟（跟着真实时间走，waitFor、假后端照常用），需要时快进。写锁首次回读不是已生效时按 5 / 20 / 60 秒自动再核对，
 * 退避用完才显示四态结论：断言最终结论的用例先 fakeClock()，再 runRetries() 把退避真跑完
 */
const fakeClock = () => vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
/** 把自动再核对（5 / 20 / 60 秒）跑完：每次退避到点后等那次核对读完 */
async function runRetries() { for (const d of RETRY_DELAYS_MS) { await advance(d); await flush() } }

async function open(project: { id: string } = P1) {
  localStorage.setItem('hjc-project', project.id)
  await signIn('u', 'pw', true)
  mount()
}
async function openRooms() {
  await open()
  await screen.findByText('客厅', { selector: '.room-name' })
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
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', features: SW })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); __resetWritesForTests(); __resetWriteLockForTests(); clearTokens()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null) })

describe('读取（ctrl 200）', () => {
  it('房间卡：末端按 end_modes 动态显示（选中实心 / 未选中白底，开 / 关取 switch），风速档位与自动，65536 隐藏，设定湿度去除', async () => {
    const be = backend()
    const c = await openRooms()
    const ends = [...c.querySelectorAll('.modes-row .end-tag')].map((b) => [b.textContent, b.getAttribute('data-selected')])
    expect(ends).toEqual([['风盘·开', 'true'], ['顶辐射·关', 'true'], ['地冷·关', 'false']])
    expect(c.textContent).toContain('3 档')
    expect(c.textContent).toContain('湿度 51%')
    expect(c.textContent).not.toContain('设定湿度')
    expect(c.textContent).toContain('客厅制冷') // S13：名称下方只写工作模式，不带房间 ID
    expect(c.textContent).not.toContain('406658286')
    const off = card('主卧')
    expect(off.textContent).not.toContain('湿度') // 65536 隐藏
    expect(off.querySelectorAll('.modes-row .end-tag')).toHaveLength(1)
    expect((be.callsTo('/ctrl/room-temperature-data-get')[0].body as { project_id: string }).project_id).toBe(P1.id)
  })

  it('S13：房间按名称自然排序（11、12、13），卡片和统计下拉都不显示房间 ID，同名用 (2) 区分；风速 0 显示「0 档」', async () => {
    rooms = [
      { ...ROOM, id: 11, name: '房间11' }, { ...ROOM, id: 13, name: '房间13', windSpeed: 0 }, { ...ROOM, id: 12, name: '房间12' }, { ...ROOM, id: 14, name: '房间11' },
    ]
    backend()
    await open()
    await screen.findByText('房间13', { selector: '.room-name' })
    expect([...document.querySelectorAll('.room-name')].map((e) => e.textContent)).toEqual(['房间11', '房间11 (2)', '房间12', '房间13'])
    expect([...document.querySelectorAll('option')].map((e) => e.textContent)).toEqual(['房间11', '房间11 (2)', '房间12', '房间13'])
    expect([...document.querySelectorAll('.room-id')].map((e) => e.textContent)).toEqual(['制冷', '制冷', '制冷', '制冷'])
    expect(card('房间13').textContent).toContain('0 档')
  })

  it('末端一行：小标题「末端（点击选择参与运行的末端）」，每个末端是可点的按钮；开 / 关只读，tooltip 写「开/关由控制屏自动控制」', async () => {
    backend()
    const c = await openRooms()
    const row = c.querySelector('.modes-row') as HTMLElement
    expect(row.querySelector('.ends-h')!.textContent).toBe('末端（点击选择参与运行的末端）')
    const tags = within(row).getAllByRole('button')
    expect(tags.map((b) => b.getAttribute('aria-label'))).toEqual(['客厅 末端 风盘', '客厅 末端 顶辐射', '客厅 末端 地冷'])
    expect(tags.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'false'])
    const sw = [...row.querySelectorAll('[data-end-switch]')]
    expect(sw.map((x) => [x.textContent, x.getAttribute('title')])).toEqual([['开', '开/关由控制屏自动控制'], ['关', '开/关由控制屏自动控制'], ['关', '开/关由控制屏自动控制']])
    // 开 / 关本身不是按钮（只读）
    expect(sw.every((x) => x.tagName === 'SPAN')).toBe(true)
  })

  it('末端标签为实心填充单层：按钮是唯一带底色 / 边框的元素（内层无 badge），文字「名称 · 开 / 关」，保留开（绿）/ 关（灰）小圆点', async () => {
    backend()
    const c = await openRooms()
    const tags = within(c.querySelector('.modes-row') as HTMLElement).getAllByRole('button')
    for (const t of tags) {
      expect(t.querySelector('[data-slot=badge]')).toBeNull()
      expect(t.querySelector('.end-dot')).not.toBeNull()
    }
    expect(tags.map((t) => t.textContent)).toEqual(['风盘·开', '顶辐射·关', '地冷·关'])
    expect(tags.map((t) => t.getAttribute('data-selected'))).toEqual(['true', 'true', 'false'])
    expect(tags.map((t) => t.querySelector('.end-dot')!.getAttribute('data-on'))).toEqual(['true', 'false', 'false'])
    expect(c.querySelector('.end-lock')).toBeNull()
  })

  it('S13：app_code 12 的页头和说明只写程序名称，不写程序编码', async () => {
    backend()
    await open(P12)
    await screen.findByText('该项目无房间温控面板')
    const sub = document.querySelector('.page-head .sub')!.textContent!
    expect(sub).toContain('程序 ')
    expect(document.querySelector('.page')!.textContent).not.toMatch(/编码/)
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

  it('app_code 8 按 12 处理（后端 11/26）：显示「该项目无房间温控面板」，不读 ctrl 200、不发 201；不提新风运行设置（只有 12 有）', async () => {
    const be = backend()
    await open(P8)
    await screen.findByText('该项目无房间温控面板')
    await flush(50)
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(0)
    expect(be.callsTo('/ctrl/room-temperature-set')).toHaveLength(0)
    const ph = document.querySelector('.placeholder')!.textContent!
    expect(ph).toContain('不包含房间温控面板')
    expect(ph).not.toMatch(/运行设置|新风单机版/)
    expect(screen.queryByRole('button', { name: '下发' })).toBeNull()
  })

  it('app_code 4 等其他类型照常显示温控面板、读 ctrl 200（只有 8、12 无面板，负责人 11/26 08:47）', async () => {
    const be = backend()
    await open(P4)
    await screen.findByText('客厅', { selector: '.room-name' })
    expect(screen.queryByText('该项目无房间温控面板')).toBeNull()
    expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(0)
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
  it('− / + 只改草稿；下发 → 确认（含项目名，不含项目编号）→ 只发一条 201：温度是真实值，其余 -1，end_modes 没改传空列表；success 才提示成功并回读', async () => {
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
    expect(dlg.textContent).not.toContain('240829001') // S13：界面不显示项目 id
    for (const t of ['测试项目0829', '客厅', '设定温度 25.5 → 24.5°C', '设置温度不会开启房间，房间开启后按此温度运行']) expect(dlg.textContent).toContain(t)
    expect(writes(be)).toHaveLength(0)
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(toasts()).toContain('客厅 已生效：设定温度 24.5°C'))
    const w = writes(be)
    expect(w).toHaveLength(1)
    expect(w[0].url).toBe('/api/ctrl/room-temperature-set')
    expect((w[0].body as { project_id: string }).project_id).toBe(P1.id)
    expect(body201(w[0])).toEqual({ equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: [] })
    await waitFor(() => expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(reads))
    await waitFor(() => expect(card('客厅').textContent).not.toContain('待下发'))
  })

  it('end_modes 没改就传空列表（后端 11/25 答复第 3 条）：确认期间末端读数变了（含末端 switch）也照发，末端仍是空列表', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    await draftAndSend()
    await poll([{ ...ROOM, endModes: [{ ...ENDS[0], switch: 0 }, ENDS[1], ENDS[2]] }, OFF_ROOM])
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0]).endModes).toEqual([])
  })

  it('读不到末端（end_modes 为空）：照常能改温度、节能和开关，下发时末端传空列表', async () => {
    rooms = [{ ...ROOM, endModes: [] }]
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    for (const n of ['客厅 设定温度降低', '客厅 设定温度升高']) expect(btn(c, n).disabled).toBe(false)
    for (const n of ['客厅 节能模式', '客厅 开关']) expect((within(c).getByRole('switch', { name: n }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(btn(c, '客厅 设定温度升高'))
    fireEvent.click(btn(c, '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toMatchObject({ temperature: 26, endModes: [] })
  })

  it('最近一次读取失败（有旧数据）：不能下发', async () => {
    backend()
    const c = await openRooms()
    expect(btn(c, '客厅 设定温度升高').disabled).toBe(false)
    fakeBackend({ '/ctrl/room-temperature-data-get': () => json({ code: 13, message: 'x' }, 500) })
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await waitFor(() => expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true))
  })

  it('有草稿时一次读取失败：草稿保留、下发禁用并写明原因、不提示清除；恢复后草稿仍在，可下发', async () => {
    let fail = false
    const be = backend({
      '/ctrl/room-temperature-data-get': () => (fail ? json({ code: 13, message: 'x' }, 500) : reply200(rooms)),
      '/ctrl/room-temperature-set': ok201,
    })
    const c = await openRooms()
    fireEvent.click(btn(c, '客厅 设定温度升高'))
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C')
    fail = true
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await waitFor(() => expect(btn(card('客厅'), '下发').disabled).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C')
    expect(btn(card('客厅'), '下发').title).toBe(STALE_TEXT)
    expect(card('客厅').textContent).toContain(STALE_TEXT)
    expect(toastLog.join()).not.toContain('未下发的修改已清除')
    fail = false
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(btn(card('客厅'), '下发').disabled).toBe(false))
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C')
    fireEvent.click(btn(card('客厅'), '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toMatchObject({ temperature: 26 })
  })

  it('基准 21.5、草稿 21.0 → 读取失败 → 恢复时面板 22.0：草稿保留、提示外部变化，没有下发按钮（靠草稿冲突检测拦，0 个 201）', async () => {
    let fail = false
    const be = backend({
      '/ctrl/room-temperature-data-get': () => (fail ? json({ code: 13, message: 'x' }, 500) : reply200(rooms)),
      '/ctrl/room-temperature-set': ok201,
    })
    rooms = rooms.map((r) => ((r as { name?: string }).name === '客厅' ? { ...r, setTemp: 21.5 } : r))
    const c = await openRooms()
    await waitFor(() => expect(card('客厅').textContent).toContain('21.5'))
    fireEvent.click(btn(c, '客厅 设定温度降低'))
    expect(card('客厅').textContent).toContain('21.5 → 21.0')
    fail = true
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await waitFor(() => expect(btn(card('客厅'), '下发').disabled).toBe(true))
    rooms = rooms.map((r) => ((r as { name?: string }).name === '客厅' ? { ...r, setTemp: 22.0 } : r))
    fail = false
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(card('客厅').textContent).toContain('面板设定温度已在外部变化'))
    expect(within(card('客厅')).getByRole('button', { name: '放弃修改' })).toBeTruthy() // 草稿保留，只能放弃
    expect(within(card('客厅')).queryByRole('button', { name: '下发' })).toBeNull()
    await new Promise((r) => setTimeout(r, 100))
    expect(writes(be)).toHaveLength(0)
    expect(toastLog.join()).not.toContain('未下发的修改已清除')
  })

  it('有草稿时读取失败、随后房间真正离线（面板未连接）：照旧清草稿并提示一次', async () => {
    let fail = false
    backend({ '/ctrl/room-temperature-data-get': () => (fail ? json({ code: 13, message: 'x' }, 500) : reply200(rooms)) })
    const c = await openRooms()
    fireEvent.click(btn(c, '客厅 设定温度升高'))
    fail = true
    await act(async () => { await client.refetchQueries({ type: 'active' }).catch(() => {}) })
    await waitFor(() => expect(btn(card('客厅'), '下发').disabled).toBe(true))
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C')
    fail = false
    rooms = rooms.map((r) => ((r as { name?: string }).name === '客厅' ? { ...r, isConnected: false } : r))
    await act(async () => { await client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(card('客厅').textContent).not.toContain('25.5 → 26.0'))
    await new Promise((r) => setTimeout(r, 50))
    expect(toastLog.filter((x) => x.includes('未下发的修改已清除'))).toHaveLength(1)
  })

  it('success 但回读设备未变化：只算已下发，不提示成功，卡片显示「指令已下发，设备状态暂未变化」，草稿保留、写锁保持', async () => {
    fakeClock()
    const be = backend({ '/ctrl/room-temperature-set': ok201NoApply })
    await draftAndSend()
    await confirmOk()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(writes(be)).toHaveLength(1)
    expect(toasts()).not.toContain('已生效')
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C') // 草稿保留
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    expect(btn(card('主卧'), '主卧 设定温度升高').disabled).toBe(true)
  })

  it('只改节能：eco=1，温度等其余 -1', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 节能模式' }))
    expect(c.textContent).toContain('节能模式 标准 → 节能')
    fireEvent.click(btn(c, '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: 1, switch: -1, endModes: [] })
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

  it('房间开关：确认期间读到的房间开关变了 → 不下发（用的是最新读数，不是弹窗前的）', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 开关' }))
    await dialog()
    await poll([{ ...ROOM, switch: 0 }, OFF_ROOM])
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
    await screen.findByText('客厅', { selector: '.room-name' })
    const c = card('客厅')
    expect(btn(c, '客厅 设定温度升高').disabled).toBe(true)
    expect((within(c).getByRole('switch', { name: '客厅 开关' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(true)
    expect(c.textContent).toContain('正在下发')
    await slow.release()
    await waitFor(() => expect(toasts()).toContain('客厅 已生效'))
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
    await waitFor(() => expect(card('客厅')?.textContent).toContain('客厅 已生效：设定温度 26.0°C'))
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
    await screen.findByText('客厅', { selector: '.room-name' })
    expect((screen.getByRole('button', { name: '全部关闭' }) as HTMLButtonElement).disabled).toBe(true)
    await slow.release()
    await waitFor(() => expect(toasts()).toContain('已生效：全部开启'))
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
    fakeClock()
    let wrote = false
    const slowRead = deferred(() => reply200(rooms))
    const be = backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return json({ code: 4, message: 'deadline exceeded' }, 504) },
      '/ctrl/room-temperature-data-get': () => (wrote ? slowRead.handler() : reply200(rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(card('客厅').textContent).toContain('正在核对'))
    expect(toasts()).toContain('客厅 下发结果未知')
    expect(toasts()).not.toContain('下发失败')
    await slowRead.release()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C')
    expect(within(card('客厅')).queryByRole('button', { name: '重试' })).toBeNull()
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true)
    expect(writes(be)).toHaveLength(1)
  })
  it('504 且回读失败：说明无法核对，不给重试', async () => {
    fakeClock()
    let fail = false
    backend({
      '/ctrl/room-temperature-set': () => { fail = true; return json({ code: 4, message: 'deadline exceeded' }, 504) },
      '/ctrl/room-temperature-data-get': () => (fail ? json({ code: 14, message: 'x' }, 503) : reply200(rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('结果未知（回读失败）'))
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
      setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', features: SW, ...cfg })
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
    expect(dlg.textContent).toContain('测试项目0829的「客厅」下发「关闭」')
    expect(dlg.textContent).not.toContain('240829001')
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: 0, endModes: [] })
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
    await waitFor(() => expect(toasts()).toContain('已生效：全部开启（2 个房间）'))
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
  it('确认后不等轮询：先新发一次 200，再用这份读数组装 201（末端没改，传空列表）', async () => {
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
    expect(body201(writes(be)[0]).endModes).toEqual([])
  })

  it('确认后不等轮询：设备的设定值 / 开关 / 连接已变 → 新读到后取消，不写', async () => {
    for (const next of [{ ...ROOM, setTemp: 24 }, { ...ROOM, switch: 0 }, { ...ROOM, isConnected: false }]) {
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
    await waitFor(() => expect(toasts()).toContain('客厅 已生效'))
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
    expect(lockBar().textContent).toContain('上次下发（客厅）：结果未知')
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
    setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', features: SW, ctrlTimeoutMs: 100 })
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
    await screen.findByText('客厅', { selector: '.room-name' })
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
    fakeClock()
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
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
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
    await waitFor(() => expect(toasts()).toContain('该项暂无回读，无法确认，仍暂停下发')) // 空列表：无法核对
    expect(bar().textContent).toContain('：该项暂无回读，无法确认')
    mode = 'applied'
    fireEvent.click(within(bar()).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
  })
  it('写的过程中退出登录：旧操作不回读、不提示；同账号重新登录后看不到旧结果，锁仍在（success 只算已下发），核对一致后可以正常下发', async () => {
    fakeClock()
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
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await act(async () => { await signIn('u', 'pw', true) })
    await screen.findByText('客厅', { selector: '.room-name' })
    expect(card('客厅').textContent).not.toContain('已下发')
    const bar = document.querySelector('[data-lock="unknown"]') as HTMLElement
    expect(bar.textContent).toContain('已下发，结果未知')
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(true)
    fireEvent.click(within(bar).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    expect(btn(card('客厅'), '客厅 设定温度升高').disabled).toBe(false)
  })

  it('写的过程中换账号、结果未知：写锁保留，新账号只看到泛化提示（不带房间名），房间禁用', async () => {
    const slow = deferred(() => json({ code: 4, message: 'x' }, 504))
    let user = 'admin-1'
    const be = backend({
      '/ctrl/room-temperature-set': slow.handler,
      '/me': () => json({ user_entity: { id: user, name: '测试' }, permission_paths: ['/v1/ctrl/device-summary-get'] }),
      '/ctrl/room-temperature-data-get': () => reply200(rooms), // 与下发值不一致：核对不会解锁
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await act(async () => { await signOut() })
    await slow.release()
    user = 'admin-2'
    await act(async () => { await signIn('u2', 'pw', true) })
    await screen.findByText('客厅', { selector: '.room-name' })
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

describe('#35 评审修正', () => {
  it('写接口 503 不带 code 14（网关纯文本 503 / JSON 无 code）：结果未知，不说失败，锁保持、草稿保留；503 + code 14 才是未下发、放锁（没发出，草稿保留可再下发）', async () => {
    const plain503 = () => new Response('Service Unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })
    for (const make of [plain503, () => json({ message: 'upstream unavailable' }, 503)]) {
      const be = backend({ '/ctrl/room-temperature-set': make })
      await draftAndSend()
      await confirmOk()
      await waitFor(() => expect(toasts()).toContain('客厅 下发结果未知'))
      expect(toasts()).not.toContain('下发失败')
      expect(toasts()).not.toContain('未下发')
      expect(writes(be)).toHaveLength(1)
      await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
      expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C') // 草稿保留
      expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(true)
      cleanup(); vi.unstubAllGlobals(); __resetWritesForTests(); __resetWriteLockForTests(); toastLog = []; localStorage.clear()
      __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
    }
    const be = backend({ '/ctrl/room-temperature-set': () => json({ code: 14, message: '控制屏消息发送失败' }, 503) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toMatch(/客厅 未下发：/))
    expect(writes(be)).toHaveLength(1)
    await waitFor(() => expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(false))
    expect(document.querySelector('[data-lock]')).toBeNull()
    expect(card('客厅').textContent).toContain('待下发：设定温度 25.5 → 26.0°C') // 没发出：草稿保留（不是待确认）
    expect(card('客厅').querySelector('[data-pending]')).toBeNull()
  })

  it('206 全部开启：记录确认后预检的目标房间 id 集合；回读只剩部分房间（其余都一致）→ 无法核对，不提示全部已生效、锁保持，记录带 roomIds', async () => {
    fakeClock()
    const be = backend({ '/ctrl/project-room-switch-set': (c) => { const r = ok206(c); rooms = rooms.slice(0, 1); return r } })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    const bar = await waitFor(() => { const b = document.querySelector('[data-result="all"]') as HTMLElement; expect(b?.textContent).toContain('该项暂无回读，无法确认'); return b })
    expect(bar.textContent).not.toContain('已生效')
    expect(toasts()).not.toContain('已生效')
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    const stored = JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'screen:SCREEN-T')!)
    expect(stored).toMatchObject({ msg: 206, target: { switch: 1 }, roomIds: [ROOM.id, OFF_ROOM.id] })
  })

  it('草稿冻结：已下发待核对期间，面板离线、目标房间缺失、回读失败、读到部分一致都不整理 / 清除草稿；写锁核对一致后才清，之后不复活', async () => {
    fakeClock()
    let readFail = false
    backend({
      '/ctrl/room-temperature-set': ok201NoApply,
      '/ctrl/room-temperature-data-get': () => (readFail ? json({ code: 13, message: 'internal' }, 500) : reply200(rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    const kept = () => expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C')
    kept()
    await poll([{ ...ROOM, isConnected: false }, OFF_ROOM]) // 面板离线
    kept()
    await poll([OFF_ROOM]) // 目标房间缺失
    expect(card('客厅')).toBeUndefined()
    await poll([ROOM, OFF_ROOM])
    kept()
    readFail = true
    await poll([ROOM, OFF_ROOM]) // 回读失败（有旧数据）
    kept()
    readFail = false
    await poll([{ ...ROOM, switch: 0 }, OFF_ROOM]) // 房间关闭（不能设置）
    expect(toasts()).not.toContain('未下发的修改已清除')
    await poll([ROOM, OFF_ROOM])
    kept()
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    // 设备生效后核对一致：写锁放开，草稿才清；面板值再变回去，旧改动不复活
    rooms = [{ ...ROOM, setTemp: 26 }, OFF_ROOM]
    fireEvent.click(within(document.querySelector('[data-lock="unknown"]') as HTMLElement).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    await waitFor(() => expect(toasts()).toContain('客厅 已生效'))
    await poll([ROOM, OFF_ROOM])
    expect(card('客厅').textContent).not.toContain('待下发')
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
  })

  it('未发出（确认后预检不一致）：草稿解冻，照常整理（之后同屏别的项目在下发，也不按冻结对待）', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    await draftAndSend()
    rooms = [{ ...ROOM, setTemp: 24 }, OFF_ROOM] // 设定值在外部变了：预检不一致，不写
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('本次未下发'))
    expect(writes(be)).toHaveLength(0)
    const other = acquireLock({ id: P2.id, controlScreenId: P2.control_screen_id }, '另一个项目')
    expect(other.ok).toBe(true)
    await poll([{ ...ROOM, setTemp: 24, switch: 0 }, OFF_ROOM])
    expect(toasts()).toContain('未下发的修改已清除')
    act(() => { if (other.ok) releaseLock(other.token) })
  })
})

describe('#35 第二轮：206 目标集合、到期后草稿保留', () => {
  for (const [what, bad, reason] of [
    ['有房间设备 ID 为 0', { ...OFF_ROOM, id: 0 }, '有 1 个设备 ID 无效'],
    ['有重复的设备 ID', { ...OFF_ROOM, id: ROOM.id }, '有重复的设备 ID'],
  ] as const) {
    it(`206：原始 200 里${what} → 不弹确认、不下发，说明原因`, async () => {
      const be = backend({ '/ctrl/project-room-switch-set': ok206 })
      rooms = [ROOM, OFF_ROOM, bad]
      await openRooms()
      fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
      await waitFor(() => expect(toasts()).toContain(reason))
      expect(toasts()).toContain('本次未下发')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(writes(be)).toHaveLength(0)
    })
  }
  it('206：确认文案的房间数按原始 200 完整列表；确认后预检读到无效 ID → 取消，不下发', async () => {
    const be = backend({ '/ctrl/project-room-switch-set': ok206 })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
    expect((await dialog()).textContent).toContain('2 个温控面板')
    rooms = [ROOM, OFF_ROOM, { ...OFF_ROOM, id: 0 }]
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('设备 ID 无效'))
    expect(writes(be)).toHaveLength(0)
    expect(document.querySelector('[data-lock]')).toBeNull()
  })

  /** 下发温度 +0.5，设备未生效（锁保持），然后让写锁过期：把时钟拨过有效期再点「核对」（核对前查到期 → 到期放锁 + 强制重读） */
  async function sendThenExpire(during: object[]) {
    fakeClock()
    const be = backend({ '/ctrl/room-temperature-set': ok201NoApply })
    await draftAndSend()
    await confirmOk()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    await poll(during)
    const t = Date.now() + 3 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(t)
    fireEvent.click(within(document.querySelector('[data-lock="unknown"]') as HTMLElement).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    await flush(80)
    return be
  }
  it('锁到期时面板离线：只恢复下发资格并强制重读，草稿保留（标「上次下发未核对一致」），结果条写明已到期；「放弃本次改动」才清', async () => {
    const be = await sendThenExpire([{ ...ROOM, isConnected: false }, OFF_ROOM])
    expect(toasts()).not.toContain('未下发的修改已清除')
    const c = card('客厅')
    expect(c.querySelector('[data-pending]')?.textContent).toContain('上次下发未核对一致：设定温度 25.5 → 26.0°C')
    expect(c.textContent).toContain('写锁有效期已到')
    await poll([{ ...ROOM, isConnected: false }, OFF_ROOM])
    expect(card('客厅').querySelector('[data-pending]')).toBeTruthy()
    fireEvent.click(btn(card('客厅'), '放弃本次改动'))
    await poll([ROOM, OFF_ROOM])
    expect(card('客厅').textContent).not.toContain('待下发')
    expect(card('客厅').querySelector('[data-pending]')).toBeNull()
    expect(within(card('客厅')).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
    expect(writes(be)).toHaveLength(1)
  })
  it('锁到期时目标房间缺失：草稿保留；房间回来后仍是「上次下发未核对一致」，可重新下发', async () => {
    const be = await sendThenExpire([OFF_ROOM])
    expect(toasts()).not.toContain('未下发的修改已清除')
    await poll([ROOM, OFF_ROOM])
    const c = card('客厅')
    expect(c.querySelector('[data-pending]')?.textContent).toContain('上次下发未核对一致')
    expect(btn(c, '重新下发').disabled).toBe(false)
    expect(writes(be)).toHaveLength(1)
  })
  it('锁到期后面板读数已等于草稿（不是有效核对）：草稿仍保留，由用户放弃', async () => {
    await sendThenExpire([ROOM, OFF_ROOM])
    await poll([{ ...ROOM, setTemp: 26 }, OFF_ROOM])
    expect(card('客厅').querySelector('[data-pending]')?.textContent).toContain('设定温度 → 26.0°C')
    fireEvent.click(btn(card('客厅'), '放弃本次改动'))
    await flush()
    expect(card('客厅').querySelector('[data-pending]')).toBeNull()
  })
})

describe('#35 第三轮：回读 ID 歧义、重新下发中止、跨项目', () => {
  it('201 写后回读里目标设备 ID 重复（第一条恰好一致）：无法核对，不提示成功、锁保持、草稿保留', async () => {
    fakeClock()
    backend({ '/ctrl/room-temperature-set': (c) => { ok201(c); rooms = [rooms[0], { ...ROOM }, OFF_ROOM]; return ok201NoApply() } })
    await draftAndSend()
    await confirmOk()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('该项暂无回读，无法确认'))
    expect(toasts()).not.toContain('已生效')
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    expect(card('客厅').querySelector('[data-pending]')).toBeTruthy()
  })
  it('206 写后回读里多出设备 ID 为 0 的房间（其余都一致）：无法核对，不提示全部已生效、锁保持', async () => {
    fakeClock()
    backend({ '/ctrl/project-room-switch-set': (c) => { const r = ok206(c); rooms = [...rooms, { ...OFF_ROOM, id: 0, switch: 1 }]; return r } })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
    await confirmOk()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(document.querySelector('[data-result="all"]')?.textContent).toContain('该项暂无回读，无法确认'))
    expect(toasts()).not.toContain('已生效')
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
  })

  /** 下发温度 +0.5，设备未生效；把时钟拨过有效期再点「核对」（到期放锁 + 强制重读） */
  async function expired() {
    const be = backend({ '/ctrl/room-temperature-set': ok201NoApply })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000)
    fireEvent.click(within(document.querySelector('[data-lock="unknown"]') as HTMLElement).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    await flush(80)
    expect(card('客厅').querySelector('[data-pending]')?.textContent).toContain('上次下发未核对一致')
    return be
  }
  for (const [what, next] of [['房间消失', [OFF_ROOM]], ['面板离线', [{ ...ROOM, isConnected: false }, OFF_ROOM]]] as const) {
    it(`到期后重新下发、确认后预检读到${what}：本次未发出，恢复原来的待确认，草稿不被普通整理清除`, async () => {
      const be = await expired()
      fireEvent.click(btn(card('客厅'), '重新下发'))
      await dialog()
      rooms = [...next]
      await confirmOk()
      await waitFor(() => expect(toasts()).toContain('本次未下发'))
      expect(writes(be)).toHaveLength(1)
      await poll([...next])
      await poll([...next])
      expect(toasts()).not.toContain('未下发的修改已清除')
      await poll([ROOM, OFF_ROOM])
      expect(card('客厅').querySelector('[data-pending]')?.textContent).toContain('上次下发未核对一致：设定温度 25.5 → 26.0°C')
    })
  }

  it('跨项目：A 下发未核对一致后切到 B（同一页面实例）编辑，A 的核对后来一致——不清 B 的草稿', async () => {
    const P3 = { id: 'p3', code: '261124010', name: '第三个项目', app_code: '1', app_name: '通用版', online: true, control_screen_id: 'SCREEN-3' }
    backend({
      '/ctrl/room-temperature-set': ok201NoApply,
      '/ctrl/projects': () => json({ project_entities: [P1, P2, P12, POFF, P3] }),
      '/integrated-projects': () => json({ entities: [{ ...GROUPS[0], project_ids: [...GROUPS[0].project_ids, P3.id] }] }),
    })
    localStorage.setItem('hjc-project', P1.id)
    await signIn('u', 'pw', true)
    // 不经 Layout（Layout 按项目重挂页面）：同一个页面实例跨项目，才可能有迟到回调
    client = createQueryClient()
    render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
      createElement(MemoryRouter, { initialEntries: ['/thermostat'] },
        createElement(Routes, null, createElement(Route, { element: createElement(OrgGate, null, createElement(Thermostat)), path: '/thermostat' }))))))
    await screen.findByText('客厅', { selector: '.room-name' })
    fireEvent.click(btn(card('客厅'), '客厅 设定温度升高'))
    fireEvent.click(btn(card('客厅'), '下发'))
    await confirmOk()
    await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
    act(() => { setStoredProjectId(P3.id) })
    await waitFor(() => expect(document.querySelector('.page-head .sub')?.textContent).toContain('第三个项目'))
    fireEvent.click(btn(card('客厅'), '客厅 设定温度降低'))
    expect(card('客厅').textContent).toContain('待下发：设定温度 25.5 → 25.0°C')
    rooms = [{ ...ROOM, setTemp: 26 }, OFF_ROOM] // A 的设备后来生效
    await act(async () => { await verifyLock('screen:SCREEN-T') })
    await flush(80)
    expect(card('客厅').textContent).toContain('待下发：设定温度 25.5 → 25.0°C')
  })
})

describe('#35 第四轮：重新下发没发出（写防护 / 503 code 14 / 认领前断网）', () => {
  async function expiredThenRetry(retryWrite: () => Response | Promise<Response>, setup?: () => void) {
    let n = 0
    const be = backend({ '/ctrl/room-temperature-set': () => (++n === 1 ? ok201NoApply() : retryWrite()) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000)
    fireEvent.click(within(document.querySelector('[data-lock="unknown"]') as HTMLElement).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    await flush(80)
    setup?.()
    fireEvent.click(btn(card('客厅'), '重新下发'))
    await confirmOk()
    await waitFor(() => expect(toasts()).toMatch(/客厅 未下发：/))
    await flush(80)
    await poll([ROOM, OFF_ROOM])
    // 本次没发出：上次的待确认原样恢复，草稿不清
    expect(card('客厅').querySelector('[data-pending]')?.textContent).toContain('上次下发未核对一致：设定温度 25.5 → 26.0°C')
    expect(document.querySelector('[data-lock]')).toBeNull()
    return be
  }
  it('503 code 14', async () => {
    const be = await expiredThenRetry(() => json({ code: 14, message: '控制屏消息发送失败' }, 503))
    expect(writes(be)).toHaveLength(2)
  })
  it('写防护拦截（项目不在写入名单）', async () => {
    const be = await expiredThenRetry(() => ok201(), () => setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', features: SW, writeProjectCodes: ['999999999'] }))
    expect(writes(be)).toHaveLength(1)
  })
  it('认领前断网（写入口在 beforeSend 之前就出错，如发送前续期断网）', async () => {
    const be = await expiredThenRetry(() => ok201(), () => {
      // 写入口在调 beforeSend 之前抛网络错误（不认领、不发 fetch）
      vi.spyOn(thermoRealSource, 'setRoom').mockRejectedValue(new ApiError('network', '网络中断'))
    })
    expect(writes(be)).toHaveLength(1)
  })
})

describe('#35 第五轮：201 目标 ID 唯一、核对读数写缓存的时机', () => {
  const DUP = { ...ROOM, name: '客厅', setTemp: 22 }
  it('单房间设置：原始 200 里目标设备 ID 重复 → 不弹确认、不下发，提示重新核对', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    rooms = [ROOM, OFF_ROOM, DUP]
    await open()
    await screen.findAllByText('客厅', { selector: '.room-name' })
    fireEvent.click(btn(card('客厅'), '客厅 设定温度升高'))
    fireEvent.click(btn(card('客厅'), '下发'))
    await waitFor(() => expect(toasts()).toContain('出现了 2 次，无法确定目标房间'))
    expect(toasts()).toContain('请重新核对后再下发')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes(be)).toHaveLength(0)
  })
  it('单房间开关：原始 200 里目标设备 ID 重复 → 不弹确认、不下发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    rooms = [ROOM, OFF_ROOM, DUP]
    await open()
    await screen.findAllByText('客厅', { selector: '.room-name' })
    fireEvent.click(within(card('客厅')).getByLabelText('客厅 开关'))
    await waitFor(() => expect(toasts()).toContain('无法确定目标房间'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes(be)).toHaveLength(0)
  })
  for (const kind of ['设置', '开关'] as const) {
    it(`单房间${kind}：确认后预检读到目标设备 ID 重复 → 取消，不下发`, async () => {
      const be = backend({ '/ctrl/room-temperature-set': ok201 })
      const c = await openRooms()
      if (kind === '设置') { fireEvent.click(btn(c, '客厅 设定温度升高')); fireEvent.click(btn(card('客厅'), '下发')) }
      else fireEvent.click(within(c).getByLabelText('客厅 开关'))
      await dialog()
      rooms = [ROOM, OFF_ROOM, DUP]
      await confirmOk()
      await waitFor(() => expect(toasts()).toContain('无法确定目标房间'))
      expect(writes(be)).toHaveLength(0)
      expect(document.querySelector('[data-lock]')).toBeNull()
    })
  }

  const roomTemp = () => card('客厅').querySelector('.room-temp')?.textContent
  it('核对被写锁拒绝（跨过有效期）：候选读数不写缓存，卡片不被这次旧核对的读数覆盖', async () => {
    let wrote = false
    let n = 0
    const verify = deferred(() => reply200([{ ...ROOM, temperature: 30 }, OFF_ROOM]))
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => (!wrote ? reply200(rooms) : ++n === 1 ? verify.handler() : json({ code: 13, message: 'internal' }, 500)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(n).toBe(1)) // 写锁自动核对的读取已发出，卡在 verify 上
    expect(roomTemp()).toBe('25.8°C')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000)
    await verify.release() // 返回时已过有效期：写锁按到期放锁、强制重读（重读失败），不认可这次核对
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    await flush(80)
    expect(roomTemp()).toBe('25.8°C') // 旧核对的读数没进缓存
  })
  it('核对被写锁认可但读取早于另一次更新的读数：按读取序号不覆盖更新的读数', async () => {
    fakeClock()
    let wrote = false
    let n = 0
    const verify = deferred(() => reply200([{ ...ROOM, temperature: 30 }, OFF_ROOM]))
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => (!wrote ? reply200(rooms) : ++n === 1 ? verify.handler() : reply200([{ ...ROOM, temperature: 20 }, OFF_ROOM])),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(n).toBe(1)) // 写锁自动核对的读取已发出，卡在 verify 上
    await act(async () => { await client.refetchQueries({ type: 'active' }) }) // 之后发起的轮询先返回更新的读数
    await waitFor(() => expect(roomTemp()).toBe('20.0°C'))
    await verify.release() // 旧核对返回：不一致，写锁认可并记下逐字段
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(roomTemp()).toBe('20.0°C')
  })

  it('旧核对跨过到期、晚于到期后的强制重读返回：不覆盖强制重读的新读数', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      let wrote = false
      let holdFrom = Infinity
      let held: ReturnType<typeof deferred> | null = null
      let after = 0
      backend({
        '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
        '/ctrl/room-temperature-data-get': () => {
          if (!wrote) return reply200(rooms)
          if (!held && Date.now() >= holdFrom) { held = deferred(() => reply200([{ ...ROOM, temperature: 30 }, OFF_ROOM])); return held.handler() }
          if (held) { after += 1; return reply200([{ ...ROOM, temperature: 20 }, OFF_ROOM]) }
          return reply200(rooms)
        },
      })
      await draftAndSend()
      configureWriteLock({ ttlMs: 30_000 })
      await confirmOk()
      await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
      holdFrom = Date.now() + 15_000 // 有效期最后 15 秒内开始的那次自动再核对卡住
      for (let i = 0; i < 26 && !held; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(held).toBeTruthy()
      // 读取卡住期间到期：放锁、强制重读，读到新数据
      for (let i = 0; i < 12 && document.querySelector('[data-lock]'); i++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(document.querySelector('[data-lock]')).toBeNull()
      await waitFor(() => expect(after).toBeGreaterThan(0))
      await waitFor(() => expect(roomTemp()).toBe('20.0°C'))
      await held!.release() // 旧核对这时才返回
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(roomTemp()).toBe('20.0°C')
    } finally { vi.useRealTimers() }
  })

  it('核对被写锁认可（不一致）且是最新读数：认可之后写进缓存，卡片显示核对读到的读数', async () => {
    fakeClock()
    let wrote = false
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => reply200(wrote ? [{ ...ROOM, temperature: 30 }, OFF_ROOM] : rooms),
    })
    await draftAndSend()
    await confirmOk()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(roomTemp()).toBe('30.0°C')
  })
})

describe('#35 第六轮：较旧的一致读数被更新的不一致读数取代', () => {
  it('核对 A 读到一致但返回晚、之后发起的 B 先返回不一致：不提示成功、不放锁、草稿保留；之后新读重核一致才放', async () => {
    fakeClock()
    let wrote = false
    let n = 0
    const a = deferred(() => reply200([{ ...ROOM, setTemp: 26 }, OFF_ROOM]))
    let later = [ROOM, OFF_ROOM]
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => (!wrote ? reply200(rooms) : ++n === 1 ? a.handler() : reply200(later)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(n).toBe(1)) // 写锁自动核对 A 已发出，卡住
    await act(async () => { await client.refetchQueries({ type: 'active' }) }) // B 之后发起、先返回：仍是 25.5（不一致）
    await flush()
    await a.release() // A 这时返回：读到 26（一致），但已被 B 取代
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((x) => x.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(toasts()).not.toContain('已生效')
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    expect(card('客厅').querySelector('[data-pending]')?.textContent).toContain('设定温度 25.5 → 26.0°C')
    // 之后按新读重核：设备确实生效了 → 一致、提示成功、放锁、清草稿
    later = [{ ...ROOM, setTemp: 26 }, OFF_ROOM]
    fireEvent.click(within(document.querySelector('[data-lock="unknown"]') as HTMLElement).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    await waitFor(() => expect(toasts()).toContain('客厅 已生效'))
    expect(card('客厅').querySelector('[data-pending]')).toBeNull()
  })
  it('核对在途期间暂停该项目的 15 秒轮询，核对结束恢复', async () => {
    let wrote = false
    let n = 0
    const a = deferred(() => reply200(rooms))
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => (!wrote ? reply200(rooms) : ++n === 1 ? a.handler() : reply200(rooms)),
    })
    // 温控房间查询的轮询间隔（看查询观察者当前的 refetchInterval；TanStack 的定时器不受假时钟控制，不靠等时间）
    const interval = () => client.getQueryCache().find({ queryKey: ['ctrl', 200, P1.id], exact: false })?.observers.map((o) => o.options.refetchInterval)
    await draftAndSend()
    expect(interval()).toContain(15_000)
    await confirmOk()
    await waitFor(() => expect(n).toBe(1))
    await waitFor(() => expect(interval()).not.toContain(15_000)) // 核对在途：暂停
    await a.release()
    await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
    await waitFor(() => expect(interval()).toContain(15_000)) // 核对结束：恢复
  })
  it('核对 A 读到一致时，之后发起的 B 还在途：A 同样不算已生效', async () => {
    fakeClock()
    let wrote = false
    let n = 0
    const a = deferred(() => reply200([{ ...ROOM, setTemp: 26 }, OFF_ROOM]))
    const b = deferred(() => reply200(rooms))
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => (!wrote ? reply200(rooms) : ++n === 1 ? a.handler() : n === 2 ? b.handler() : reply200(rooms)),
    })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(n).toBe(1))
    const bDone = act(async () => { await client.refetchQueries({ type: 'active' }) }) // B 发起，卡住
    await waitFor(() => expect(n).toBe(2))
    await a.release()
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((x) => x.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(toasts()).not.toContain('已生效')
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    await b.release()
    await bDone
  })
})

describe('#35 第七轮（Fable 裁定）：latest() 通过后、commit 前发起更新的读取', () => {
  it('commit 这一刻发现已被取代：否决放锁，不提示成功、锁保持；界面仍显示「正在核对」而不是「未变化」；之后新读一致才放', async () => {
    let wrote = false
    let n = 0
    const b = deferred(() => reply200(rooms))
    let later = [ROOM, OFF_ROOM]
    backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => (!wrote ? reply200(rooms) : ++n === 1 ? reply200([{ ...ROOM, setTemp: 26 }, OFF_ROOM]) : n === 2 ? b.handler() : reply200(later)),
    })
    // 核对读取结束（verifying 复位）的那次同步通知里发起 B：在核对函数的提前检查之后、写锁调 commit 之前
    let fired = false
    const off = subscribeLock(() => {
      const l = lockOfKey('screen:SCREEN-T')
      if (!fired && wrote && n === 1 && l && !l.verifying) { fired = true; void client.refetchQueries({ type: 'active' }) }
    })
    try {
      await draftAndSend()
      await confirmOk()
      await waitFor(() => expect(n).toBe(2))
      await waitFor(() => expect(lockOfKey('screen:SCREEN-T')).toMatchObject({ lastVerify: 'mismatch', lastVetoed: true }))
      await flush(50)
      expect(toasts()).not.toContain('已生效')
      await waitFor(() => expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy())
      expect(card('客厅').textContent).toContain('正在核对')
      expect(card('客厅').textContent).not.toContain('设备状态暂未变化')
      expect(document.querySelector('[data-lock="unknown"]')?.textContent).toContain('已下发，正在核对')
      expect(document.querySelector('[data-lock="unknown"]')?.textContent).not.toContain('设备状态暂未变化')
      expect(card('客厅').querySelector('[data-pending]')?.textContent).toContain('设定温度 25.5 → 26.0°C')
      await b.release()
      later = [{ ...ROOM, setTemp: 26 }, OFF_ROOM]
      await waitFor(() => expect(lockOfKey('screen:SCREEN-T')?.verifying).toBe(false))
      fireEvent.click(within(document.querySelector('[data-lock="unknown"]') as HTMLElement).getByRole('button', { name: '核对' }))
      await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
      await waitFor(() => expect(toasts()).toContain('客厅 已生效'))
    } finally { off() }
  })
})


describe('房间开关未上报（features.roomSwitchReported = false，后端 11/25 答复第 1 条）', () => {
  beforeEach(() => { setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', features: { roomSwitchReported: false } }) })

  it('开关显示「开关未知」，开 / 关各一个按钮；读到 0 的房间不置灰，温度、节能照常能改；KPI 已开启房间为 --', async () => {
    backend()
    await open()
    await screen.findByText('主卧', { selector: '.room-name' })
    const c = card('主卧') // 读到 switch = 0
    expect(c.textContent).toContain('开关未知')
    expect(c.textContent).not.toContain('已关闭')
    expect(c.className).not.toContain(' off')
    expect(within(c).queryByRole('switch', { name: '主卧 开关' })).toBeNull()
    expect(btn(c, '主卧 开启').disabled).toBe(false)
    expect(btn(c, '主卧 关闭').disabled).toBe(false)
    expect(btn(c, '主卧 设定温度升高').disabled).toBe(false)
    expect((within(c).getByRole('switch', { name: '主卧 节能模式' }) as HTMLButtonElement).disabled).toBe(false)
    expect(document.body.textContent).toContain('房间开关未上报')
  })

  it('读到 0 的房间改温度：照常下发 201（switch -1，末端空列表），确认框写明「设置温度不会开启房间」', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    await open()
    await screen.findByText('主卧', { selector: '.room-name' })
    fireEvent.click(btn(card('主卧'), '主卧 设定温度降低'))
    fireEvent.click(btn(card('主卧'), '下发'))
    const dlg = await dialog()
    expect(dlg.textContent).toContain('设置温度不会开启房间，房间开启后按此温度运行')
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({ equipmentId: 406658291, temperature: 25.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: [] })
  })

  it('点「开」：确认后发 201 switch = 1；回读读到 0 也不判「未变化」，记无法核对、锁保持', async () => {
    fakeClock()
    const be = backend({ '/ctrl/room-temperature-set': ok201NoApply })
    await open()
    await screen.findByText('主卧', { selector: '.room-name' })
    fireEvent.click(btn(card('主卧'), '主卧 开启'))
    const dlg = await dialog()
    expect(dlg.textContent).toContain('「主卧」下发「开启」')
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toMatchObject({ switch: 1, temperature: -1, eco: -1, endModes: [] })
    await flush(); await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await waitFor(() => expect(card('主卧').textContent).toContain('该项暂无回读，无法确认'))
    expect(card('主卧').textContent).toContain('设备暂不回报开关状态，2 分钟后可再次操作')
    expect(card('主卧').textContent).not.toContain('设备状态暂未变化')
    expect(toasts()).not.toContain('已生效')
  })
})

describe('首次回读不一致：正在核对（赤兔 11/25：退避都用完仍不一致才报结论）', () => {
  /** 记录过程中结果条与锁提示出现过的所有文案 */
  function recordTexts() {
    const seen: string[] = []
    const grab = () => { for (const el of document.querySelectorAll('.te-bar, [data-lock]')) { const t = el.textContent ?? ''; if (t && seen[seen.length - 1] !== t && !seen.includes(t)) seen.push(t) } }
    const mo = new MutationObserver(grab)
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    grab()
    return { all: () => { grab(); return seen.join('\n') }, stop: () => mo.disconnect() }
  }
  /** 写后第 n 次读 200（1 起算）返回什么 */
  function backendAfterWrite(nth: (n: number) => Response) {
    let wrote = false
    let n = 0
    const be = backend({
      '/ctrl/room-temperature-set': () => { wrote = true; return ok201NoApply() },
      '/ctrl/room-temperature-data-get': () => (wrote ? nth(++n) : reply200(rooms)),
    })
    return { be, reads: () => n }
  }
  const applied = () => reply200([{ ...ROOM, setTemp: 26 }, OFF_ROOM])
  const old = () => reply200([ROOM, OFF_ROOM])

  const verdictBar = () => within(card('客厅')).queryAllByRole('alert').map((a) => a.textContent).join()

  it('第一次回读旧值、第二次回读新值：整个过程只出现「正在核对」和「已生效」，中间不出现「未变化」', async () => {
    fakeClock()
    const { be, reads } = backendAfterWrite((n) => (n === 1 ? old() : applied()))
    await draftAndSend()
    const rec = recordTexts()
    await confirmOk()
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1))
    await flush()
    // 首次回读不一致：仍显示正在核对，锁保持
    expect(card('客厅').textContent).toContain('已下发，正在核对')
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy()
    await advance(RETRY_DELAYS_MS[0]) // 第一次退避（5 秒）读到新值
    await waitFor(() => expect(toasts()).toContain('客厅 已生效'))
    await waitFor(() => expect(document.querySelector('[data-lock]')).toBeNull())
    expect(reads()).toBeGreaterThanOrEqual(2)
    const all = rec.all()
    rec.stop()
    expect(all).toContain('正在核对')
    expect(all).not.toContain('未变化')
    expect(all).not.toContain('未生效')
    expect(all).not.toContain('结果未知')
    expect(toasts()).not.toContain('未变化')
    expect(writes(be)).toHaveLength(1)
  })

  it('三次退避都不一致：5 / 20 / 60 秒退避用完前一直是「正在核对」，用完才显示「指令已下发，设备状态暂未变化」，锁保持', async () => {
    fakeClock()
    const { reads } = backendAfterWrite(() => old())
    await draftAndSend()
    const rec = recordTexts()
    await confirmOk()
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1))
    await flush()
    for (const d of RETRY_DELAYS_MS.slice(0, -1)) {
      expect(card('客厅').textContent).toContain('已下发，正在核对')
      await advance(d)
      await flush()
    }
    expect(verdictBar()).not.toContain('暂未变化') // 第三次退避（60 秒）之前仍不报结论
    await advance(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
    await waitFor(() => expect(verdictBar()).toContain('指令已下发，设备状态暂未变化'))
    expect(reads()).toBeGreaterThanOrEqual(1 + RETRY_DELAYS_MS.length) // 首次自动核对 + 三次退避（期间还有页面轮询）
    const all = rec.all()
    rec.stop()
    const before = all.slice(0, all.indexOf('暂未变化'))
    expect(before).toContain('正在核对')
    expect(before).not.toContain('结果未知')
    expect(document.querySelector('[data-lock="unknown"]')!.textContent).toContain('指令已下发，设备状态暂未变化')
    expect(card('客厅').textContent).toContain('设定温度 25.5 → 26.0°C') // 草稿保留
  })

  it('读不到（回读失败）：同样等退避跑完才报「结果未知（回读失败）」', async () => {
    fakeClock()
    const { reads } = backendAfterWrite(() => json({ code: 14, message: 'x' }, 503))
    await draftAndSend()
    const rec = recordTexts()
    await confirmOk()
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1))
    await flush()
    expect(card('客厅').textContent).toContain('已下发，正在核对')
    expect(card('客厅').textContent).not.toContain('结果未知')
    await advance(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1])
    await flush()
    expect(card('客厅').textContent).not.toContain('结果未知')
    await runRetries()
    await waitFor(() => expect(verdictBar()).toContain('结果未知（回读失败）'))
    const all = rec.all()
    rec.stop()
    expect(all.slice(0, all.indexOf('结果未知'))).toContain('正在核对')
    expect(all).not.toContain('未变化')
  })

  it('有效期 30 秒、第三次退避（60 秒）排不进有效期：第二次退避仍不一致就显示「指令已下发，设备状态暂未变化」，锁保持到到期', async () => {
    fakeClock()
    const { reads } = backendAfterWrite(() => old())
    await draftAndSend()
    configureWriteLock({ ttlMs: 30_000 })
    await confirmOk()
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1))
    await flush()
    await advance(RETRY_DELAYS_MS[0])
    await flush()
    expect(card('客厅').textContent).toContain('已下发，正在核对')
    await advance(RETRY_DELAYS_MS[1])
    await waitFor(() => expect(verdictBar()).toContain('指令已下发，设备状态暂未变化'))
    expect(document.querySelector('[data-lock="unknown"]')).toBeTruthy() // 锁照旧保持到到期
  })

  it('首次回读已一致：直接「已生效」，不等退避', async () => {
    backendAfterWrite(() => applied())
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅 已生效')) // 真实时钟 1 秒内：没等 5 秒退避
    expect(document.querySelector('[data-lock]')).toBeNull()
  })

  it('锁提示：退避期间手动「核对」仍不一致，只说稍后自动再核对，不报未变化', async () => {
    fakeClock()
    const { reads } = backendAfterWrite(() => old())
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1))
    await flush()
    const bar = document.querySelector('[data-lock="unknown"]') as HTMLElement
    expect(bar.textContent).toContain('已下发，正在核对…')
    expect(bar.textContent).not.toContain('未变化')
    const n = reads()
    fireEvent.click(within(bar).getByRole('button', { name: '核对' }))
    await waitFor(() => expect(reads()).toBe(n + 1))
    await waitFor(() => expect(toasts()).toContain('暂未核对一致，稍后自动再核对'))
    expect(toasts()).not.toContain('未变化')
  })
})

describe('下发前控制屏实时预检（ctrl 205，赤兔 11/25）', () => {
  const offline205 = () => json({ code: 14, message: '控制屏消息发送失败' }, 503)
  const summary = (be: ReturnType<typeof backend>) => be.callsTo('/ctrl/device-summary-get')
  it('205 返回 503 → 0 个写请求、未下发、不占锁，结果条给「重试」；重试时现查 205（不复用），在线就照常下发', async () => {
    let down = true
    const be = backend({ '/ctrl/room-temperature-set': ok201, '/ctrl/device-summary-get': () => (down ? offline205() : json({ body: '' })) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅：控制屏未连接，暂不能下发'))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(summary(be)).toHaveLength(1)
    expect((summary(be)[0].body as { project_id: string }).project_id).toBe(P1.id)
    expect(lockOfKey(P1)).toBeNull()
    const c = card('客厅')
    expect(c.textContent).toContain('未下发：控制屏未连接，暂不能下发')
    expect(c.textContent).toContain('待下发') // 草稿保留
    down = false
    fireEvent.click(btn(c, '重试'))
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅 已生效：设定温度 26.0°C'))
    expect(summary(be)).toHaveLength(2)
    expect(writes(be)).toHaveLength(1)
  })
  it('205 两次都超过 5 秒没返回（S13 P2）→ 拦下：0 个写请求、不占锁、有重试，文案是「在线检查超时」', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201, '/ctrl/device-summary-get': () => new Promise<Response>(() => {}) })
    await draftAndSend()
    fakeClock()
    await confirmOk()
    await flush()
    expect(summary(be)).toHaveLength(1)
    await advance(5_100)
    expect(summary(be)).toHaveLength(2) // 第一次超时后重查
    await advance(4_700)
    expect(toasts()).not.toContain('超时')
    expect(lockOfKey(P1)).not.toBeNull() // 预检阶段占着，还没发
    await advance(300)
    await waitFor(() => expect(toasts()).toContain('客厅：控制屏在线检查超时，未下发，请重试'))
    expect(toasts()).not.toContain('控制屏未连接')
    expect(summary(be)).toHaveLength(2)
    expect(writes(be)).toHaveLength(0)
    expect(lockOfKey(P1)).toBeNull()
    expect(btn(card('客厅'), '重试')).toBeTruthy()
  })
  it('205 返回 500（其他失败，S13 P2）→ 不重查，拦下：0 个写请求，文案是「在线检查失败」，不带「未下发：」前缀', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201, '/ctrl/device-summary-get': () => json({ code: 13, message: '内部错误' }, 500) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅：控制屏在线检查失败，未下发，请重试'))
    expect(toasts()).not.toMatch(/未下发：|控制屏未连接|超时/)
    expect(summary(be)).toHaveLength(1)
    expect(writes(be)).toHaveLength(0)
    expect(lockOfKey(P1)).toBeNull()
  })
  it('205 每次都在 5 秒之后才返回成功 → 迟到的成功丢弃，两次都按超时拦下：0 个写请求、不占锁', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201, '/ctrl/device-summary-get': () => new Promise<Response>((r) => { setTimeout(() => r(json({ body: '' })), 5_500) }) })
    await draftAndSend()
    fakeClock()
    await confirmOk()
    await advance(11_000)
    await waitFor(() => expect(toasts()).toContain('客厅：控制屏在线检查超时，未下发，请重试'))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(lockOfKey(P1)).toBeNull()
  })
  it('205 第一次超时、重查在线（S13 P2）→ 放行，201 只发一次', async () => {
    let n = 0
    const be = backend({ '/ctrl/room-temperature-set': ok201, '/ctrl/device-summary-get': () => (++n === 1 ? new Promise<Response>(() => {}) : json({ body: '' })) })
    await draftAndSend()
    fakeClock()
    await confirmOk()
    await flush()
    await advance(5_100)
    vi.useRealTimers()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await flush(50)
    expect(writes(be)).toHaveLength(1)
    expect(summary(be)).toHaveLength(2)
  })
  it('房间开关、全部开关同样预检：205 503 → 不发 201 / 206，重试按原操作重新确认', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201, '/ctrl/project-room-switch-set': ok206, '/ctrl/device-summary-get': offline205 })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
    await confirmOk()
    await waitFor(() => expect(document.querySelector('[data-result=all]')?.textContent).toContain('未下发：控制屏未连接，暂不能下发'))
    expect(writes(be)).toHaveLength(0)
    expect(lockOfKey(P1)).toBeNull()
    fireEvent.click(within(document.querySelector('[data-result=all]') as HTMLElement).getByRole('button', { name: '重试' }))
    expect((await dialog()).textContent).toContain('开启')
  })
  it('205 返回 403（无连接状态权限）→ 0 个写请求、不占锁，单独文案（不说控制屏未连接），不给重试', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201, '/ctrl/device-summary-get': () => new Response('no permission', { status: 403, headers: { 'content-type': 'text/plain' } }) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅：当前账号无连接状态权限，无法确认控制屏在线，暂不能下发，请联系管理员'))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(lockOfKey(P1)).toBeNull()
    const c = card('客厅')
    expect(c.textContent).toContain('未下发：当前账号无连接状态权限，无法确认控制屏在线，暂不能下发，请联系管理员')
    expect(c.textContent).not.toContain('控制屏未连接')
    expect(within(c).queryByRole('button', { name: '重试' })).toBeNull()
  })
  it('写请求收到网关纯文本 504：结果说明补「控制屏 10 秒内没有应答，可能离线」，仍按结果未知', async () => {
    backend({ '/ctrl/room-temperature-set': () => new Response('upstream request timeout', { status: 504, headers: { 'content-type': 'text/plain' } }) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅 下发结果未知：未收到控制屏应答，下发结果未知；控制屏 10 秒内没有应答，可能离线'))
    expect(card('客厅').textContent).toContain('控制屏 10 秒内没有应答，可能离线')
  })
  it('带 gRPC 码的 JSON 504（code 4）不补这句', async () => {
    backend({ '/ctrl/room-temperature-set': () => json({ code: 4, message: 'deadline' }, 504) })
    await draftAndSend()
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅 下发结果未知'))
    expect(toasts()).not.toContain('可能离线')
  })
})

// ---------------------------------------------------------------------------
// 末端选择下发（201 end_modes）：点末端标签切换「选中」进草稿 → 确认 → 201（end_modes 完整回传，只改 is_selected，switch 原样，
// 其余标量 -1）→ 写锁按 is_selected 逐个核对（switch 不比）。全不选禁用下发；末端在外部变化时拦下；is_change = false 的末端不能改

/** 201 应答 success，并且设备按下发值生效：温度 / 节能 / 开关照 ok201，end_modes 非空时按位置改 is_selected（switch 保持读数） */
const ok201Ends = (c?: Call) => {
  if (c) {
    const q = body201(c) as { equipmentId: number; endModes: { isSelected: boolean }[] }
    if (q.endModes.length) {
      rooms = rooms.map((r) => {
        const x = r as typeof ROOM
        return x.id !== q.equipmentId ? r : { ...x, endModes: x.endModes.map((m, i) => ({ ...m, isSelected: q.endModes[i]?.isSelected ?? m.isSelected })) }
      })
    }
  }
  return ok201(c)
}
const endTag = (c: HTMLElement, name: string) => within(c).getByRole('button', { name: `客厅 末端 ${name}` }) as HTMLButtonElement

describe('末端选择下发（201 end_modes）', () => {
  it('从点标签开始：点「地冷」→ 草稿 → 下发 → 确认 → 201 解码：end_modes 完整回传、只改了 is_selected、switch 原值、其余标量 -1；先「正在核对」再「已生效」', async () => {
    let wrote = false
    const slowRead = deferred(() => reply200(rooms))
    const be = backend({
      '/ctrl/room-temperature-set': (c) => { wrote = true; return ok201Ends(c) },
      '/ctrl/room-temperature-data-get': () => (wrote ? slowRead.handler() : reply200(rooms)),
    })
    const c = await openRooms()
    expect(endTag(c, '地冷').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(endTag(c, '地冷'))
    expect(endTag(card('客厅'), '地冷').getAttribute('aria-pressed')).toBe('true')
    expect(endTag(card('客厅'), '地冷').className).toContain('dirty')
    expect(card('客厅').textContent).toContain('待下发：参与运行的末端 风盘、顶辐射 → 风盘、顶辐射、地冷')
    expect(writes(be)).toHaveLength(0)
    fireEvent.click(btn(card('客厅'), '下发'))
    const dlg = await dialog()
    expect(dlg.textContent).toContain('参与运行的末端 风盘、顶辐射 → 风盘、顶辐射、地冷')
    expect(dlg.textContent).not.toContain('设置温度不会开启房间')
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({
      equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: -1,
      endModes: [
        { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
        { optionName: '顶辐射', type: 1, isSelected: true, isChange: true, switch: 0 },
        { optionName: '地冷', type: 3, isSelected: true, isChange: true, switch: 0 },
      ],
    })
    await waitFor(() => expect(card('客厅').textContent).toContain('正在核对'))
    expect(toasts()).not.toContain('已生效')
    await slowRead.release()
    await waitFor(() => expect(toasts()).toContain('客厅 已生效：参与运行的末端 风盘、顶辐射、地冷'))
    await waitFor(() => expect(card('客厅').textContent).not.toContain('待下发'))
    expect(endTag(card('客厅'), '地冷').getAttribute('aria-pressed')).toBe('true')
    expect(writes(be)).toHaveLength(1)
  })

  it('末端和温度一起改：一条 201，温度是真实值、末端完整回传，其余 -1', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201Ends })
    const c = await openRooms()
    fireEvent.click(btn(c, '客厅 设定温度升高'))
    fireEvent.click(endTag(card('客厅'), '顶辐射'))
    fireEvent.click(btn(card('客厅'), '下发'))
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('客厅 已生效：设定温度 26.0°C，参与运行的末端 风盘'))
    expect(body201(writes(be)[0])).toMatchObject({ temperature: 26, eco: -1, switch: -1, humidity: -1, windSpeed: -1, endModes: [{ isSelected: true, switch: 1 }, { isSelected: false, switch: 0 }, { isSelected: false, switch: 0 }] })
  })

  it('末端全不选：提示「至少选择一个末端」，下发按钮禁用，不发 201', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201Ends })
    const c = await openRooms()
    fireEvent.click(endTag(c, '风盘'))
    fireEvent.click(endTag(card('客厅'), '顶辐射'))
    const k = card('客厅')
    expect(within(k).getByRole('alert').textContent).toBe('至少选择一个末端')
    const send = btn(k, '下发')
    expect(send.disabled).toBe(true)
    expect(send.getAttribute('title')).toBe('至少选择一个末端')
    fireEvent.click(send)
    await flush(50)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes(be)).toHaveLength(0)
    // 再点回一个：恢复可下发
    fireEvent.click(endTag(card('客厅'), '风盘'))
    expect(btn(card('客厅'), '下发').disabled).toBe(false)
  })

  it('确认期间末端在外部变化（个数变了）：确认返回后拦下，提示「末端已在外部变化」，不发 201', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201Ends })
    const c = await openRooms()
    fireEvent.click(endTag(c, '地冷'))
    fireEvent.click(btn(card('客厅'), '下发'))
    await dialog()
    await poll([{ ...ROOM, endModes: [ENDS[0], ENDS[1]] }, OFF_ROOM])
    await confirmOk()
    await flush(80)
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).toContain('末端已在外部变化')
  })

  it('确认后预检新读 200：末端顺序变了 / 名称变了 → 拦下「末端已在外部变化」，不发 201；只是末端 switch 变了照发（发新读到的 switch）', async () => {
    for (const next of [[ENDS[1], ENDS[0], ENDS[2]], [ENDS[0], ENDS[1], { ...ENDS[2], optionName: '地暖', type: 2 }]]) {
      cleanup(); toastLog = []; rooms = [ROOM, OFF_ROOM]; __resetWritesForTests(); __resetWriteLockForTests()
      let confirmed = false
      const be = backend({
        '/ctrl/room-temperature-set': ok201Ends,
        '/ctrl/room-temperature-data-get': () => reply200(confirmed ? [{ ...ROOM, endModes: next }, OFF_ROOM] : rooms),
      })
      const c = await openRooms()
      fireEvent.click(endTag(c, '地冷'))
      fireEvent.click(btn(card('客厅'), '下发'))
      const dlg = await dialog()
      confirmed = true
      fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
      await waitFor(() => expect(toasts()).toContain('客厅：末端已在外部变化，本次未下发'))
      expect(writes(be)).toHaveLength(0)
    }
    cleanup(); toastLog = []; rooms = [ROOM, OFF_ROOM]; __resetWritesForTests(); __resetWriteLockForTests()
    let confirmed = false
    const flipped = [{ ...ENDS[0], switch: 0 }, { ...ENDS[1], switch: 1 }, ENDS[2]]
    const be = backend({
      '/ctrl/room-temperature-set': (c) => ok201Ends(c),
      '/ctrl/room-temperature-data-get': () => reply200(confirmed && rooms[0] === ROOM ? [{ ...ROOM, endModes: flipped }, OFF_ROOM] : rooms),
    })
    const c = await openRooms()
    fireEvent.click(endTag(c, '地冷'))
    fireEvent.click(btn(card('客厅'), '下发'))
    const dlg = await dialog()
    confirmed = true
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect((body201(writes(be)[0]).endModes as { switch: number }[]).map((m) => m.switch)).toEqual([0, 1, 0])
  })

  it('下发成功但末端没变（回读 is_selected 不一致）：不提示已生效，退避用完显示「指令已下发，设备状态暂未变化」，草稿保留', async () => {
    fakeClock()
    const be = backend({ '/ctrl/room-temperature-set': ok201NoApply })
    const c = await openRooms()
    fireEvent.click(endTag(c, '地冷'))
    fireEvent.click(btn(card('客厅'), '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    await waitFor(() => expect(card('客厅').textContent).toContain('正在核对'))
    await flush(); await runRetries()
    await waitFor(() => expect(within(card('客厅')).getAllByRole('alert').map((a) => a.textContent).join()).toContain('指令已下发，设备状态暂未变化'))
    expect(toasts()).not.toContain('已生效')
    expect(card('客厅').textContent).toContain('风盘、顶辐射 → 风盘、顶辐射、地冷')
  })

  it('is_change = false 且未选中：同样显示小锁图标，提示「不允许修改」', async () => {
    rooms = [{ ...ROOM, endModes: [{ optionName: '全空气', type: 4, isSelected: false, isChange: false, switch: 0 }, ...ENDS] }, OFF_ROOM]
    backend()
    const c = await openRooms()
    const air = endTag(c, '全空气')
    expect(air.querySelector('.end-lock svg[data-icon=lock]')).not.toBeNull()
    expect(air.getAttribute('title')).toContain('不允许修改')
  })

  it('is_change = false（全空气）：已选中的标「不可取消」，点击无效并提示，不进草稿', async () => {
    rooms = [{ ...ROOM, endModes: [{ optionName: '全空气', type: 4, isSelected: true, isChange: false, switch: 1 }, ...ENDS] }, OFF_ROOM]
    const be = backend({ '/ctrl/room-temperature-set': ok201Ends })
    const c = await openRooms()
    const air = endTag(c, '全空气')
    expect(air.textContent).toContain('不可取消')
    expect(air.querySelector('.end-lock svg[data-icon=lock]')).not.toBeNull()
    expect(air.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(air)
    expect(toasts()).toContain('客厅：「全空气」不可取消')
    expect(endTag(card('客厅'), '全空气').getAttribute('aria-pressed')).toBe('true')
    expect(card('客厅').textContent).not.toContain('待下发')
    // 改别的末端照常，全空气原样带回
    fireEvent.click(endTag(card('客厅'), '地冷'))
    fireEvent.click(btn(card('客厅'), '下发'))
    await confirmOk()
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect((body201(writes(be)[0]).endModes as object[])[0]).toEqual({ optionName: '全空气', type: 4, isSelected: true, isChange: false, switch: 1 })
  })

  it('房间关着（开关读数可信且为关）：温度、节能不能改，但末端可以改、可以下发', async () => {
    rooms = [ROOM, { ...OFF_ROOM, endModes: ENDS }]
    const be = backend({ '/ctrl/room-temperature-set': ok201Ends })
    await open()
    await screen.findByText('主卧', { selector: '.room-name' })
    const c = card('主卧')
    expect(btn(c, '主卧 设定温度升高').disabled).toBe(true)
    fireEvent.click(within(c).getByRole('button', { name: '主卧 末端 地冷' }))
    expect(card('主卧').textContent).toContain('待下发：参与运行的末端')
    fireEvent.click(btn(card('主卧'), '下发'))
    await confirmOk()
    await waitFor(() => expect(toasts()).toContain('主卧 已生效'))
    expect(body201(writes(be)[0])).toMatchObject({ equipmentId: 406658291, temperature: -1, eco: -1, switch: -1 })
  })

  it('面板离线：末端标签不能点', async () => {
    rooms = [{ ...ROOM, isConnected: false }]
    backend()
    const c = await openRooms()
    expect(endTag(c, '地冷').disabled).toBe(true)
  })
})
