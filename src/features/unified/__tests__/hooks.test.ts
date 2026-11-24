// @vitest-environment jsdom
// useUnifiedControl 走真实 React 渲染（StrictMode）。全部用注入的假函数，不连任何后端。
import { StrictMode, createElement, useLayoutEffect, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TEXT } from '../constants'
import { useUnifiedControl, type UseUnifiedControlOptions } from '../hooks'
import type { UnifiedContext } from '../rules'

const CTX: UnifiedContext = { projectId: 'p-test-0829-000001', projectCode: '240829001', appCode: 1, online: true }
const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children)

function deferred<V>() {
  let resolve!: (v: V) => void
  const promise = new Promise<V>((r) => { resolve = r })
  return { promise, resolve }
}

function opts(over: Partial<UseUnifiedControlOptions<number>> = {}): UseUnifiedControlOptions<number> {
  return {
    context: CTX,
    readBack: vi.fn(async () => 1),
    toEcho: () => ({ roomSwitch: 1 }),
    send: vi.fn(async () => ({ success: true, msg: '' })),
    log: () => {},
    ...over,
  }
}

describe('useUnifiedControl（StrictMode）', () => {
  it('正常流程只下发一次', async () => {
    const o = opts()
    const { result } = renderHook(() => useUnifiedControl(o), { wrapper })
    act(() => { result.current.request({ roomSwitch: 1 }) })
    expect(result.current.state.status).toBe('confirming')
    await act(async () => { await result.current.confirm() })
    expect(result.current.state).toMatchObject({ status: 'success', via: 'reply' })
    expect(o.send).toHaveBeenCalledTimes(1)
  })

  it('前读完成前卸载 → 不下发', async () => {
    const gate = deferred<number>()
    const o = opts({ readBack: vi.fn(() => gate.promise) })
    const { result, unmount } = renderHook(() => useUnifiedControl(o), { wrapper })
    act(() => { result.current.request({ roomSwitch: 1 }) })
    let p!: Promise<unknown>
    act(() => { p = result.current.confirm() })
    expect(result.current.state).toMatchObject({ status: 'sending', step: 'read-before' })
    unmount()
    gate.resolve(1)
    await p
    expect(o.send).not.toHaveBeenCalled()
  })

  it('卸载时同步取消（layout effect 清理）：同一次卸载提交里、被动 effect 清理之前，取消就已生效', async () => {
    // 同一组件里后声明的 layout effect 清理在 hook 的清理之后、所有被动 effect 清理之前执行。
    // 在这个时刻让前读完成：如果取消放在 useEffect 清理里，这里还没取消，前读完成后就会下发
    const gate = deferred<number>()
    const logs: string[] = []
    const send = vi.fn(async () => ({ success: true, msg: '' }))
    let unmounting = false
    let abortedAtLayoutCleanup: boolean | null = null
    const o = opts({ readBack: vi.fn(() => gate.promise), send, log: (e) => logs.push(e.event) })
    const { result, unmount } = renderHook(() => {
      const c = useUnifiedControl(o)
      useLayoutEffect(() => () => {
        if (!unmounting) return
        abortedAtLayoutCleanup = logs.includes('aborted')
        gate.resolve(1)
      }, [])
      return c
    }, { wrapper })
    act(() => { result.current.request({ roomSwitch: 1 }) })
    let p!: Promise<unknown>
    act(() => { p = result.current.confirm() })
    unmounting = true
    unmount()
    await p
    expect(abortedAtLayoutCleanup).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('前读完成前切换项目 → 回 idle，不下发', async () => {
    const gate = deferred<number>()
    const readBack = vi.fn(() => gate.promise)
    const send = vi.fn(async () => ({ success: true, msg: '' }))
    const { result, rerender } = renderHook((p: { ctx: UnifiedContext }) => useUnifiedControl(opts({ context: p.ctx, readBack, send })), { wrapper, initialProps: { ctx: CTX } })
    act(() => { result.current.request({ roomSwitch: 1 }) })
    let p!: Promise<unknown>
    act(() => { p = result.current.confirm() })
    rerender({ ctx: { ...CTX, projectId: 'p-test-0911-000001', projectCode: '260911001' } })
    expect(result.current.state).toEqual({ status: 'idle', errors: [TEXT.aborted] })
    await act(async () => { gate.resolve(1); await p })
    expect(send).not.toHaveBeenCalled()
  })

  it('同一项目重渲染不终止', async () => {
    const send = vi.fn(async () => ({ success: true, msg: '' }))
    const { result, rerender } = renderHook((p: { ctx: UnifiedContext }) => useUnifiedControl(opts({ context: p.ctx, send })), { wrapper, initialProps: { ctx: CTX } })
    act(() => { result.current.request({ roomSwitch: 1 }) })
    rerender({ ctx: { ...CTX } })
    await act(async () => { await result.current.confirm() })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
