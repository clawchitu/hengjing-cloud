// @vitest-environment jsdom
// confirm() 的 Promise 约定（S9 / S10 / S12 的下发都靠它，见 app/feedback.ts）：确认 true、取消 / Esc false；
// 打开中再次调用时前一个按取消结算；按钮只结算自己渲染出来的那次请求；离开（路由变化、登出、Provider 卸载）即按 false 结算；
// 连续确认时焦点回到最初的触发器。演示数据模式，不连任何后端。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, useEffect } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setConfig } from '../api/config'
import { createQueryClient } from '../api/query'
import { __resetSessionViewForTests, logout, mockSignIn } from '../data/session'
import { AppProvider, useApp } from './store'
import { createConfirmController, useCancelConfirmOnLeave } from './feedback'

type Confirm = ReturnType<typeof useApp>['confirm']
const box: { confirm?: Confirm; nav?: (to: string) => void } = {}

function Probe() {
  const { confirm } = useApp()
  useEffect(() => { box.confirm = confirm }, [confirm])
  return null
}
/** 模拟 Layout：在 Router 里调用离开即失效的桥接 */
function RoutedProbe() {
  useCancelConfirmOnLeave()
  const nav = useNavigate()
  useEffect(() => { box.nav = nav }, [nav])
  return createElement(Probe)
}
function mount(routed = false) {
  const inner = routed
    ? createElement(BrowserRouter, null, createElement(Routes, null,
      createElement(Route, { path: '/a', element: createElement(RoutedProbe) }),
      createElement(Route, { path: '/b', element: createElement(RoutedProbe) })))
    : createElement(Probe)
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
  __resetSessionViewForTests()
  mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
})
afterEach(() => { cleanup(); setConfig(null); box.confirm = undefined; box.nav = undefined })

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
    const c = createConfirmController(() => scope)
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认 A' })) }) // A 卸载，焦点还给触发器要等下一个宏任务
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(document.body)
    const b = await open({ title: 'B', body: 'b' })
    await flush()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    await flush()
    await flush()
    expect(b.value).toBe(false)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
