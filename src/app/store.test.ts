// @vitest-environment jsdom
// confirm() 的 Promise 约定（S9 / S10 / S12 的下发都靠它）：确认 true、取消 / Esc false、
// 打开中再次调用时前一个按取消结算（不悬空）、同一弹窗只结算一次。演示数据模式，不连任何后端。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createQueryClient } from '../api/query'
import { AppProvider, useApp } from './store'

type Confirm = ReturnType<typeof useApp>['confirm']

function mount() {
  const box: { confirm?: Confirm } = {}
  function Probe() {
    const { confirm } = useApp()
    useEffect(() => { box.confirm = confirm }, [confirm])
    return null
  }
  render(createElement(QueryClientProvider, { client: createQueryClient() }, createElement(AppProvider, null, createElement(Probe))))
  return () => box.confirm!
}
/** 记录 Promise 结算情况，便于断言“还没结算” */
function track(p: Promise<boolean>) {
  const r: { value?: boolean; settled: number } = { settled: 0 }
  void p.then((v) => { r.value = v; r.settled++ })
  return r
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

afterEach(() => cleanup())

describe('confirm()', () => {
  it('点「确认」→ true；连点两次只结算一次', async () => {
    const get = mount()
    let r!: ReturnType<typeof track>
    await act(async () => { r = track(get()({ title: '确认下发', body: '正文', okText: '确认下发' })) })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '确认下发' })).toBeTruthy()
    const ok = screen.getByRole('button', { name: '确认下发' })
    await act(async () => { fireEvent.click(ok); fireEvent.click(ok) })
    await flush()
    expect(r).toEqual({ value: true, settled: 1 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('点「取消」→ false；Esc → false', async () => {
    const get = mount()
    let a!: ReturnType<typeof track>
    await act(async () => { a = track(get()({ title: 'A', body: 'a' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    let b!: ReturnType<typeof track>
    await act(async () => { b = track(get()({ title: 'B', body: 'b' })) })
    await act(async () => { fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' }) })
    await flush()
    expect(b).toEqual({ value: false, settled: 1 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('打开中再次调用：前一个按取消结算，弹窗换成新内容；新的照常结算', async () => {
    const get = mount()
    let a!: ReturnType<typeof track>, b!: ReturnType<typeof track>
    await act(async () => { a = track(get()({ title: '第一个', body: '1' })) })
    await act(async () => { b = track(get()({ title: '第二个', body: '2', okText: '好' })) })
    await flush()
    expect(a).toEqual({ value: false, settled: 1 })
    expect(b.settled).toBe(0)
    expect(screen.queryByRole('heading', { name: '第一个' })).toBeNull()
    expect(screen.getByRole('heading', { name: '第二个' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '好' })) })
    await flush()
    expect(b).toEqual({ value: true, settled: 1 })
    expect(a.settled).toBe(1)
  })
})
