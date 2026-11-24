// @vitest-environment jsdom
// S9 温控面板页面用例（真实接口形状，只用假后端，绝不连真实后端）：
// 读取映射、温度步进边界、房间关闭禁止设置、201 / 206 请求体（不改的字段 -1、只发改了的字段）、
// 确认取消 / 离开后不下发、success 才提示成功、失败与结果未知的提示、写防护拦截时不发请求、app_code 12 与离线不读控制屏。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { toast as sonner } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import Layout from '../components/Layout'
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
const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001', name: '测试项目0829', app_code: '1', app_name: '通用版', online: true }
const P12 = { id: 'p12', code: '260911001', name: '独立空气系统测试', app_code: '12', app_name: '独立空气系统', online: true }
const POFF = { id: 'poff', code: '221031001', name: '科希家办公室', app_code: '1', app_name: '通用版' }
const GROUPS = [{ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: [P1.id, P12.id, POFF.id] }]

const ROOM = {
  id: 406658286, name: '客厅', temperature: 25.8, humidity: 51, dewPoint: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0, switch: 1, mode: 0, isConnected: true,
  endModes: [
    { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
    { optionName: '顶辐射', type: 1, isSelected: true, isChange: true, switch: 0 },
    { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 },
  ],
}
const OFF_ROOM = { ...ROOM, id: 406658291, name: '主卧', switch: 0, setTemp: 26, windSpeed: 100, humidity: 65536, endModes: [] }
const reply200 = (rooms: object[]) => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: rooms }) })
const ok201 = () => json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: true }) })
const ok206 = () => json({ body: encodeMessage(pb.ProjectRoomSwitchSetReplySchema, { success: true }) })

function backend(routes: Record<string, Handler> = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'admin-1', name: '测试' }, permission_paths: [] }),
    '/ctrl/projects': () => json({ project_entities: [P1, P12, POFF] }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    '/apps': () => json({}),
    '/ctrl/room-temperature-data-get': () => reply200([ROOM, OFF_ROOM]),
    '/ctrl/room-temperature-data-hour-get': () => json({ body: '' }),
    ...routes,
  })
}

/** 测试里用来模拟「离开页面」的按钮（在 Layout 外） */
function Away() {
  const nav = useNavigate()
  return createElement('button', { onClick: () => nav('/home') }, '去首页')
}
function mount() {
  const client = createQueryClient()
  return render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: ['/thermostat'] },
      createElement(Away),
      createElement(Routes, null,
        createElement(Route, { element: createElement(Layout) },
          createElement(Route, { path: '/thermostat', element: createElement(Thermostat) }),
          createElement(Route, { path: '/home', element: createElement('div', null, '首页内容') }),
        ))))))
}
// 轻提示：记录本用例里 showToast 转调 Sonner 的文案（Sonner 的列表跨用例保留，不能直接读 DOM）
let toastLog: string[] = []
const toasts = () => toastLog.join('\n')
const flush = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const writes = (be: ReturnType<typeof backend>) => be.calls.filter((c) => /-set$/.test(new URL(c.url, 'http://x').pathname))
const body201 = (c: Call) => decodeReply(pb.RoomTemperatureSetQuerySchema, (c.body as { body: string }).body)
const card = (name: string) => [...document.querySelectorAll('[data-room]')].find((c) => c.querySelector('.room-name')?.textContent === name) as HTMLElement
const dialog = () => screen.findByRole('alertdialog')

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

beforeEach(() => {
  toastLog = []
  for (const k of ['success', 'error'] as const) vi.spyOn(sonner, k).mockImplementation((m) => { toastLog.push(String(m)); return 0 })
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
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
    expect(off.querySelectorAll('.modes-row [data-slot=badge]')).toHaveLength(0) // 末端数量动态（这里为 0）
    // 读接口请求体：project_id 用实体 id
    const read = be.callsTo('/ctrl/room-temperature-data-get')[0]
    expect((read.body as { project_id: string }).project_id).toBe(P1.id)
  })

  it('风速 100 显示「自动」（开着的房间）', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => reply200([{ ...ROOM, windSpeed: 100 }]) })
    const c = await openRooms()
    expect(c.textContent).toContain('自动')
  })

  it('app_code 12 的项目：显示「该项目无房间温控面板」，不读 ctrl 200', async () => {
    const be = backend()
    await open(P12)
    await screen.findByText('该项目无房间温控面板')
    await flush(50)
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(0)
  })

  it('项目离线：显示空态，不读 ctrl 200（不显示旧数据）', async () => {
    const be = backend()
    await open(POFF)
    await screen.findByText('控制屏未连接')
    await flush(50)
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(0)
  })

  it('控制屏 503：显示「控制屏未连接」', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => json({ code: 14, message: '控制屏消息发送失败' }, 503) })
    await open()
    await screen.findByText('控制屏未连接')
  })
})

describe('修改设定温度与节能（ctrl 201）', () => {
  it('− / + 只改草稿（不发请求），改动项显示原值；下发 → 确认 → 只发一条 201：只有温度是真实值，其余 -1、end_modes 空列表；success 才提示成功并重读 200', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度降低' }))
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度降低' }))
    expect(within(c).getByLabelText('客厅 设定温度').textContent).toBe('24.5°C')
    expect(c.textContent).toContain('原 25.5')
    expect(c.textContent).toContain('待下发：设定温度 25.5 → 24.5°C')
    expect(writes(be)).toHaveLength(0)
    const reads = be.callsTo('/ctrl/room-temperature-data-get').length
    fireEvent.click(within(c).getByRole('button', { name: '下发' }))
    const dlg = await dialog()
    expect(dlg.textContent).toContain('测试项目0829')
    expect(dlg.textContent).toContain('客厅')
    expect(dlg.textContent).toContain('设定温度 25.5 → 24.5°C')
    expect(writes(be)).toHaveLength(0) // 确认前不下发
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(toasts()).toContain('客厅 已下发：设定温度 24.5°C'))
    const w = writes(be)
    expect(w).toHaveLength(1)
    expect(w[0].url).toBe('/api/ctrl/room-temperature-set')
    expect((w[0].body as { project_id: string }).project_id).toBe(P1.id)
    expect(body201(w[0])).toEqual({ equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: [] })
    await waitFor(() => expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(reads))
    expect(card('客厅').textContent).not.toContain('待下发')
  })

  it('只改节能：eco=1，温度等其余 -1', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 节能模式' }))
    expect(c.textContent).toContain('节能模式 标准 → 节能')
    fireEvent.click(within(c).getByRole('button', { name: '下发' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: 1, switch: -1, endModes: [] })
    await waitFor(() => expect(toasts()).toContain('节能模式 开'))
  })

  it('温度上限 30：+ 到 30 后禁用；下限 16：− 到 16 后禁用', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => reply200([{ ...ROOM, setTemp: 29.5 }, { ...ROOM, id: 9, name: '书房', setTemp: 16.5 }]) })
    const c = await openRooms()
    const up = within(c).getByRole('button', { name: '客厅 设定温度升高' })
    fireEvent.click(up)
    expect(within(c).getByLabelText('客厅 设定温度').textContent).toBe('30.0°C')
    expect((up as HTMLButtonElement).disabled).toBe(true)
    // 书房：先放弃客厅的草稿再改
    const s = card('书房')
    fireEvent.click(within(s).getByRole('button', { name: '书房 设定温度降低' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(within(card('书房')).getByLabelText('书房 设定温度').textContent).toBe('16.0°C'))
    expect((within(card('书房')).getByRole('button', { name: '书房 设定温度降低' }) as HTMLButtonElement).disabled).toBe(true)
    expect(card('客厅').textContent).not.toContain('待下发')
  })

  it('房间关闭：温度和节能控件禁用，没有任何写请求', async () => {
    const be = backend()
    await openRooms()
    const off = card('主卧')
    for (const name of ['主卧 设定温度降低', '主卧 设定温度升高']) expect((within(off).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(off).getByRole('switch', { name: '主卧 节能模式' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(off).getByRole('button', { name: '主卧 设定温度升高' }))
    expect(off.textContent).not.toContain('待下发')
    expect(writes(be)).toHaveLength(0)
  })

  it('确认弹窗点「取消」：不下发，草稿保留', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度升高' }))
    fireEvent.click(within(c).getByRole('button', { name: '下发' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '取消' }))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(card('客厅').textContent).toContain('待下发')
    expect(toasts()).not.toContain('已下发')
  })

  it('确认弹窗打开时离开页面：按取消结算，不下发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度升高' }))
    fireEvent.click(within(c).getByRole('button', { name: '下发' }))
    const dlg = await dialog()
    const okBtn = within(dlg).getByRole('button', { name: '确认下发' })
    // 弹窗打开时页面其余部分对读屏隐藏，直接按文字找这个按钮
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === '去首页')!)
    await screen.findByText('首页内容')
    fireEvent.click(okBtn) // 旧弹窗上迟到的「确认」也不算
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    expect(toasts()).not.toContain('已下发')
  })

  it('Reply success=false：提示后端 msg，卡片内红条，草稿回退为面板当前值，不提示成功', async () => {
    const be = backend({ '/ctrl/room-temperature-set': () => json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: false, msg: '该软件类型不支持此控制' }) }) })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度升高' }))
    fireEvent.click(within(c).getByRole('button', { name: '下发' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(toasts()).toContain('客厅 下发失败：该软件类型不支持此控制'))
    expect(toasts()).not.toContain('已下发')
    const after = card('客厅')
    expect(within(after).getByRole('alert').textContent).toContain('下发失败：该软件类型不支持此控制')
    expect(within(after).getByLabelText('客厅 设定温度').textContent).toBe('25.5°C')
    expect(after.textContent).not.toContain('待下发')
    expect(writes(be)).toHaveLength(1) // 不自动重试
  })

  it('控制屏未应答（504）：提示结果未知，不自动重试，保留草稿给「重试」，并重读 200 核对', async () => {
    const be = backend({ '/ctrl/room-temperature-set': () => json({ code: 4, message: 'deadline exceeded' }, 504) })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度升高' }))
    const reads = be.callsTo('/ctrl/room-temperature-data-get').length
    fireEvent.click(within(c).getByRole('button', { name: '下发' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(within(card('客厅')).getByRole('alert').textContent).toContain('结果未知'))
    await flush(50)
    expect(writes(be)).toHaveLength(1)
    expect(toasts()).not.toContain('已下发')
    await waitFor(() => expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(reads))
    // 重试要再确认一次
    fireEvent.click(within(card('客厅')).getByRole('button', { name: '重试' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '取消' }))
    await flush(50)
    expect(writes(be)).toHaveLength(1)
  })

  it('写防护拦截（项目 code 不在名单 / writeMode=off）：没有任何写请求，提示未下发', async () => {
    for (const cfg of [{ writeProjectCodes: ['260911001'] }, { writeMode: 'off' as const }]) {
      setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real', ...cfg })
      const be = backend({ '/ctrl/room-temperature-set': ok201 })
      const c = await openRooms()
      fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度升高' }))
      fireEvent.click(within(c).getByRole('button', { name: '下发' }))
      fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))
      await waitFor(() => expect(within(card('客厅')).getByRole('alert').textContent).toContain('未下发'))
      expect(writes(be)).toHaveLength(0)
      expect(toasts()).not.toContain('已下发')
      cleanup(); vi.unstubAllGlobals(); __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
    }
  })

  it('生产环境默认拦截：没有写请求', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'prod', dataSource: 'real' })
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度升高' }))
    fireEvent.click(within(c).getByRole('button', { name: '下发' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(within(card('客厅')).getByRole('alert').textContent).toContain('未下发'))
    expect(writes(be)).toHaveLength(0)
  })
})

describe('房间开关（201 switch）与全部开关（206）', () => {
  it('房间开关：确认后只发 switch，其余 -1；取消则不发', async () => {
    const be = backend({ '/ctrl/room-temperature-set': ok201 })
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('switch', { name: '客厅 开关' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '取消' }))
    await flush(50)
    expect(writes(be)).toHaveLength(0)
    fireEvent.click(within(card('客厅')).getByRole('switch', { name: '客厅 开关' }))
    const dlg = await dialog()
    expect(dlg.textContent).toContain('「客厅」下发「关闭」')
    fireEvent.click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    expect(body201(writes(be)[0])).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: 0, endModes: [] })
    await waitFor(() => expect(toasts()).toContain('客厅 已关闭'))
  })

  it('有未下发草稿时房间开关禁用', async () => {
    backend()
    const c = await openRooms()
    fireEvent.click(within(c).getByRole('button', { name: '客厅 设定温度升高' }))
    expect((within(card('客厅')).getByRole('switch', { name: '客厅 开关' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('全部开启：确认后发 206 switch=1，project_id 为实体 id', async () => {
    const be = backend({ '/ctrl/project-room-switch-set': ok206 })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部开启' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(writes(be)).toHaveLength(1))
    const w = writes(be)[0]
    expect(w.url).toBe('/api/ctrl/project-room-switch-set')
    expect((w.body as { project_id: string }).project_id).toBe(P1.id)
    expect(decodeReply(pb.ProjectRoomSwitchSetQuerySchema, (w.body as { body: string }).body)).toEqual({ switch: 1 })
    await waitFor(() => expect(toasts()).toContain('已下发：全部开启（2 个房间）'))
  })

  it('全部关闭失败（success=false）：提示失败，不提示成功', async () => {
    backend({ '/ctrl/project-room-switch-set': () => json({ body: encodeMessage(pb.ProjectRoomSwitchSetReplySchema, { success: false, msg: '控制屏拒绝' }) }) })
    await openRooms()
    fireEvent.click(screen.getByRole('button', { name: '全部关闭' }))
    fireEvent.click(within(await dialog()).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(toasts()).toContain('全部关闭下发失败：控制屏拒绝'))
    expect(toasts()).not.toContain('已下发')
  })
})
