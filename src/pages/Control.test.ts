// @vitest-environment jsdom
// 统一控制页面（S12b）：真实数据形状 + 假后端。覆盖 app_code 8/12 禁用温度、「保持不变」时温度区真正禁用（键盘也改不了）、
// 离线不能下发、温度范围与步长、二次确认 → 成功 / 失败 / 未变化 / 结果未知 / 无法核对、失败不重试、下发前后各读一次。
// 只用假后端（fetch 被替换），不连任何真实服务，不调真实写接口。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { toast as sonner } from 'sonner'
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { decodeReply, encodeMessage } from '../api/ctrl'
import * as pb from '../api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../api/http'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests, signIn, signOut } from '../api/session'
import { clearTokens, writeTokens } from '../api/tokens'
import { fakeBackend, json, text, type Call } from '../api/__tests__/helpers'
import { AppProvider } from '../app/store'
import { __resetCurrentForTests } from '../data/org/current'
import { __resetSessionViewForTests } from '../data/session'
import { __resetMockUnifiedForTests, mockUnifiedRead, mockUnifiedSend } from '../api'
import Control, { lastResultKey } from './Control'
import { setCurrentUserId } from '../api/auth'
import { __resetWriteLockForTests, lockOf, OTHER_ACCOUNT_TEXT, RETRY_DELAYS_MS, STORAGE_PREFIX } from '../api/writeLock'
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
  { id: 'p1', code: '240829001', name: '测试项目0829', app_code: '1', app_version: '4.3.9', online: true },
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
    '/me': () => json({ user_entity: { id: 'dealer-1', name: '测试', type: 1 }, permission_paths: ['/v1/ctrl/device-summary-get'] }),
    '/ctrl/projects': () => json({ project_entities: PROJECTS }),
    // 下发前的控制屏实时预检（ctrl 205）：默认在线
    '/ctrl/device-summary-get': () => json({ body: '' }),
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
/** 结果卡片：项目、状态、操作时间三列（S13 走查去掉了项目 ID 列） */
function expectFourCells(badge: HTMLElement) {
  const cells = within(badge.closest('tr')!).getAllByRole('cell')
  expect(cells).toHaveLength(3)
  expect(cells[1].textContent).toBe(badge.textContent)
  expect(badge.closest('table')!.textContent).not.toMatch(/项目ID|240829001/)
}
const tick = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
/**
 * 假时钟（跟着真实时间走，waitFor、假后端照常用），需要时快进。写锁下发后回读不是已生效时按 5 / 20 / 60 秒自动再核对，
 * 卡片在退避用完前显示「正在核对」：断言最终结论的用例先 fakeClock()，再 runRetries() 把退避真跑完
 */
const fakeClock = () => vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
/** 把自动再核对（5 / 20 / 60 秒）跑完：每次退避到点后等那次核对读完 */
async function runRetries() { await tick(30); for (const d of RETRY_DELAYS_MS) { await advance(d); await tick(30) } }
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
  setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test', features: { roomSwitchReported: true } })
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
// Sonner 的 toast 队列是模块级的：上一条用例没消失的 toast 会在下一条挂载 Toaster 时又显示出来
afterEach(() => { cleanup(); sonner.dismiss(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfig(null) })

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

  it('选「全部关闭」房间时温度照常可设，提示「房间开启后生效」（后端 11/25 答复第 16 条）', async () => {
    backend()
    await mount()
    await click(keep())
    await click(screen.getByRole('button', { name: '全部关闭' }))
    expect(screen.getByText('房间将被关闭，设定的温度房间开启后生效')).toBeTruthy()
    expect(keep().hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(false)
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

describe('S13 走查', () => {
  it('运行模式按钮去掉末尾「模式」、不换行；没有写死的「推荐夏季 26°C」；项目列表不显示项目 ID 和版本号', async () => {
    backend()
    await mount()
    const modes = [...within(screen.getByRole('group', { name: '运行模式' })).getAllByRole('button')].map((b) => b.textContent)
    expect(modes.every((m) => m!.length <= 4)).toBe(true)
    expect(document.body.textContent).not.toMatch(/推荐夏季|冷热过度/)
    const list = screen.getByText('测试项目0829').closest('.pick')!.textContent!
    expect(list).not.toMatch(/240829001|4\.3\.9/)
  })
})

describe('运行模式只有 5 种（后端 11/26 08:34）', () => {
  const RETIRED = ['免费制冷', '制热除湿', '供热', '供热加湿', '加湿', '供冷', '供冷加湿', '供冷除湿', '冷热过渡']
  it('按钮依次是 夏季、冬季、除湿、通风、自动，加「不变」；其余 9 种不再显示', async () => {
    backend()
    await mount()
    await click(screen.getByText('测试项目0829'))
    const modes = [...within(screen.getByRole('group', { name: '运行模式' })).getAllByRole('button')].map((b) => b.textContent)
    expect(modes).toEqual(['夏季', '冬季', '除湿', '通风', '自动', '不变'])
    for (const m of RETIRED) expect(document.body.textContent).not.toContain(m)
  })

  it.each([['夏季', 2], ['冬季', 3], ['除湿', 5], ['通风', 4], ['自动', 100]] as const)('勾选项目 → 点「%s」→ 指令预览、确认框、请求体（system_mode=%i）、结果卡一致', async (label, value) => {
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    await mount()
    await click(screen.getByText('测试项目0829'))
    await click(within(screen.getByRole('group', { name: '运行模式' })).getByRole('button', { name: label }))
    const pv = [...document.querySelectorAll('.pv-row')].find((r) => r.textContent!.startsWith('运行模式'))!
    expect(pv.textContent).toBe('运行模式' + label)
    await click(screen.getByRole('button', { name: '确认下发' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg.textContent).toContain('运行模式' + label)
    await click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1))
    const body = be.callsTo('/ctrl/unified-ctrl-set')[0].body as { body: string }
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: -1, systemMode: value, roomSwitch: -1, roomTemp: -1 })
    // 运行模式没有回读：结果卡和「下发核对」都显示「已下发，正在核对…」（写锁按有效期放开）
    const card = await screen.findByRole('region', { name: '最近一次执行结果' }, { timeout: 3000 })
    await waitFor(() => expect(card.textContent).toContain(TEXT.verifying))
    expect(await openNotes()).toContain(TEXT.verifying)
    for (const m of RETIRED) expect(document.body.textContent).not.toContain(m)
  })
})

describe('温度黑名单：只禁 8、12 和缺失，其他类型按 1 处理（负责人 11/26 08:47）', () => {
  const as = (app_code: string | undefined, extra: Record<string, Handler> = {}) => backend({
    ...extra,
    '/ctrl/projects': () => json({ project_entities: PROJECTS.map((p) => (p.id === 'p1' ? { ...p, app_code } : p)) }),
    '/ctrl/room-temperature-data-get': () => rooms(1, 26),
    '/ctrl/unified-ctrl-set': () => reply(true),
    ...extra,
  })
  const pickAndRaise = async () => {
    await mount()
    await click(screen.getByText('测试项目0829'))
    expect(keep().hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/该应用类型不支持温度设定|应用类型未知/)).toBeNull()
    await click(keep())
    await click(screen.getByRole('button', { name: '升高温度' }))
    expect(shown()).toBe('26.5°C')
    await click(screen.getByRole('button', { name: '确认下发' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg.textContent).toContain('房间温度26.5°C')
    return dlg
  }
  it.each(['4', '7', '9', '11', '1000', '6'])('app_code %s：勾选项目后温度可设，205 在线时照常下发温度', async (code) => {
    const be = as(code)
    const dlg = await pickAndRaise()
    await click(within(dlg).getByRole('button', { name: '确认下发' }))
    await waitFor(() => expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1))
    const body = be.callsTo('/ctrl/unified-ctrl-set')[0].body as { body: string }
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: 26.5 })
  })
  it.each([
    ['控制屏未连接（503 code 14）', () => json({ code: 14, message: '控制屏消息发送失败' }, 503), '未下发（控制屏未连接）'],
    ['检查失败（500）', () => json({ code: 13, message: 'internal' }, 500), '控制屏在线检查失败，未下发，请重试'],
  ])('app_code 4（水舒适，还没接入接口）：温度可选，但 205 预检%s → 拦下、不发写请求、不占锁', async (_n, r205, text) => {
    const be = as('4', { '/ctrl/device-summary-get': r205 })
    const dlg = await pickAndRaise()
    await click(within(dlg).getByRole('button', { name: '确认下发' }))
    await screen.findByText('未下发', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(be.callsTo('/ctrl/device-summary-get').length).toBeGreaterThan(0)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
    expect(lockOf('project:p1')).toBeNull()
    expect(await openNotes()).toContain(text)
  })
  it.each([[undefined], [''], ['abc'], ['0']])('app_code 缺失或无法解析（%s）：温度仍禁用，提示「应用类型未知」', async (code) => {
    as(code)
    await mount()
    await click(screen.getByText('测试项目0829'))
    expect(screen.getByText(/应用类型未知，温度设定不可用/)).toBeTruthy()
    await expectTempLocked()
  })
})

describe('app_code 8 按 12 处理（后端 11/26 08:34）', () => {
  it.each([['空气单机', '空气单机测试'], ['独立空气系统', '独立空气系统测试']])('组「%s」：勾选项目「%s」后温度禁用、提示「该应用类型不支持温度设定」；房间开关、运行模式仍可用', async (group, name) => {
    backend({ '/ctrl/room-temperature-data-get': () => json({ body: '' }) })
    await mount()
    await pickGroup(group)
    await click(screen.getByText(name))
    expect(screen.getByText(name).closest('.pick')!.className).toContain('on')
    expect(screen.getByText(/该应用类型不支持温度设定/)).toBeTruthy()
    expect(keep().hasAttribute('disabled')).toBe(true)
    await expectTempLocked()
    expect(screen.getByRole('button', { name: '全部开启' }).hasAttribute('disabled')).toBe(false)
    expect(within(screen.getByRole('group', { name: '运行模式' })).getByRole('button', { name: '自动' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('S13 同名序号（第 2 轮评审）', () => {
  // 同一集成项目里两个同名项目（q1、q2），另有一个原始名称本身带「 (2)」的项目；另有一个同名的集成项目
  const DUP_PROJECTS = [
    ...PROJECTS,
    { id: 'q1', code: '111', name: '同名项目', app_code: '1', online: true },
    { id: 'q2', code: '222', name: '同名项目', app_code: '1', online: true },
    { id: 'q3', code: '333', name: '改名 (2)', app_code: '1', online: true },
  ]
  const DUP_GROUPS = [
    { ...GROUPS[0], project_ids: ['p1', 'p3', 'q1', 'q2', 'q3'] },
    ...GROUPS.slice(1),
    { id: 'g4', code: '5', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['p2'] },
  ]
  const dupBackend = (routes: Record<string, Handler> = {}) => backend({
    '/ctrl/projects': () => json({ project_entities: DUP_PROJECTS }),
    '/integrated-projects': () => json({ entities: DUP_GROUPS }),
    ...routes,
  })
  const resultNames = () => within(screen.getByRole('region', { name: '最近一次执行结果' })).getAllByRole('row').slice(1)
    .map((tr) => within(tr).getAllByRole('cell')[0].textContent)

  it('集成项目下拉：同名集成项目第 2 个写「五恒集成项目 (2)」', async () => {
    dupBackend()
    await mount()
    const sel = screen.getByRole('combobox', { name: '集成项目' })
    await act(async () => { fireEvent.keyDown(sel, { key: 'Enter' }) })
    const opts = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent)
    expect(opts).toEqual(['五恒集成项目', '独立空气系统', '空气单机', '五恒集成项目 (2)'])
  })

  it('只勾同名项目里的第 2 个：项目列表、确认框、结果表都写「同名项目 (2)」', async () => {
    const be = dupBackend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    await mount()
    expect(screen.getAllByText(/^同名项目/).map((e) => e.textContent)).toEqual(['同名项目', '同名项目 (2)'])
    await click(screen.getByText('同名项目 (2)'))
    await click(screen.getByRole('button', { name: '全部开启' }))
    await click(screen.getByRole('button', { name: '确认下发' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg.textContent).toContain('同名项目 (2)')
    expect(dlg.textContent).not.toContain('222')
    await click(within(dlg).getByRole('button', { name: '确认下发' }))
    // 222 不在可下发白名单里，写防护拦下（未执行）；这里只核对结果表里的名称
    await screen.findByText('失败（未执行）', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
    expect(resultNames()).toEqual(['同名项目 (2)'])
  })

  it('结果表：记录名和项目当前原始名称一致才用序号名；改过名的照记录显示（原始名称本身带「 (2)」也不误认）', async () => {
    sessionStorage.setItem('hjc-unified-last:real:dealer-1', JSON.stringify([
      { name: '同名项目', code: '222', status: 'success', at: '2026-11-24 10:00:00' },
      { name: '旧名字', code: '111', status: 'success', at: '2026-11-24 10:00:00' },
      { name: '改名', code: '333', status: 'success', at: '2026-11-24 10:00:00' },
    ]))
    dupBackend()
    await mount()
    await screen.findByText('旧名字')
    expect(resultNames()).toEqual(['同名项目 (2)', '旧名字', '改名'])
  })

  it('结果表：记录里的同名项目在当前集成项目里找不到（切换过集成项目）→ 在结果内部按名称加序号', async () => {
    sessionStorage.setItem('hjc-unified-last:real:dealer-1', JSON.stringify([
      { name: '别处同名', code: '901', status: 'success', at: '2026-11-24 10:00:00' },
      { name: '别处同名', code: '902', status: 'success', at: '2026-11-24 10:00:00' },
      { name: '同名项目', code: '222', status: 'success', at: '2026-11-24 10:00:00' },
    ]))
    dupBackend()
    await mount()
    await screen.findByText('别处同名 (2)')
    expect(resultNames()).toEqual(['别处同名', '别处同名 (2)', '同名项目 (2)'])
  })

  it('结果表：一行按当前列表取名、另一行照记录显示且同名 → 照记录的那行接着编号，不和列表里的显示名撞（第 3 轮评审）', async () => {
    sessionStorage.setItem('hjc-unified-last:real:dealer-1', JSON.stringify([
      { name: '同名项目', code: '901', status: 'success', at: '2026-11-24 10:00:00' },
      { name: '同名项目', code: '222', status: 'success', at: '2026-11-24 10:00:00' },
    ]))
    dupBackend()
    await mount()
    await screen.findByText('同名项目 (3)')
    expect(resultNames()).toEqual(['同名项目 (3)', '同名项目 (2)'])
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
    expect(dlg.textContent).toContain('测试项目0829')
    expect(dlg.textContent).not.toContain('240829001') // S13：界面不显示项目 id
    expect(dlg.textContent).toContain('房间开关开启')
    expect(dlg.textContent).toContain('房间温度26.5°C')
    expect(dlg.textContent).toContain('设置温度不会开启房间，房间开启后按此温度运行')
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
    expect(heads).toEqual(['项目', '状态', '操作时间']) // S13：去掉项目 ID 列
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
    fakeClock()
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    const badge = await screen.findByText('未变化', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expectFourCells(badge)
    expect(screen.queryByText('已生效', { selector: '[data-slot=badge]' })).toBeNull()
    const notes = await openNotes()
    expect(notes).toContain(TEXT.unapplied)
    expect(notes).toContain('房间开关下发 开启，回读 关闭')
    expect(notes).not.toContain(TEXT.success)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
  })

  it('部分字段一致：房间开关已开、温度没变 → 总结果未变化；卡片状态列显示计数标题，逐字段明细在「下发核对」，只有温度带不一致说明', async () => {
    fakeClock()
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': room200(() => be, [0, 26], [1, 26]), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    // Fable 11/25：混合时状态列写计数，不压成一个词；卡片仍是四列
    await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    const badge = await screen.findByText('1 项未生效，1 项已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expectFourCells(badge)
    const notes = await openNotes()
    expect(notes).toContain('房间开关：已生效')
    expect(notes).toContain('房间温度：未变化（房间温度下发 26.5°C，回读 26°C）')
    expect(notes).not.toContain('房间开关下发')
  })

  it('200 里房间没有 switch 字段（0 值不编码）→ 按「关」核对：下发开启 → 未变化（测试服 240829001 那次）', async () => {
    fakeClock()
    const noSwitch = () => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: [{ id: 1, name: '房间11', setTemp: 26, isConnected: true }, { id: 2, name: '房间13', setTemp: 26, isConnected: true }] }) })
    backend({ '/ctrl/room-temperature-data-get': noSwitch, '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await screen.findByText('未变化', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(await openNotes()).toContain('房间开关下发 开启，回读 关闭')
  })

  it('下发后 200 回包为空（{}，没有房间条目）→ 无法核对', async () => {
    fakeClock()
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': () => (be.callsTo('/ctrl/unified-ctrl-set').length ? json({ body: '' }) : rooms(0, 26)), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await screen.findByText('无法核对', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    const notes = await openNotes()
    expect(notes).toContain(TEXT.unverifiable)
    expect(notes).toContain('下发后 无房间')
  })

  describe('首次回读不一致：正在核对（赤兔 11/25）', () => {
    /** 203 之后第 n 次读 200（1 = 批次的下发后回读，之后是写锁的自动再核对） */
    function after203(nth: (n: number) => Response) {
      let be!: ReturnType<typeof backend>
      let n = 0
      be = backend({ '/ctrl/room-temperature-data-get': () => (be.callsTo('/ctrl/unified-ctrl-set').length ? nth(++n) : rooms(0, 26)), '/ctrl/unified-ctrl-set': () => reply(true) })
      return { be, reads: () => n }
    }
    /** 记录结果卡片状态列出现过的所有文案 */
    function recordBadges() {
      const seen: string[] = []
      const grab = () => { for (const b of document.querySelectorAll('[role=region] [data-slot=badge]')) { const t = b.textContent ?? ''; if (!seen.includes(t)) seen.push(t) } }
      const mo = new MutationObserver(grab)
      mo.observe(document.body, { subtree: true, childList: true, characterData: true })
      return { all: () => { grab(); return seen }, stop: () => mo.disconnect() }
    }
    it('批次回读旧值、写锁首次自动核对仍旧值、第一次退避读到新值：状态列只出现「正在核对」和「已生效」，不出现「未变化」；刷新后仍是已生效', async () => {
      fakeClock()
      const { be, reads } = after203((n) => (n <= 2 ? rooms(0, 26) : rooms(1, 26.5)))
      const dlg = await prepare()
      const rec = recordBadges()
      await click(okIn(dlg))
      await screen.findByText(TEXT.verifying, { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(await openNotes()).toContain(TEXT.verifying)
      await advance(RETRY_DELAYS_MS[0]) // 第一次退避（5 秒）读到新值
      await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(reads()).toBeGreaterThanOrEqual(3)
      const all = rec.all()
      rec.stop()
      expect(all).toContain(TEXT.verifying)
      expect(all).not.toContain('未变化')
      expect(all).not.toContain('结果未知')
      expect(all.filter((t) => t !== TEXT.verifying && t !== '已生效')).toEqual([])
      expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
      // 定为已生效后存进本标签页：重新进入仍是已生效
      cleanup()
      await mount(false)
      expect(screen.getByText('已生效', { selector: '[data-slot=badge]' })).toBeTruthy()
    })
    it('批次结束前写锁的自动核对已一致放开：直接「已生效」，不出现「未变化」', async () => {
      after203((n) => (n === 1 ? rooms(0, 26) : rooms(1, 26.5)))
      const dlg = await prepare()
      const rec = recordBadges()
      await click(okIn(dlg))
      await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      const all = rec.all()
      rec.stop()
      expect(all.filter((t) => t !== TEXT.verifying && t !== '已生效')).toEqual([])
    })
    it('两个项目：第一个的写锁在批次结束前（第二个还在下发）就自动核对一致放开 → 第一个直接「已生效」，不留「未变化」（第二个的结果不在本用例范围）', async () => {
      const P5 = { id: 'p5', code: '240829005', name: '测试项目0905', app_code: '1', online: true }
      const sentTo = new Set<string>()
      let p1Reads = 0
      const pid = (c: Call) => (c.body as { project_id?: string } | undefined)?.project_id
      backend({
        '/ctrl/projects': () => json({ project_entities: [...PROJECTS, P5] }),
        '/integrated-projects': () => json({ entities: [{ ...GROUPS[0], project_ids: ['p1', 'p3', 'p5'] }, ...GROUPS.slice(1)] }),
        '/ctrl/room-temperature-data-get': (c) => {
          const id = pid(c) ?? ''
          if (!sentTo.has(id)) return rooms(0, 26)
          if (id === 'p1') return ++p1Reads === 1 ? rooms(0, 26) : rooms(1, 26.5) // 批次回读旧值，写锁首次自动核对新值
          return rooms(1, 26.5)
        },
        '/ctrl/unified-ctrl-set': async (c) => {
          const id = pid(c) ?? ''
          if (id === 'p5') await new Promise((r) => setTimeout(r, 400)) // 第二个项目慢：第一个的写锁先放开
          sentTo.add(id)
          return reply(true)
        },
      })
      await mount()
      await click(screen.getByText('测试项目0829'))
      await click(screen.getByText('测试项目0905'))
      await click(screen.getByRole('button', { name: '全部开启' }))
      await click(keep())
      await click(screen.getByRole('button', { name: '升高温度' }))
      await click(screen.getByRole('button', { name: '确认下发' }))
      const dlg = await screen.findByRole('alertdialog')
      const rec = recordBadges()
      await click(okIn(dlg))
      await waitFor(() => expect(document.querySelectorAll('[role=region] tbody tr').length).toBe(2), { timeout: 3000 })
      const p1Row = () => [...document.querySelectorAll('[role=region] tbody tr')].find((r) => r.textContent?.includes('测试项目0829'))!
      expect(p1Row().querySelector('[data-slot=badge]')!.textContent).toBe('已生效')
      expect(p1Reads).toBeGreaterThanOrEqual(2)
      const all = rec.all()
      rec.stop()
      expect(all).not.toContain('未变化')
      expect(all).not.toContain('结果未知')
    })
    it('退避都不一致：退避用完前是「正在核对」，用完才显示「未变化」', async () => {
      fakeClock()
      const { reads } = after203(() => rooms(0, 26))
      const dlg = await prepare()
      const rec = recordBadges()
      await click(okIn(dlg))
      await screen.findByText(TEXT.verifying, { selector: '[data-slot=badge]' }, { timeout: 3000 })
      await advance(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1])
      await tick(30)
      expect(screen.queryByText('未变化', { selector: '[data-slot=badge]' })).toBeNull() // 第三次退避（60 秒）之前不报结论
      await runRetries()
      await screen.findByText('未变化', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(reads()).toBeGreaterThanOrEqual(2 + RETRY_DELAYS_MS.length) // 批次回读 + 写锁首次自动核对 + 三次退避（之后页面会再刷新一次房间状态）
      const all = rec.all()
      rec.stop()
      expect(all.indexOf(TEXT.verifying)).toBeGreaterThanOrEqual(0)
      expect(all.indexOf(TEXT.verifying)).toBeLessThan(all.indexOf('未变化'))
      expect(await openNotes()).toContain(TEXT.unapplied)
    })
    it('最终结论以写锁最后一次核对为准：批次回读「未变化」，最后一次自动再核对回读失败 → 卡片最终显示「结果未知」（不是批次的未变化），到期后存下', async () => {
      fakeClock()
      let fail = false
      const { reads } = after203(() => (fail ? json({ code: 13, message: 'internal' }, 500) : rooms(0, 26)))
      const dlg = await prepare()
      await click(okIn(dlg))
      await screen.findByText(TEXT.verifying, { selector: '[data-slot=badge]' }, { timeout: 3000 })
      await advance(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1])
      await tick(30)
      fail = true // 第三次退避（60 秒）读失败
      await advance(RETRY_DELAYS_MS[2])
      await tick(30)
      await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(screen.queryByText('未变化', { selector: '[data-slot=badge]' })).toBeNull()
      expect(await openNotes()).toContain('最后一次自动再核对回读失败')
      expect(reads()).toBeGreaterThanOrEqual(5)
      // 锁到期放开：结论定下并存进本标签页，重新进入仍是结果未知
      await advance(2 * 60_000)
      await tick(30)
      cleanup()
      await mount(false)
      expect(screen.getByText('结果未知', { selector: '[data-slot=badge]' })).toBeTruthy()
    })
    it('最终结论以写锁最后一次核对为准：批次回读「未变化」，退避核对读到部分一致（房间开关已开、温度没变）→ 按那次读数逐字段显示', async () => {
      fakeClock()
      const { reads } = after203((n) => (n <= 2 ? rooms(0, 26) : rooms(1, 26)))
      const dlg = await prepare()
      await click(okIn(dlg))
      await screen.findByText(TEXT.verifying, { selector: '[data-slot=badge]' }, { timeout: 3000 })
      await runRetries()
      await screen.findByText('1 项未生效，1 项已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      const notes = await openNotes()
      expect(notes).toContain('回读（最后一次自动再核对）：房间开 · 26.0°C')
      expect(reads()).toBeGreaterThanOrEqual(5)
    })
    it('离开页面后写锁在后台核对一致放开，登出再用同一账号登录：回到统一控制仍显示「已生效」（结束记录跨重登保留，#66）', async () => {
      fakeClock()
      const { be } = after203((n) => (n <= 2 ? rooms(0, 26) : rooms(1, 26.5)))
      void be
      const dlg = await prepare()
      await click(okIn(dlg))
      await screen.findByText(TEXT.verifying, { selector: '[data-slot=badge]' }, { timeout: 3000 })
      cleanup() // 离开页面
      await advance(RETRY_DELAYS_MS[0]) // 后台第一次退避读到新值：一致放锁
      await tick(30)
      await act(async () => { await signOut() })
      await mount() // 同一账号重新登录（会话换代）
      expect(await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })).toBeTruthy()
      expect(screen.queryByText('未变化', { selector: '[data-slot=badge]' })).toBeNull()
    })
    /**
     * 迟到读数（#66）：第一次退避（203 后第 3 次读）的回读忽略中止，核对超时（15 秒）后才回来，读到「房间开、温度没变」；
     * 之后写锁收下的核对都读到旧值。lateAt 决定这份迟到读数在什么时候回来
     */
    async function lateRead(lateAt: 'before-expiry' | 'after-expiry') {
      fakeClock()
      setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test', requestTimeoutMs: 600_000, features: { roomSwitchReported: true } } as never)
      let release = () => {}
      const gate = new Promise<void>((r) => { release = r })
      let hang = false
      let late = false
      const { reads } = after203(() => {
        if (!hang) return rooms(0, 26)
        hang = false
        return gate.then(() => { late = true; return rooms(1, 26) }) as unknown as Response
      })
      const dlg = await prepare()
      await click(okIn(dlg))
      await screen.findByText(TEXT.verifying, { selector: '[data-slot=badge]' }, { timeout: 3000 })
      hang = true
      const r0 = reads()
      await advance(RETRY_DELAYS_MS[0]) // 第一次退避：这次读挂住
      await tick(30)
      expect(hang).toBe(false)
      expect(reads()).toBe(r0 + 1)
      await advance(15_000) // 核对超时（读数还没回来）
      await tick(30)
      await advance(RETRY_DELAYS_MS[1]) // 第二次退避：旧值
      await tick(30)
      await advance(RETRY_DELAYS_MS[2]) // 第三次退避：旧值，退避用完
      await tick(30)
      expect(reads()).toBe(r0 + 3)
      await screen.findByText('未变化', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      if (lateAt === 'after-expiry') { await advance(2 * 60_000); await tick(30) }
      await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) }) // 迟到读数回来
      await tick(30)
      expect(late).toBe(true)
      expect(screen.queryByText('1 项未生效，1 项已生效', { selector: '[data-slot=badge]' })).toBeNull()
      expect(screen.getByText('未变化', { selector: '[data-slot=badge]' })).toBeTruthy()
      expect(await openNotes()).toContain('回读（最后一次自动再核对）：房间关 · 26.0°C')
      if (lateAt === 'before-expiry') { await advance(2 * 60_000); await tick(30) }
      // 到期定下并存进本标签页：重新进入仍是写锁最后收下那次的结论
      cleanup()
      await mount(false)
      expect(screen.getByText('未变化', { selector: '[data-slot=badge]' })).toBeTruthy()
      expect(screen.queryByText('1 项未生效，1 项已生效', { selector: '[data-slot=badge]' })).toBeNull()
    }
    it('迟到读数（核对超时后、到期前才回来）不改变最终卡片：按写锁最后收下的那次核对的读数重算（#66）', () => lateRead('before-expiry'))
    it('迟到读数（锁到期后才回来）不改变最终卡片（#66）', () => lateRead('after-expiry'))
    it('批次截止时还没收到应答（锁仍在 sent）：应答之后写锁核对一致 → 卡片最终显示「已生效」', async () => {
      fakeClock()
      setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test', requestTimeoutMs: 120_000, features: { roomSwitchReported: true } } as never)
      let release = () => {}
      const gate = new Promise<void>((r) => { release = r })
      let be!: ReturnType<typeof backend>
      be = backend({
        '/ctrl/room-temperature-data-get': () => (be.callsTo('/ctrl/unified-ctrl-set').length && sent ? rooms(1, 26.5) : rooms(0, 26)),
        '/ctrl/unified-ctrl-set': async () => { await gate; sent = true; return reply(true) },
      })
      let sent = false
      const dlg = await prepare()
      await click(okIn(dlg))
      await waitFor(() => expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1))
      await advance(36_000) // 过 35 秒批次截止：这一行按结果未知冻结，锁还在 sent（没收到应答）
      await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) }) // 应答 success 才到：写锁按结果未知待核对，自动核对读到一致
      await screen.findByText('已生效', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
    })
  })

  it('下发后回读请求失败（500）→ 结果未知，提示回读失败、刷新核对；不列「设备未回报」，不算无法核对', async () => {
    fakeClock()
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': () => (be.callsTo('/ctrl/unified-ctrl-set').length ? text('oops', 500) : rooms(0, 26)), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(screen.queryByText('无法核对', { selector: '[data-slot=badge]' })).toBeNull()
    const notes = await openNotes()
    expect(notes).toContain(TEXT.sentUnknown)
    expect(notes).toContain(TEXT.readAfterFailedUnknown)
    expect(notes).not.toContain('设备未回报')
    expect(notes).not.toContain(TEXT.unverifiable)
  })

  it('下发后回读时房间离线（is_connected=false）、旧值碰巧一致 → 结果未知，不报已生效', async () => {
    fakeClock()
    const off = () => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: [{ id: 1, name: '客厅', switch: 1, setTemp: 26.5, isConnected: false }, { id: 2, name: '主卧', switch: 1, setTemp: 26.5, isConnected: true }] }) })
    let be!: ReturnType<typeof backend>
    be = backend({ '/ctrl/room-temperature-data-get': () => (be.callsTo('/ctrl/unified-ctrl-set').length ? off() : rooms(0, 26)), '/ctrl/unified-ctrl-set': () => reply(true) })
    await click(okIn(await prepare()))
    await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expect(await openNotes()).toContain(TEXT.roomsOffline)
  })

  it('500 且回读不一致 → 结果未知，提示刷新查看，不重试', async () => {
    fakeClock()
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => text('oops', 500) })
    await click(okIn(await prepare()))
    await runRetries() // 把自动再核对（5 / 20 / 60 秒）跑完，再断言最终显示
    const badge = await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
    expectFourCells(badge)
    expect(await openNotes()).toContain('已下发，结果未知，请刷新查看')
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

  describe('下发前控制屏实时预检（ctrl 205，赤兔 11/25）', () => {
    const offline205 = () => json({ code: 14, message: '控制屏消息发送失败' }, 503)
    const pid = (c: Call) => (c.body as { project_id?: string } | undefined)?.project_id
    const P5 = { id: 'p5', code: '240829005', name: '测试项目0905', app_code: '1', online: true }
    const two = (routes: Record<string, Handler>) => backend({
      '/ctrl/projects': () => json({ project_entities: [...PROJECTS, P5] }),
      '/integrated-projects': () => json({ entities: [{ ...GROUPS[0], project_ids: ['p1', 'p3', 'p5'] }, ...GROUPS.slice(1)] }),
      ...routes,
    })
    async function prepareTwo() {
      await mount()
      await click(screen.getByText('测试项目0829'))
      await click(screen.getByText('测试项目0905'))
      await click(screen.getByRole('button', { name: '全部开启' }))
      await click(keep())
      await click(screen.getByRole('button', { name: '升高温度' }))
      await click(screen.getByRole('button', { name: '确认下发' }))
      return screen.findByRole('alertdialog')
    }
    const row = (name: string) => [...document.querySelectorAll('[role=region] tbody tr')].find((r) => r.textContent?.includes(name))!

    it('205 返回 503 → 0 个写请求、未下发（控制屏未连接）、不占锁；不读 200 下发前状态', async () => {
      const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26), '/ctrl/unified-ctrl-set': () => reply(true), '/ctrl/device-summary-get': offline205 })
      const dlg = await prepare()
      const r0 = reads(be)
      await click(okIn(dlg))
      await screen.findByText('未下发', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
      expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(1)
      expect(reads(be)).toBe(r0)
      expect(lockOf('project:p1')).toBeNull()
      expect(await openNotes()).toContain('未下发（控制屏未连接），可重新勾选下发')
    })
    it('205 两次都超过 5 秒没返回（S13 P2：超时重查一次）→ 未下发、不发 203、不占锁，文案是「在线检查超时」不是「控制屏未连接」', async () => {
      const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26), '/ctrl/unified-ctrl-set': () => reply(true), '/ctrl/device-summary-get': () => new Promise<Response>(() => {}) })
      const dlg = await prepare()
      fakeClock()
      await click(okIn(dlg))
      await advance(5_100)
      expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(2) // 第一次超时后重查
      expect(document.querySelector('[role=region] tbody tr [data-slot=badge]')?.textContent ?? '').not.toBe('未下发')
      await advance(5_000)
      await screen.findByText('未下发', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(2) // 只重查一次
      expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
      expect(lockOf('project:p1')).toBeNull()
      const notes = await openNotes()
      expect(notes).toContain('控制屏在线检查超时，未下发，请重试')
      expect(notes).not.toContain('控制屏未连接')
    })
    it('205 第一次超时、重查在线（S13 P2）→ 放行：203 只发一次，照常核对出「已生效」', async () => {
      let n = 0
      let sent = false
      const be = backend({
        '/ctrl/room-temperature-data-get': () => (sent ? rooms(1, 26.5) : rooms(1, 26)),
        '/ctrl/unified-ctrl-set': () => { sent = true; return reply(true) },
        '/ctrl/device-summary-get': () => (++n === 1 ? new Promise<Response>(() => {}) : json({ body: '' })),
      })
      const dlg = await prepare()
      fakeClock()
      await click(okIn(dlg))
      await advance(5_100)
      vi.useRealTimers()
      await waitFor(() => expect(row('测试项目0829')?.querySelector('[data-slot=badge]')?.textContent).toBe('已生效'), { timeout: 3000 })
      expect(be.callsTo('/ctrl/device-summary-get')).toHaveLength(2)
      expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(1)
    })
    it('一离线一在线：只给在线的发 203，离线的标「未下发（控制屏未连接）」，在线的照常核对出结果（p5 离线在后，p1 在线在前）', async () => {
      const sentTo = new Set<string>()
      const be = two({
        '/ctrl/device-summary-get': (c) => (pid(c) === 'p5' ? offline205() : json({ body: '' })),
        '/ctrl/room-temperature-data-get': (c) => (sentTo.has(pid(c) ?? '') ? rooms(1, 26.5) : rooms(0, 26)),
        '/ctrl/unified-ctrl-set': (c) => { sentTo.add(pid(c) ?? ''); return reply(true) },
      })
      await click(okIn(await prepareTwo()))
      await waitFor(() => expect(row('测试项目0829')?.querySelector('[data-slot=badge]')?.textContent).toBe('已生效'), { timeout: 3000 })
      expect(row('测试项目0905').querySelector('[data-slot=badge]')!.textContent).toBe('未下发')
      expect(be.callsTo('/ctrl/unified-ctrl-set').map(pid)).toEqual(['p1'])
      expect(be.callsTo('/ctrl/device-summary-get').map(pid)).toEqual(['p1', 'p5'])
      expect(lockOf('project:p5')).toBeNull()
      expect(await openNotes()).toContain('未下发（控制屏未连接），可重新勾选下发')
    })
    it('205 返回 403（无连接状态权限）→ 0 个写请求、不占锁，单独文案（不说控制屏未连接），没有重试按钮', async () => {
      const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(1, 26), '/ctrl/unified-ctrl-set': () => reply(true), '/ctrl/device-summary-get': () => text('no permission', 403) })
      await click(okIn(await prepare()))
      await screen.findByText('未下发', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
      expect(lockOf('project:p1')).toBeNull()
      const notes = await openNotes()
      expect(notes).toContain('未下发（当前账号无连接状态权限，无法确认控制屏在线，暂不能下发，请联系管理员）')
      expect(notes).not.toContain('控制屏未连接')
      expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    })
    it('203 收到网关纯文本 504：说明里补「控制屏 10 秒内没有应答，可能离线」，仍按结果未知', async () => {
      fakeClock()
      backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26), '/ctrl/unified-ctrl-set': () => text('upstream request timeout', 504) })
      await click(okIn(await prepare()))
      await runRetries()
      await screen.findByText('结果未知', { selector: '[data-slot=badge]' }, { timeout: 3000 })
      expect(await openNotes()).toContain('控制屏 10 秒内没有应答，可能离线')
    })
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
    CF.setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test', features: { roomSwitchReported: true } })
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

describe('房间都关着（后端 11/25 答复第 16 条：温度照样生效，房间开启后按此温度运行）', () => {
  it('开关可信时：已选项目的房间全部关着 → 温度照常可设，提示「房间开启后生效」；选「全部开启」后提示消失；选「全部关闭」也能设温度', async () => {
    setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test', features: { roomSwitchReported: true } })
    backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26) })
    await mount()
    await click(keep())
    await click(screen.getByText('测试项目0829'))
    expect(await screen.findByText(/房间都关着（测试项目0829），设定的温度房间开启后生效/)).toBeTruthy()
    expect(keep().hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(false)
    await click(screen.getByRole('button', { name: '全部开启' }))
    expect(screen.queryByTestId('temp-room-note')).toBeNull()
    await click(screen.getByRole('button', { name: '全部关闭' }))
    expect(screen.getByTestId('temp-room-note').textContent).toContain('房间将被关闭，设定的温度房间开启后生效')
    expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(false)
  })

  it('开关未上报（config 写 false）：不读 200 判断房间状态，不禁用也不提示房间状态', async () => {
    setConfig({ apiBase: '/api', dataSource: 'real', apiEnv: 'test', features: { roomSwitchReported: false } } as never)
    const be = backend({ '/ctrl/room-temperature-data-get': () => rooms(0, 26) })
    await mount()
    await click(keep())
    await click(screen.getByText('测试项目0829'))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(screen.queryByText(/房间都关着/)).toBeNull()
    expect(screen.getByTestId('temp-box').hasAttribute('disabled')).toBe(false)
    expect(be.callsTo('/ctrl/room-temperature-data-get')).toHaveLength(0)
    expect(screen.queryByTestId('switch-unreported-note')).toBeNull()
    await click(screen.getByRole('button', { name: '全部开启' }))
    expect(screen.getByTestId('switch-unreported-note').textContent).toContain('设备暂不回报开关状态，2 分钟后可再次操作')
  })

  it('温度「保持不变」时不给「房间开启后生效」的提示（只关房间不设温度）', async () => {
    backend()
    await mount()
    await click(screen.getByRole('button', { name: '全部关闭' }))
    expect(screen.queryByTestId('temp-room-note')).toBeNull()
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
