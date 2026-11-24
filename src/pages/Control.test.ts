// @vitest-environment jsdom
// 统一控制页面（S12b）：真实数据形状 + 假后端。覆盖 app_code 8/12 禁用温度、「保持不变」时温度区真正禁用（键盘也改不了）、
// 离线不能下发、温度范围与步长、二次确认 → 成功 / 失败 / 结果未确认、失败不重试、下发前后各读一次。
// 只用假后端（fetch 被替换），不连任何真实服务，不调真实写接口。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens, writeTokens } from '../api/tokens'
import { fakeBackend, json, text, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetMockUnifiedForTests, mockUnifiedRead, mockUnifiedSend } from '../api'
import Control, { lastResultKey } from './Control'
import { setCurrentUserId } from '../api/auth'
import { __resetWriteLockForTests, OTHER_ACCOUNT_TEXT, STORAGE_PREFIX } from '../api/writeLock'
import { TEXT } from '../features/unified/constants'

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

/** 带 sub 的 JWT 形状令牌（写请求要求能解析出 sub） */
const J = (sub: string, n = 1) => `h.${btoa(JSON.stringify({ sub, n }))}.s`
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
const rooms = (sw: number, t: number) => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: [{ id: 1, name: '客厅', switch: sw, setTemp: t, isConnected: true }, { id: 2, name: '主卧', switch: sw, setTemp: t, isConnected: true }] }) })
const reply = (success: boolean, msg = '') => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success, msg }) })

type Handler = (c: Call, n: number) => Response | Promise<Response>
function backend(routes: Record<string, Handler> = {}) {
  return fakeBackend({
    '/auth/login': () => json({ access_token: J('dealer-1'), refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'dealer-1', name: '测试', type: 1 } }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    '/integrated-projects': () => json({ entities: GROUPS }),
    '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main' }] }),
    ...routes,
  })
}
let navigate: NavigateFunction
function Nav() { navigate = useNavigate(); return null }
async function mount(signin = true) {
  if (signin) await signIn('d', 'pw', true)
  const client = createQueryClient()
  const routes = createElement(Routes, null,
    createElement(Route, { path: '/control', element: createElement(Control) }),
    createElement(Route, { path: '/other', element: createElement('div', null, '别的页面') }))
  const r = render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: ['/control'] }, createElement(Nav), routes))))
  await screen.findByText('测试项目0829')
  return r
}
/** 点开「下发核对」（默认收起），返回里面的文字 */
async function openNotes() {
  const t = screen.getByRole('button', { name: /下发核对/ })
  if (t.getAttribute('aria-expanded') !== 'true') await click(t)
  return document.querySelector('.unified-notes')?.textContent ?? ''
}
/** 结果表每行只有 项目、项目ID、状态、操作时间 四格，状态格只有徽标 */
function expectFourCells(badge: HTMLElement) {
  const cells = within(badge.closest('tr')!).getAllByRole('cell')
  expect(cells).toHaveLength(4)
  expect(cells[2].textContent).toBe(badge.textContent)
}
const tick = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
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
  __resetWriteLockForTests()
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
  /** 200：203 发出之前返回 before，之后返回 after（选项目时的房间状态读取也走 200） */
  function room200(be: () => { callsTo: (p: string) => Call[] }, before: [number, number], after: [number, number] = before) {
    return () => (be().callsTo('/ctrl/unified-ctrl-set').length ? rooms(...after) : rooms(...before))
  }
  const reads = (be: { callsTo: (p: string) => Call[] }) => be.callsTo('/ctrl/room-temperature-data-get').length

  it('二次确认 → 下发前读 → 203 → 下发后读 → 成功；结果卡片只有四项，原因与回读在默认收起的「下发核对」里', async () => {
    let be!: ReturnType<typeof backend>
    let readsAtSend = -1
    be = backend({ '/ctrl/room-temperature-data-get': room200(() => be, [0, 26], [1, 26.5]), '/ctrl/unified-ctrl-set': () => { readsAtSend = reads(be); return reply(true) } })
    const dlg = await prepare()
    expect(dlg.textContent).toContain('测试项目0829（240829001）')
    expect(dlg.textContent).toContain('房间开关开启')
    expect(dlg.textContent).toContain('房间温度26.5°C')
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0) // 确认前不发
    const r0 = reads(be)
    await click(okIn(dlg))
    const badge = await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    // 下发前读一次（203 发出时已读 1 次）、下发后读一次；之后页面再刷新一次房间状态
    expect(readsAtSend - r0).toBe(1)
    expect(reads(be) - r0).toBe(3)
    const w = be.callsTo('/ctrl/unified-ctrl-set')
    expect(w).toHaveLength(1)
    const body = w[0].body as { project_id: string; body: string }
    expect(body.project_id).toBe('p1')
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: 26.5 })
    expectFourCells(badge)
    const card = screen.getByRole('region', { name: '最近一次执行结果' })
    // 卡片里只有标题和四列表格：没有任何说明、没有计数汇总
    expect(card.textContent).not.toMatch(/回读|未自动重试|核对/)
    expect(card.textContent).toBe('最近一次执行结果' + within(card).getByRole('table').textContent)
    const heads = within(card).getAllByRole('columnheader').map((h) => h.textContent)
    expect(heads).toEqual(['项目', '项目ID', '状态', '操作时间'])
    // 「下发核对」默认收起
    const toggle = screen.getByRole('button', { name: /下发核对/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.unified-notes')).toBeNull()
    expect(await openNotes()).toContain('回读：下发前 房间关 · 26.0°C，下发后 房间开 · 26.5°C')
  })

  it('控制屏拒绝 → 失败，提示未自动重试，只发了一次', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(false, '设备忙') })
    await click(okIn(await prepare()))
    const badge = await screen.findByText('失败', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expectFourCells(badge)
    const n = await openNotes()
    expect(n).toContain('设备忙')
    expect(n).toContain('未自动重试')
    await tick(300)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
    expect(await screen.findByText(/失败 1 个/)).toBeTruthy()
  })

  it.each([
    ['401', () => json({ code: 16, message: 'token expired' }, 401)],
    ['token err', () => text('token err', 403)],
  ])('写接口 %s → 不重放：失败（未执行），提示「登录状态已更新，请重新下发」，203 只发一次', async (_n, h) => {
    const be = backend({
      '/ctrl/room-temperature-data-get': () => rooms(0, 26),
      '/ctrl/unified-ctrl-set': h,
      '/auth/refresh': () => json({ access_token: J('dealer-1', 2), refresh_token: 'R2', expires_in: 7200 }),
    })
    await click(okIn(await prepare()))
    await screen.findByText('失败（未执行）', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    await tick(300)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
    expect(await openNotes()).toContain('登录状态已更新，请重新下发')
  })

  it('真实数据源：页面打开时在线，确认后刷新的项目列表里已离线 → 不下发（203 为 0），显示未下发', async () => {
    let n = 0
    const be = backend({
      '/ctrl/projects': () => json({ project_entities: n++ === 0 ? PROJECTS : PROJECTS.map((p) => (p.id === 'p1' ? { ...p, online: undefined } : p)) }),
      '/ctrl/room-temperature-data-get': () => rooms(1, 26),
      '/ctrl/unified-ctrl-set': () => reply(true),
    })
    const dlg = await prepare()
    const before = be.callsTo('/ctrl/projects').length
    await click(okIn(dlg))
    await screen.findByText('未下发', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(be.callsTo('/ctrl/projects').length - before).toBe(1) // 每批强制刷新一次
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
    expect(await openNotes()).toContain('项目离线，不能下发')
  })

  it('控制屏未连接（503 code 14）→ 失败（未执行），提示「控制屏未连接，未下发」，不重试', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26), '/ctrl/unified-ctrl-set': () => json({ code: 14, message: 'no stream' }, 503) })
    await click(okIn(await prepare()))
    await screen.findByText('失败（未执行）', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
    expect(await openNotes()).toContain('控制屏未连接，未下发')
  })

  it('下发还没返回时：结果卡片仍是上一次的内容、没有说明；进度在卡片外；按钮「下发中…」禁用', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': room200(() => be, [1, 26], [1, 26.5]), '/ctrl/unified-ctrl-set': async () => { await gate; return reply(true) } })
    const dlg = await prepare()
    const card = () => document.querySelector<HTMLElement>('[aria-label="最近一次执行结果"]')!
    const cardBefore = card().textContent
    expect(cardBefore).toBe('最近一次执行结果暂无执行记录')
    await click(okIn(dlg))
    await waitFor(() => expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1))
    expect(card().textContent).toBe(cardBefore)
    const progress = screen.getByRole('status')
    expect(progress.textContent).toContain('正在下发')
    expect(card().contains(progress)).toBe(false)
    const btn = screen.getByRole('button', { name: '下发中…' })
    expect(btn.hasAttribute('disabled')).toBe(true)
    release()
    await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('账号绑定（页面接线）：确认后刷新项目列表期间换了账号 → 203 为 0 次，未下发', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    const be = backend({
      '/ctrl/projects': async () => { if (n++ > 0) await gate; return json({ project_entities: PROJECTS }) },
      '/ctrl/room-temperature-data-get': () => rooms(1, 26),
      '/ctrl/unified-ctrl-set': () => reply(true),
    })
    const dlg = await prepare()
    await click(okIn(dlg))
    await waitFor(() => expect(n).toBe(2)) // 确认后的强制刷新挂起
    // 另一个标签页换了账号：存储里的令牌换成别的 sub
    writeTokens({ accessToken: J('someone-else'), refreshToken: 'R9', expiresAt: Date.now() + 3600_000 })
    release()
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 3000 })
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
    // 结果记在发起时的账号下（换账号后的页面看不到，符合按账号隔离）
    await waitFor(() => expect(sessionStorage.getItem('hjc-unified-last:real:dealer-1') ?? '').toMatch(/"status":"(not-sent|failure)"/), { timeout: 3000 })
  })

  it('确认时令牌解析不出 sub：整批不下发、不回读，失败（未执行），提示「登录状态异常，请重新登录后下发」', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    const dlg = await prepare()
    const r0 = be.callsTo('/ctrl/room-temperature-data-get').length
    writeTokens({ accessToken: 'not-a-jwt', refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    await click(okIn(dlg))
    await screen.findByText('失败（未执行）', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
    expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBe(r0)
    expect(await openNotes()).toContain('登录状态异常，请重新登录后下发')
  })

  it('已有上一次结果时：下发进行中卡片仍显示上一次的四列结果、没有说明', async () => {
    let gateNext = false
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    // 第一轮升到 26.5、第二轮降回 26：每轮下发后回读都一致
    let be!: ReturnType<typeof backend>
    be = backend({
      '/ctrl/room-temperature-data-get': () => { const n = be.callsTo('/ctrl/unified-ctrl-set').length; return rooms(1, n === 1 ? 26.5 : 26) },
      '/ctrl/unified-ctrl-set': async () => { if (gateNext) await gate; return reply(true) },
    })
    await click(okIn(await prepare()))
    await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    const card = () => document.querySelector<HTMLElement>('[aria-label="最近一次执行结果"]')!
    const prev = card().textContent
    expect(prev).toContain('测试项目0829')
    gateNext = true
    await click(screen.getByRole('button', { name: '降低温度' }))
    await click(screen.getByRole('button', { name: '确认下发' }))
    await click(okIn(await screen.findByRole('alertdialog')))
    await waitFor(() => expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(2))
    expect(card().textContent).toBe(prev)
    expect(card().textContent).not.toMatch(/正在下发|回读|核对/)
    expect(screen.getByRole('button', { name: '下发中…' }).hasAttribute('disabled')).toBe(true)
    release()
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 3000 })
  })

  // 下发结果口径（Fable 11/24 裁定）：success=true 只算「已下发」，以回读为准
  it('203 success=true 但回读房间开关仍是关 → 未变化（不报成功），说明里给出不一致字段', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    const badge = await screen.findByText('未变化', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expectFourCells(badge)
    expect(screen.queryByText('已生效', { selector: '[data-slot=badge]' })).toBeNull()
    const notes = await openNotes()
    expect(notes).toContain(TEXT.unapplied)
    expect(notes).toContain('房间开关下发 开启，回读 关闭')
    expect(notes).not.toContain(TEXT.success)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
  })

  it('部分字段一致：房间开关已开、温度没变 → 未变化，只列温度', async () => {
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': room200(() => be, [0, 26], [1, 26]), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await screen.findByText('未变化', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    const notes = await openNotes()
    expect(notes).toContain('房间温度下发 26.5°C，回读 26°C')
    expect(notes).not.toContain('房间开关下发')
  })

  it('200 里房间没有 switch 字段（0 值不编码）→ 按「关」核对：下发开启 → 未变化（测试服 240829001 那次）', async () => {
    const noSwitch = () => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: [{ id: 1, name: '房间11', setTemp: 26, isConnected: true }, { id: 2, name: '房间13', setTemp: 26, isConnected: true }] }) })
    backend({ '/ctrl/room-temperature-data-get': noSwitch, '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await screen.findByText('未变化', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(await openNotes()).toContain('房间开关下发 开启，回读 关闭')
  })

  it('下发后 200 回包为空（{}，没有房间条目）→ 无法核对', async () => {
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': () => (be.callsTo('/ctrl/unified-ctrl-set').length ? json({ body: '' }) : rooms(0, 26)), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await screen.findByText('无法核对', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    const notes = await openNotes()
    expect(notes).toContain(TEXT.unverifiable)
    expect(notes).toContain('下发后 无房间')
  })

  it('下发后回读时房间离线（is_connected=false）、旧值碰巧一致 → 结果未知，不报已生效', async () => {
    const off = () => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: [{ id: 1, name: '客厅', switch: 1, setTemp: 26.5, isConnected: false }, { id: 2, name: '主卧', switch: 1, setTemp: 26.5, isConnected: true }] }) })
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': () => (be.callsTo('/ctrl/unified-ctrl-set').length ? off() : rooms(0, 26)), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(await openNotes()).toContain(TEXT.roomsOffline)
  })

  it('500 且回读不一致 → 结果未知，提示刷新查看，不重试', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => text('oops', 500) })
    await click(okIn(await prepare()))
    const badge = await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expectFourCells(badge)
    expect(await openNotes()).toContain('结果未确认，请刷新查看')
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
  })

  it('结果在本标签页保留：卸载后重新进入页面仍显示（同一账号、同一数据源）', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26.5), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(sessionStorage.getItem('hjc-unified-last:real:dealer-1')).toContain('240829001')
    cleanup()
    await mount(false)
    expect(await screen.findByText('已生效', { selector: '[data-slot=badge]' })).toBeTruthy()
  })

  it('确认弹窗打开时页面卸载：确认失效，不再读、不写', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    await prepare()
    const r0 = reads(be)
    cleanup()
    await tick(300)
    expect(reads(be)).toBe(r0)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })

  it('确认弹窗打开时路由变化：弹窗失效，点确认也不下发', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    const dlg = await prepare()
    const r0 = reads(be)
    const ok = okIn(dlg)
    await act(async () => { navigate('/other') })
    await act(async () => { fireEvent.click(ok) })
    await tick(300)
    expect(screen.getByText('别的页面')).toBeTruthy()
    expect(reads(be)).toBe(r0)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })

  it('下发前读取期间页面卸载：不再发出 203', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let confirmed = false
    const be = backend({ '/ctrl/room-temperature-data-get': async () => { if (confirmed) await gate; return rooms(0, 26) }, '/ctrl/unified-ctrl-set': () => reply(true) })
    const dlg = await prepare()
    const r0 = reads(be)
    confirmed = true
    await click(okIn(dlg))
    await waitFor(() => expect(reads(be)).toBe(r0 + 1))
    cleanup()
    release()
    await tick(300)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })

  it('确认弹窗取消：不读不写', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    const dlg = await prepare()
    const r0 = reads(be)
    await click(within(dlg).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await tick(100)
    expect(reads(be)).toBe(r0)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })

  it('没有改动：不弹确认，提示「没有要下发的设置」', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26) })
    await mount()
    await click(screen.getByText('测试项目0829'))
    await click(screen.getByRole('button', { name: '确认下发' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(await screen.findByText('没有要下发的设置')).toBeTruthy()
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })
})

describe('写锁（页面）', () => {
  /** 别的标签页 / 上一次留下的 203 记录（p1 没有屏号，主锁键为 project:p1），用 storage 事件同步进本标签 */
  const lockRec = (userId: string) => ({ v: 1, op: 'x1', keys: ['project:p1'], projectId: 'p1', userId, sentAt: Date.now() - 1000, msg: 203, deviceId: null, target: { systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 } })
  const syncLock = (v: object | null) => act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + 'project:p1', newValue: v ? JSON.stringify(v) : null }))
  })
  const sendBtn = () => screen.getAllByRole('button', { name: '确认下发' }).find((b) => b.classList.contains('btn-send'))!

  it('同屏被占（同一账号）：提示「上一条下发还在处理中」，下发按钮置灰，不发 203', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26) })
    await mount()
    await click(screen.getByText('测试项目0829'))
    await syncLock(lockRec('dealer-1'))
    expect(await screen.findByText(/上一条下发还在处理中（测试项目0829）/)).toBeTruthy()
    expect(sendBtn().hasAttribute('disabled')).toBe(true)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
  })

  it('被别的账号占着：只显示 OTHER_ACCOUNT_TEXT（不带项目名），按钮置灰', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26) })
    await mount()
    await click(screen.getByText('测试项目0829'))
    await syncLock(lockRec('someone-else'))
    const note = await screen.findByText(OTHER_ACCOUNT_TEXT)
    expect(note.textContent).not.toContain('测试项目0829')
    expect(sendBtn().hasAttribute('disabled')).toBe(true)
  })

  it('刷新后（restored 来源）：组织数据到了会补核对；回读不一致时锁仍在，页面提示并置灰', async () => {
    // 记录的目标是房间开，回读到关：补核对不一致，锁保留（回读一致就会放锁，那是另一条路径）
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26) })
    // 刷新前留下的记录；重新加载模块 = 刷新页面
    localStorage.setItem(STORAGE_PREFIX + 'project:p1', JSON.stringify(lockRec('dealer-1')))
    vi.resetModules()
    const W = await import('../api/writeLock')
    expect(W.lockOf('project:p1')?.origin).toBe('restored')
    const C = (await import('./Control')).default
    const S = await import('../app/store')
    const Q = await import('../api/query')
    const SS = await import('../api/session')
    const CF = await import('../api/config')
    const RR = await import('react-router-dom')
    const RQ = await import('@tanstack/react-query')
    CF.setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test' })
    await SS.signIn('d', 'pw', true)
    render(createElement(RQ.QueryClientProvider, { client: Q.createQueryClient() }, createElement(S.AppProvider, null,
      createElement(RR.MemoryRouter, { initialEntries: ['/control'] }, createElement(RR.Routes, null, createElement(RR.Route, { path: '/control', element: createElement(C) }))))))
    await click(await screen.findByText('测试项目0829'))
    expect(await screen.findByText(/上一条下发还在处理中（测试项目0829）/)).toBeTruthy()
    expect(sendBtn().hasAttribute('disabled')).toBe(true)
    expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBeGreaterThan(0)
    expect(W.lockOf('project:p1')?.phase).toBe('unknown')
  })

  it('强制重读：锁放开（对方删除记录）时重读一次房间状态，按钮恢复', async () => {
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26) })
    await mount()
    await click(screen.getByText('测试项目0829'))
    await syncLock(lockRec('dealer-1'))
    await screen.findByText(/上一条下发还在处理中/)
    await tick(50)
    const n0 = be.callsTo('/ctrl/room-temperature-data-get').length
    await syncLock(null)
    await waitFor(() => expect(be.callsTo('/ctrl/room-temperature-data-get').length).toBe(n0 + 1))
    expect(screen.queryByText(/上一条下发还在处理中/)).toBeNull()
    expect(sendBtn().hasAttribute('disabled')).toBe(false)
  })
})

describe('房间都关着', () => {
  it('已选项目的房间全部关着：温度设定禁用并提示；同时选「全部开启」才可设温度', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26) })
    await mount()
    await click(keep())
    await click(screen.getByText('测试项目0829'))
    expect(await screen.findByText(/房间都关着（测试项目0829）/)).toBeTruthy()
    expect(keep().hasAttribute('disabled')).toBe(true)
    await expectTempLocked()
    await click(screen.getByRole('button', { name: '全部开启' }))
    expect(screen.queryByText(/房间都关着/)).toBeNull()
    expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(false)
  })

  it('房间开着：温度可设', async () => {
    backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26) })
    await mount()
    await click(keep())
    await click(screen.getByText('测试项目0829'))
    await waitFor(() => expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(false))
    expect(screen.queryByText(/房间都关着/)).toBeNull()
  })
})

describe('真实数据模式的最近一次结果', () => {
  const ROW = (name: string) => JSON.stringify([{ name, code: '240829001', status: 'success', at: '2026-11-24 10:00:00' }])
  it('第一次进来没有记录：显示「暂无执行记录」，不显示演示结果', async () => {
    backend()
    await mount()
    await tick(400)
    expect(screen.getByText('暂无执行记录')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/朝阳壹号院|PRJ-/)
  })

  it('只显示当前数据源 + 当前账号（user id）的结果：演示模式存的、别的账号存的都不显示', async () => {
    sessionStorage.setItem('hjc-unified-last:mock:d', ROW('演示模式存的'))
    sessionStorage.setItem('hjc-unified-last:real:someone-else', ROW('别的账号存的'))
    backend()
    await mount()
    await tick(200)
    expect(screen.queryByText('演示模式存的')).toBeNull()
    expect(screen.queryByText('别的账号存的')).toBeNull()
    expect(screen.getByText('暂无执行记录')).toBeTruthy()
    cleanup()
    sessionStorage.setItem('hjc-unified-last:real:dealer-1', ROW('本账号存的'))
    await mount(false)
    expect(await screen.findByText('本账号存的')).toBeTruthy()
  })

  it('没有 user id 时用令牌的 sub 区分账号；演示模式按演示账号名', () => {
    const tok = (sub: string) => `x.${btoa(JSON.stringify({ sub, exp: 9e9 })).replace(/=+$/, '')}.y`
    setCurrentUserId('')
    writeTokens({ accessToken: tok('sub-1'), refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    expect(lastResultKey(false, 'd')).toBe('real:sub-1')
    setCurrentUserId('u-9')
    expect(lastResultKey(false, 'd')).toBe('real:u-9')
    expect(lastResultKey(true, 'cosyhome')).toBe('mock:cosyhome')
    setCurrentUserId(''); clearTokens()
    expect(lastResultKey(false, 'd')).toBeNull()
  })

  it('存储被改坏（状态是原型链上的键等）：忽略坏行，不报错', async () => {
    sessionStorage.setItem('hjc-unified-last:real:dealer-1', JSON.stringify([{ name: 'x', code: '1', status: 'toString', at: 't' }, { name: 'y', code: 2, status: 'success', at: 't' }]))
    backend()
    await mount()
    expect(screen.queryByText('x')).toBeNull()
    expect(screen.queryByText('y')).toBeNull()
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
