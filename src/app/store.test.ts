// @vitest-environment jsdom
// confirm() 的 Promise 约定（S9 / S10 / S12 的下发都靠它，见 app/feedback.ts）：确认 true、取消 / Esc false；
// 打开中再次调用时前一个按取消结算；按钮只结算自己渲染出来的那次请求；离开（路由变化、登出、Provider 卸载）即按 false 结算；
// 连续确认时焦点回到最初的触发器。演示数据模式，不连任何后端。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, Fragment, StrictMode, useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { toast as sonner } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../api/config'
import { createQueryClient } from '../api/query'
import { __resetSessionViewForTests, logout, mockSignIn } from '../data/session'
import { __resetCurrentForTests } from '../data/org/current'
import { AppProvider, useApp } from './store'
import { createConfirmController, useCancelConfirmOnLeave, useConfirm, type ConfirmOwner } from './feedback'

type Confirm = ReturnType<typeof useConfirm>
const box: {
  confirm?: Confirm; nav?: (to: string) => void
  ownerConfirm?: Confirm; sent: number; setOffline?: (v: boolean) => void; setProject?: (id: string) => void
} = { sent: 0 }

/** 用 useConfirm() 发起确认的页面；确认为 true 才“下发”（sent + 1） */
function OwnerPage() {
  const confirm = useConfirm()
  useEffect(() => { box.ownerConfirm = (o) => confirm(o).then((ok) => { if (ok) box.sent++; return ok }) }, [confirm])
  return createElement('div', null, '页面')
}
/** 模拟 Layout 的两种卸载页面方式：离线分支替换 Outlet、按 project.id 重挂（keyed=false 时页面不随项目重挂） */
function MiniLayout({ keyed }: { keyed: boolean }) {
  const { project, setProjectId } = useApp()
  const [offline, setOffline] = useState(false)
  useEffect(() => { box.setOffline = setOffline; box.setProject = (id) => { setProjectId(id) } }, [setProjectId])
  if (offline) return createElement('div', null, '离线')
  return keyed ? createElement(Fragment, { key: project.id }, createElement(OwnerPage)) : createElement(OwnerPage)
}
function mountOwner(keyed = true) {
  return render(createElement(QueryClientProvider, { client: createQueryClient() }, createElement(AppProvider, null,
    createElement(BrowserRouter, null, createElement(Probe), createElement(MiniLayout, { keyed })))))
}
const ownerOpen = async (o: Parameters<Confirm>[0]) => { let r!: ReturnType<typeof track>; await act(async () => { r = track(box.ownerConfirm!(o)) }); return r }

/** 用 useConfirm() 发起确认的常驻组件（像 Layout 的「退出登录」：路由切换时不卸载） */
function Probe() {
  const confirm = useConfirm()
  useEffect(() => { box.confirm = confirm }, [confirm])
  return null
}
/** 模拟 Layout：常驻在 Router 里、调用离开即失效的桥接，下面是随路由切换的页面 */
function LayoutLike() {
  useCancelConfirmOnLeave()
  const nav = useNavigate()
  useEffect(() => { box.nav = nav }, [nav])
  return createElement(Fragment, null, createElement(Probe), createElement(Routes, null,
    createElement(Route, { path: '/a', element: createElement('div', null, 'A') }),
    createElement(Route, { path: '/b', element: createElement('div', null, 'B') })))
}
function mount(routed = false) {
  const inner = routed ? createElement(BrowserRouter, null, createElement(LayoutLike)) : createElement(Probe)
  return render(createElement(QueryClientProvider, { client: createQueryClient() }, createElement(AppProvider, null, inner)))
}
const confirm = (o: Parameters<Confirm>[0]) => box.confirm!(o)
/** 记录 Promise 结算情况，便于断言“还没结算” */
function track(p: Promise<boolean>) {
  const r: { value?: boolean; settled: number } = { settled: 0 }
  void p.then((v) => { r.value = v; r.settled++ })
  return r
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const open = async (o: Parameters<Confirm>[0]) => { let r!: ReturnType<typeof track>; await act(async () => { r = track(confirm(o)) }); return r }

beforeEach(() => {
  window.history.replaceState(null, '', '/a')
  setConfig({ apiBase: '/api', dataSource: 'mock' })
  localStorage.clear(); sessionStorage.clear()
  __resetSessionViewForTests(); __resetCurrentForTests()
  mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
})
// Sonner 的队列是模块级的、新挂载的 Toaster 会补发未关闭的 toast：每条用例后全部标记关闭，避免串到下一条
afterEach(() => { sonner.dismiss(); cleanup(); setConfig(null); box.confirm = undefined; box.nav = undefined; box.ownerConfirm = undefined; box.sent = 0 })

describe('confirm()', () => {
  it('点「确认」→ true，弹窗关闭', async () => {
    mount()
    const r = await open({ title: '确认下发', body: '正文', okText: '确认下发' })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '确认下发' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认下发' })) })
    await flush()
    expect(r).toEqual({ value: true, settled: 1 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('点「取消」→ false；Esc → false', async () => {
    mount()
    const a = await open({ title: 'A', body: 'a' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    const b = await open({ title: 'B', body: 'b' })
    await act(async () => { fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' }) })
    await flush()
    expect(b).toEqual({ value: false, settled: 1 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('打开中再次调用：前一个按取消结算，弹窗换成新内容；新的照常结算', async () => {
    mount()
    const a = await open({ title: '第一个', body: '1' })
    const b = await open({ title: '第二个', body: '2', okText: '好' })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(b.settled).toBe(0)
    expect(screen.queryByRole('heading', { name: '第一个' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '好' })) })
    await flush()
    expect(b).toEqual({ value: true, settled: 1 })
  })

  it('B 已发起、新内容还没提交渲染时点 A 的「确认」：只认 A 的身份，B 不会被结算成 true', async () => {
    mount()
    const a = await open({ title: 'A', body: 'a', okText: '确认 A' })
    const okA = screen.getByRole('button', { name: '确认 A' })
    // 不包 act：B 的状态更新已排队、还没提交，屏幕上仍是 A；紧接着（同一个同步块里）点 A 的按钮
    const b = track(confirm({ title: 'B', body: 'b', okText: '确认 B' }))
    expect(screen.getByRole('heading', { name: 'A' })).toBeTruthy()
    okA.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(b.settled).toBe(0)
    expect(screen.getByRole('heading', { name: 'B' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    await flush()
    expect(b).toEqual({ value: false, settled: 1 })
  })

  it('离开即失效：路由变化时按 false 结算并关闭', async () => {
    mount(true)
    const a = await open({ title: '确认下发', body: 'x' })
    await act(async () => { box.nav!('/b') })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('离开即失效：登出（登录态变为未登录）时按 false 结算并关闭', async () => {
    mount()
    const a = await open({ title: '确认下发', body: 'x' })
    await act(async () => { logout() })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('离开即失效：AppProvider 卸载时按 false 结算，不悬空', async () => {
    const { unmount } = mount()
    const a = await open({ title: '确认下发', body: 'x' })
    unmount()
    await new Promise((r) => setTimeout(r, 0))
    expect(a).toEqual({ value: false, settled: 1 })
  })

  it('连续确认（上一个刚结算、焦点还在它的按钮上就再次调用）：关闭后焦点回到最初的触发器', async () => {
    mount()
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.textContent = '触发器'
    trigger.focus()
    const a = await open({ title: 'A', body: 'a', okText: '确认 A' })
    await flush()
    const okA = screen.getByRole('button', { name: '确认 A' })
    okA.focus()
    let b!: ReturnType<typeof track>
    await act(async () => {
      fireEvent.click(okA)
      b = track(confirm({ title: 'B', body: 'b' })) // 调用方在 A 的结果里紧接着发起 B，此时焦点仍在 A 的「确认」上
    })
    await flush()
    expect(a.value).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    await flush()
    await flush()
    expect(b.value).toBe(false)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('路由已变（浏览器后退 / 前进已发生）、React 还没渲染和清理时点旧的「确认」：按 false 结算，调用方不下发', async () => {
    mount(true)
    let sent = 0
    let r!: ReturnType<typeof track>
    await act(async () => { r = track(confirm({ title: '确认下发', body: 'x', okText: '确认下发' }).then((ok) => { if (ok) sent++; return ok })) })
    const ok = screen.getByRole('button', { name: '确认下发' })
    // 浏览器已经换了历史条目（popstate 还没交给 React 处理），同一个同步块里点旧按钮
    window.history.pushState({ key: 'other', idx: 9 }, '', '/b')
    ok.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await flush()
    expect(r).toEqual({ value: false, settled: 1 })
    expect(sent).toBe(0)
  })

  it('已登出、React 还没处理时点旧的「确认」：按 false 结算，调用方不下发', async () => {
    mount()
    let sent = 0
    let r!: ReturnType<typeof track>
    await act(async () => { r = track(confirm({ title: '确认下发', body: 'x', okText: '确认下发' }).then((ok) => { if (ok) sent++; return ok })) })
    const ok = screen.getByRole('button', { name: '确认下发' })
    logout() // 会话已变（订阅方的渲染、effect 还没跑）
    ok.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await flush()
    expect(r).toEqual({ value: false, settled: 1 })
    expect(sent).toBe(0)
  })

  it('旧路由的延迟清理不取消新路由刚发起的确认', async () => {
    mount(true)
    let b!: ReturnType<typeof track>
    await act(async () => {
      box.nav!('/b') // 地址同步变到 /b；旧路由的 effect 清理在本次渲染提交之后才跑
      b = track(confirm({ title: '新路由上的确认', body: 'x', okText: '好' }))
    })
    await flush()
    expect(b.settled).toBe(0)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '好' })) })
    await flush()
    expect(b).toEqual({ value: true, settled: 1 })
  })

  it('控制器：cancelStale 只关所属上下文已过期的请求', async () => {
    let scope = 'r1'
    const c = createConfirmController(() => ({ route: scope, session: 's' }))
    const a = track(c.request({ title: 'A', body: '' }))
    c.cancelStale()
    await Promise.resolve()
    expect(a.settled).toBe(0)
    scope = 'r2'
    c.cancelStale()
    await Promise.resolve()
    expect(a).toEqual({ value: false, settled: 1 })
    const b = track(c.request({ title: 'B', body: '' }))
    c.cancelStale()
    c.settle(c.getState().req!.id, true, false)
    await Promise.resolve()
    expect(b).toEqual({ value: true, settled: 1 })
  })

  it('连续确认中间隔了一次异步（上一个弹窗已卸载、焦点还没还给触发器）：关闭后焦点仍回到最初的触发器', async () => {
    mount()
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.textContent = '触发器'
    trigger.focus()
    await open({ title: 'A', body: 'a', okText: '确认 A' })
    await flush()
    screen.getByRole('button', { name: '确认 A' }).focus()
    // 用同步的 act：渲染同步提交、不让出事件循环，Radix 把焦点还给触发器的 setTimeout(0) 一定还没执行（异步 act 在慢机器上可能先跑掉它）
    act(() => { fireEvent.click(screen.getByRole('button', { name: '确认 A' })) }) // A 卸载，焦点还给触发器要等下一个宏任务
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(document.body)
    let b!: ReturnType<typeof track>
    act(() => { b = track(confirm({ title: 'B', body: 'b' })) })
    await flush()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    await flush()
    await flush()
    expect(b.value).toBe(false)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('所有者：弹窗打开后当前项目变离线（页面被离线分支替换卸载）→ false，不下发，弹窗关闭', async () => {
    mountOwner()
    const r = await ownerOpen({ title: '全部开启', body: 'x', okText: '确认下发' })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    await act(async () => { box.setOffline!(true) })
    await flush()
    expect(r).toEqual({ value: false, settled: 1 })
    expect(box.sent).toBe(0)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('所有者：当前项目变化（页面按 project.id 重挂）→ false，不下发；新实例发起的确认不受旧实例清理影响', async () => {
    mountOwner(true)
    const a = await ownerOpen({ title: 'A', body: 'x', okText: '确认 A' })
    await act(async () => { box.setProject!('PRJ-10243') })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // 重挂后的新实例发起的确认：照常打开、照常结算为 true
    const b = await ownerOpen({ title: 'B', body: 'y', okText: '确认 B' })
    await flush()
    expect(b.settled).toBe(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认 B' })) })
    await flush()
    expect(b).toEqual({ value: true, settled: 1 })
    expect(box.sent).toBe(1)
  })

  it('所有者：页面不随项目重挂时，当前项目变化也让它发起的确认失效（false、关闭）', async () => {
    mountOwner(false)
    const a = await ownerOpen({ title: 'A', body: 'x', okText: '确认 A' })
    await act(async () => { box.setProject!('PRJ-10243') })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(box.sent).toBe(0)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('控制器：所有者已卸载或项目已变时 settle(true) 同步得到 false；cancelOwner 只取消自己的请求', async () => {
    const c = createConfirmController(() => ({ route: 'r', session: 's' }))
    const ownerA: ConfirmOwner = { alive: true, projectId: 'p1' }
    const ownerB: ConfirmOwner = { alive: true, projectId: 'p1' }
    const a = track(c.request({ title: 'A', body: '' }, ownerA))
    ownerA.alive = false // 卸载清理已执行，界面还没来得及关
    c.settle(c.getState().req!.id, true, false)
    const b = track(c.request({ title: 'B', body: '' }, ownerB))
    ownerB.projectId = 'p2'
    c.settle(c.getState().req!.id, true, false)
    const d = track(c.request({ title: 'D', body: '' }, { alive: true, projectId: 'p1' }))
    c.cancelOwner(ownerA) // 旧实例的清理：不动别人发起的请求
    c.cancelOwner(ownerB)
    const dId = c.getState().req!.id
    c.settle(dId, true, false)
    await Promise.resolve()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(b).toEqual({ value: false, settled: 1 })
    expect(d).toEqual({ value: true, settled: 1 })
  })

  it('边界：React Router 同路径只改 query 的导航会生成新 key → 确认失效', async () => {
    mount(true)
    const a = await open({ title: 'A', body: 'x', okText: '确认 A' })
    await act(async () => { box.nav!('/a?tab=2') })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
  })

  it('边界：脚本 replaceState 保留 key 和 pathname（只改 query / hash）检测不到，确认照常有效（已在 feedback.ts 写明）', async () => {
    mount(true)
    const a = await open({ title: 'A', body: 'x', okText: '确认 A' })
    window.history.replaceState(window.history.state, '', '/a?tab=3#x')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认 A' })) })
    await flush()
    expect(a).toEqual({ value: true, settled: 1 })
  })

  describe('失效判为 false 时不静默', () => {
    const toastText = () => document.querySelector('[data-sonner-toaster]')?.textContent ?? ''

    it('点了确认但页面已变（历史条目已变）：console.info 写明原因，并提示「页面已变化，操作已取消」', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      mount(true)
      const r = await open({ title: '确认下发统一控制指令', body: 'x', okText: '确认下发' })
      const ok = screen.getByRole('button', { name: '确认下发' })
      window.history.pushState({ key: 'other', idx: 9 }, '', '/b')
      ok.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      await flush()
      expect(r.value).toBe(false)
      expect(info).toHaveBeenCalledWith('[确认弹窗] 「确认下发统一控制指令」已失效（路由已变化），点击确认时按取消处理')
      await waitFor(() => expect(toastText()).toContain('页面已变化，操作已取消'))
      info.mockRestore()
    })

    it('发起它的页面卸载、弹窗被自动关闭：同样记录并提示', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      mountOwner()
      await ownerOpen({ title: '全部开启', body: 'x', okText: '确认下发' })
      await act(async () => { box.setOffline!(true) })
      await flush()
      expect(info).toHaveBeenCalledWith('[确认弹窗] 「全部开启」已失效（发起它的页面已卸载），已自动关闭，按取消处理')
      await waitFor(() => expect(toastText()).toContain('页面已变化，操作已取消'))
      info.mockRestore()
    })

    it('会话变化（登出）：只记录原因，不叠加「页面已变化」提示', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      mount()
      await open({ title: '确认下发', body: 'x' })
      await act(async () => { logout() })
      await flush()
      await flush()
      expect(info).toHaveBeenCalledWith('[确认弹窗] 「确认下发」已失效（登录状态已变化），已自动关闭，按取消处理')
      expect(toastText()).not.toContain('页面已变化')
      info.mockRestore()
    })

    it('会话失效导致发起页面卸载（卸载先于会话 effect）：原因记为登录状态已变化，不提示「页面已变化」', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      // 模拟 Guard：未登录时把页面换掉（页面卸载发生在 AppProvider 的会话 effect 之前）
      function Guarded() { return useApp().authed ? createElement(OwnerPage) : createElement('div', null, '登录页') }
      render(createElement(QueryClientProvider, { client: createQueryClient() }, createElement(AppProvider, null,
        createElement(BrowserRouter, null, createElement(Guarded)))))
      const r = await ownerOpen({ title: '全部开启', body: 'x', okText: '确认下发' })
      await act(async () => { logout() })
      await flush()
      await flush()
      expect(r).toEqual({ value: false, settled: 1 })
      expect(info).toHaveBeenCalledWith('[确认弹窗] 「全部开启」已失效（登录状态已变化），已自动关闭，按取消处理')
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('发起它的页面已卸载'))
      expect(document.querySelector('[data-sonner-toaster]')?.textContent ?? '').not.toContain('页面已变化')
      info.mockRestore()
    })

    it('正常取消 / Esc / Provider 卸载：不记录、不提示', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const { unmount } = mount()
      await open({ title: 'A', body: 'a' })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
      await open({ title: 'B', body: 'b' })
      unmount()
      await flush()
      expect(info).not.toHaveBeenCalled()
      info.mockRestore()
    })
  })

  it('项目已切换（setProjectId 已同步写入存储）、React 还没提交时点旧的「确认」：false，不下发', async () => {
    mountOwner(false)
    const r = await ownerOpen({ title: '全部开启', body: 'x', okText: '确认下发' })
    const ok = screen.getByRole('button', { name: '确认下发' })
    // 同一个同步块里：切换当前项目（只写了外部存储，React 尚未提交，所有者的 projectId 还是旧的），紧接着点旧按钮
    box.setProject!('PRJ-10243')
    ok.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await flush()
    expect(r).toEqual({ value: false, settled: 1 })
    expect(box.sent).toBe(0)
  })

  it('真实 StrictMode：挂载 effect 里发起确认 —— 模拟卸载那一次按 false 结算且不提示，重新挂载后发起的照常可确认', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const results: boolean[] = []
    function MountConfirm() {
      const confirm = useConfirm()
      useEffect(() => {
        void confirm({ title: '挂载时确认', body: 'x', okText: '好' }).then((ok) => { results.push(ok); if (ok) box.sent++ })
      }, [confirm])
      return null
    }
    // 页面在应用挂载之后才出现（同路由切换后新页面挂载）：StrictMode 只对这棵新子树做“模拟卸载 → 重新挂载”，走所有者的卸载清理
    let show!: (v: boolean) => void
    function Host() {
      const [v, setV] = useState(false)
      useEffect(() => { show = setV }, [])
      return v ? createElement(MountConfirm) : null
    }
    render(createElement(StrictMode, null, createElement(QueryClientProvider, { client: createQueryClient() },
      createElement(AppProvider, null, createElement(BrowserRouter, null, createElement(Host))))))
    await flush()
    await act(async () => { show(true) })
    await flush()
    await flush()
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '好' })) })
    await flush()
    // 第一次挂载发起的那个（被 StrictMode 的模拟卸载结算）是 false，重新挂载后发起的是 true，只下发一次
    expect(results).toEqual([false, true])
    expect(box.sent).toBe(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(info).not.toHaveBeenCalled()
    expect(document.querySelector('[data-sonner-toaster]')?.textContent ?? '').not.toContain('页面已变化')
    info.mockRestore()
  })
})
