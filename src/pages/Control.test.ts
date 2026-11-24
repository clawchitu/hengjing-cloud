// @vitest-environment jsdom
// 统一控制页面（S12b）：真实数据形状 + 假后端。覆盖 app_code 8/12 禁用温度、「保持不变」时温度区真正禁用（键盘也改不了）、
// 离线不能下发、温度范围与步长、二次确认 → 成功 / 失败 / 结果未确认、失败不重试、下发前后各读一次。
// 只用假后端（fetch 被替换），不连任何真实服务，不调真实写接口。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json, text, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetMockUnifiedForTests, mockUnifiedRead, mockUnifiedSend } from '../api'
import Control from './Control'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const PROJECTS = [
  { id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', online: true },
  { id: 'p3', code: '221031001', name: '科希家办公室', app_code: '1' }, // 离线（online 缺失）
  { id: 'p2', code: '260911001', name: '独立空气系统测试', app_code: '12', online: true },
  { id: 'p4', code: '230101001', name: '空气单机测试', app_code: '8', online: true },
]
const GROUPS = [
  { id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p1', 'p3'] },
  { id: 'g2', code: '3', name: '独立空气系统', distributor_id: 'D1', project_ids: ['p2'] },
  { id: 'g3', code: '4', name: '空气单机', distributor_id: 'D1', project_ids: ['p4'] },
]
const rooms = (sw: number, t: number) => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: [{ id: 1, name: '客厅', switch: sw, setTemp: t }, { id: 2, name: '主卧', switch: sw, setTemp: t }] }) })
const reply = (success: boolean, msg = '') => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success, msg }) })

type Handler = (c: Call, n: number) => Response | Promise<Response>
function backend(routes: Record<string, Handler> = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'dealer-1', name: '测试', type: 1 } }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    ...routes,
  })
}
async function mount() {
  await signIn('d', 'pw', true)
  const client = createQueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null, createElement(MemoryRouter, null, createElement(Control)))))
  await screen.findByText('测试项目0829')
}
const slider = () => screen.getByRole('slider', { name: '房间温度设定' })
const shown = () => screen.getByTestId('temp-box').querySelector('.tv b')!.textContent
const keep = () => screen.getByRole('checkbox', { name: '保持不变' })
const press = async (key: string, extra: Record<string, unknown> = {}) => { await act(async () => { fireEvent.keyDown(slider(), { key, ...extra }) }) }
const click = async (el: Element) => { await act(async () => { fireEvent.click(el) }) }
async function pickGroup(name: string) {
  const sel = screen.getByRole('combobox', { name: '集成项目' })
  await act(async () => { fireEvent.keyDown(sel, { key: 'Enter' }) })
  await click(within(await screen.findByRole('listbox')).getByRole('option', { name }))
}
/** 温度区所有控件都被 disabled 属性禁用，键盘的每种按键都改不了值 */
async function expectTempLocked() {
  expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(true)
  expect(slider().hasAttribute('data-disabled')).toBe(true)
  expect(slider().hasAttribute('tabindex')).toBe(false) // 不能 Tab 进去
  expect(screen.getByRole('button', { name: '降低温度' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '升高温度' }).hasAttribute('disabled')).toBe(true)
  const before = slider().getAttribute('aria-valuenow')
  for (const k of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'End', 'Home', 'PageUp', 'PageDown']) await press(k)
  await press('ArrowRight', { shiftKey: true })
  expect(slider().getAttribute('aria-valuenow')).toBe(before)
  expect(shown()).toBe('26.0°C')
  // 点 ± 也没用（禁用的按钮不派发点击）
  await click(screen.getByRole('button', { name: '升高温度' }))
  expect(shown()).toBe('26.0°C')
}

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test' })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null) })

describe('温度区', () => {
  it('默认「保持不变」：温度区真正禁用，键盘和 ± 都改不了', async () => {
    backend()
    await mount()
    expect(keep().getAttribute('aria-checked')).toBe('true')
    await expectTempLocked()
  })

  it('取消「保持不变」后可调：范围 16–30、步长 0.5（键盘与 ± 都按步长、到边界停住）', async () => {
    backend()
    await mount()
    await click(keep())
    expect(slider().getAttribute('aria-valuemin')).toBe('16')
    expect(slider().getAttribute('aria-valuemax')).toBe('30')
    await press('ArrowRight'); expect(shown()).toBe('26.5°C')
    await press('End'); expect(shown()).toBe('30.0°C')
    await press('ArrowRight'); expect(shown()).toBe('30.0°C')
    expect(screen.getByRole('button', { name: '升高温度' }).hasAttribute('disabled')).toBe(true)
    await press('Home'); expect(shown()).toBe('16.0°C')
    await press('ArrowLeft'); expect(shown()).toBe('16.0°C')
    await click(screen.getByRole('button', { name: '升高温度' })); expect(shown()).toBe('16.5°C')
    // 再勾回「保持不变」又禁用
    await click(keep())
    expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(true)
    await press('ArrowRight'); expect(shown()).toBe('16.5°C')
  })

  it('选「全部关闭」房间时温度设定不可用', async () => {
    backend()
    await mount()
    await click(keep())
    await click(screen.getByRole('button', { name: '全部关闭' }))
    expect(screen.getByText('关闭房间时不能同时设定温度')).toBeTruthy()
    expect(keep().hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(true)
  })

  it.each([['独立空气系统', '12'], ['空气单机', '8']])('app_code（%s，%s）：温度设定禁用，键盘也改不了；房间开关仍可用', async (group) => {
    backend()
    await mount()
    await click(keep()) // 先在通用版里打开，再切组：组的 app_code 决定
    await pickGroup(group)
    expect(screen.getByText(/该应用类型不支持温度设定/)).toBeTruthy()
    expect(keep().hasAttribute('disabled')).toBe(true)
    await expectTempLocked()
    expect(screen.getByRole('button', { name: '全部开启' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('离线', () => {
  it('离线项目不能选，也不在「全选在线项目」里', async () => {
    backend()
    await mount()
    const off = screen.getByRole('checkbox', { name: '科希家办公室' })
    expect(off.hasAttribute('disabled')).toBe(true)
    await click(screen.getByText('科希家办公室'))
    expect(off.getAttribute('aria-checked')).toBe('false')
    await click(screen.getByRole('checkbox', { name: '全选在线项目' }))
    expect(screen.getByRole('checkbox', { name: '测试项目0829' }).getAttribute('aria-checked')).toBe('true')
    expect(off.getAttribute('aria-checked')).toBe('false')
  })
})

describe('下发', () => {
  async function prepare() {
    await mount()
    await click(screen.getByText('测试项目0829'))
    await click(screen.getByRole('button', { name: '全部开启' }))
    await click(keep())
    await click(screen.getByRole('button', { name: '升高温度' }))
    await click(screen.getByRole('button', { name: '确认下发' }))
    return screen.findByRole('alertdialog')
  }
  const okIn = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: '确认下发' })

  it('二次确认 → 下发前读 → 203 → 下发后读 → 成功；弹窗写明项目和值；结果只有 项目 / 项目ID / 状态 / 操作时间', async () => {
    const be = backend({
      '/ctrl/room-temperature-data-get': (_c, n) => (n === 1 ? rooms(0, 26) : rooms(1, 26.5)),
      '/ctrl/unified-ctrl-set': () => reply(true),
    })
    const dlg = await prepare()
    expect(dlg.textContent).toContain('测试项目0829（240829001）')
    expect(dlg.textContent).toContain('房间开关开启')
    expect(dlg.textContent).toContain('房间温度26.5°C')
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0) // 确认前不发
    await click(okIn(dlg))
    const badge = await screen.findByText('成功', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(2)
    const w = be.callsTo('/ctrl/unified-ctrl-set')
    expect(w).toHaveLength(1)
    const body = w[0].body as { project_id: string; body: string }
    expect(body.project_id).toBe('p1')
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: 26.5 })
    const row = badge.closest('tr')!
    expect(row.textContent).toContain('回读：下发前 房间关 · 26.0°C，下发后 房间开 · 26.5°C')
    const heads = within(badge.closest('table')!).getAllByRole('columnheader').map((h) => h.textContent)
    expect(heads).toEqual(['项目', '项目ID', '状态', '操作时间'])
  })

  it('控制屏拒绝 → 失败，提示未自动重试，只发了一次', async () => {
    const be = backend({
      '/ctrl/room-temperature-data-get': () => rooms(0, 26),
      '/ctrl/unified-ctrl-set': () => reply(false, '设备忙'),
    })
    await click(okIn(await prepare()))
    const badge = await screen.findByText('失败', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(badge.closest('tr')!.textContent).toContain('未自动重试')
    await new Promise((r) => setTimeout(r, 300))
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
    expect(await screen.findByText(/失败 1 个/)).toBeTruthy()
  })

  it('500 且回读不一致 → 结果未确认，提示刷新查看，不重试', async () => {
    const be = backend({
      '/ctrl/room-temperature-data-get': () => rooms(0, 26),
      '/ctrl/unified-ctrl-set': () => text('oops', 500),
    })
    await click(okIn(await prepare()))
    const badge = await screen.findByText('结果未确认', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(badge.closest('tr')!.textContent).toContain('结果未确认，请刷新查看')
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
  })

  it('确认弹窗取消：不读不写', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    const dlg = await prepare()
    await click(within(dlg).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(0)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })

  it('没有改动：不弹确认，提示「没有要下发的设置」', async () => {
    const be = backend()
    await mount()
    await click(screen.getByText('测试项目0829'))
    await click(screen.getByRole('button', { name: '确认下发' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(await screen.findByText('没有要下发的设置')).toBeTruthy()
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })
})

describe('演示数据模式的回读与下发', () => {
  it('只改内存里的演示状态：下发后回读到新值；新风单机版没有房间', async () => {
    __resetMockUnifiedForTests()
    expect(await mockUnifiedRead('PRJ-10241')).toMatchObject({ roomSwitch: 1, roomTemp: 26 })
    expect(await mockUnifiedSend({ id: 'PRJ-10241' }, { roomSwitch: 0, roomTemp: -1 })).toEqual({ success: true, msg: '' })
    expect(await mockUnifiedRead('PRJ-10241')).toMatchObject({ roomSwitch: 0, roomTemp: 26 })
    expect(await mockUnifiedRead('PRJ-10252')).toEqual({ rooms: 0, roomSwitch: null, roomTemp: null })
  })
})
