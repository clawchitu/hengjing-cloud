// @vitest-environment jsdom
// 下发写锁（writeLock.ts）：按控制屏互斥与退回规则、原写未结算不放锁、结果未知核对一致才放、核对不一致 / 失败保持、
// 换账号核对按失败、截止不放锁、订阅通知、模块级跨卸载。不发任何真实请求。
import { act, cleanup, render } from '@testing-library/react'
import { createElement, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../config'
import { __resetHttpForTests } from '../http'
import { __resetSessionForTests, signIn, signOut } from '../session'
import { clearTokens } from '../tokens'
import {
  __resetWriteLockForTests, acquire, currentAccount, isHolder, lockKeyOf, lockOf, lockVersion, markOverdue, markSent, release,
  requireVerify, settle, subscribe, verify, type LockToken,
} from '../writeLock'
import { fakeBackend, json } from './helpers'

/** 两个测试项目共用一块控制屏 */
const PA = { id: 'pa', controlScreenId: 'SCREEN-1' }
const PB = { id: 'pb', controlScreenId: 'SCREEN-1' }
const PC = { id: 'pc', controlScreenId: 'SCREEN-2' }

let account = 'user:A#1'
const gate = () => { let open = () => {}; let fail = () => {}; const p = new Promise<void>((r, j) => { open = r; fail = () => j(new Error('x')) }); return { p, open, fail } }
const flush = () => new Promise((r) => setTimeout(r, 0))
const take = (t = PA): LockToken => { const r = acquire(t, '客厅'); if (!r.ok) throw new Error('busy'); return r.token }
/** 走到 unknown：发出（Promise 由 g 控制）并定为结果未知 */
function toUnknown(g = gate(), fn: (s: AbortSignal) => Promise<boolean> = async () => true) {
  const t = take()
  markSent(t, g.p)
  settle(t, 'unknown')
  requireVerify(t, fn)
  return { t, g }
}

beforeEach(() => { account = 'user:A#1'; __resetWriteLockForTests(() => account) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('锁键：控制屏 → DTU → 项目 id', () => {
  it('退回规则', () => {
    expect(lockKeyOf({ id: 'p', controlScreenId: 'S1', dtuId: 'D1' })).toBe('screen:S1')
    expect(lockKeyOf({ id: 'p', dtuId: 'D1' })).toBe('dtu:D1')
    expect(lockKeyOf({ id: 'p', controlScreenId: '  ', dtuId: 'D1' })).toBe('dtu:D1')
    expect(lockKeyOf({ id: 'p' })).toBe('project:p')
    expect(lockKeyOf({ id: 'p', controlScreenId: '', dtuId: '' })).toBe('project:p')
  })
})

describe('互斥', () => {
  it('两个项目同一块屏：第二个 busy（带当前锁信息）；不同屏互不影响', () => {
    take(PA)
    const b = acquire(PB, '全部开启')
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.busy).toMatchObject({ key: 'screen:SCREEN-1', projectId: 'pa', label: '客厅', phase: 'held', mine: true })
    expect(acquire(PC).ok).toBe(true)
    expect(lockOf(PB)?.projectId).toBe('pa') // 按屏查：同屏项目看得到这把锁
  })

  it('isHolder（给 beforeSend 用的同步复核）：持锁且未发出、账号没变才为 true；旧 token 无效', () => {
    const t = take()
    expect(isHolder(t)).toBe(true)
    account = 'user:B#2'
    expect(isHolder(t)).toBe(false)
    account = 'user:A#1'
    expect(release(t)).toBe(true)
    expect(isHolder(t)).toBe(false)
    const t2 = take()
    expect(isHolder(t)).toBe(false) // 同一锁键的新锁，旧 token 不算
    markSent(t2, new Promise(() => {}))
    expect(isHolder(t2)).toBe(false) // 已发出
  })
})

describe('原写未结算不放锁', () => {
  it('settle ok / fail 早于原 Promise 结算：保持，结算后才释放', async () => {
    for (const outcome of ['ok', 'fail'] as const) {
      const g = gate()
      const t = take()
      markSent(t, g.p)
      settle(t, outcome)
      await flush()
      expect(lockOf(PA)).toMatchObject({ phase: 'sending', sendSettled: false, outcome })
      expect(acquire(PB).ok).toBe(false)
      expect(release(t)).toBe(false)
      if (outcome === 'ok') g.open(); else g.fail()
      await flush(); await flush()
      expect(lockOf(PA)).toBeNull()
    }
  })

  it('原 Promise 先结算、后 settle ok：settle 时释放', async () => {
    const t = take()
    markSent(t, Promise.resolve())
    await flush(); await flush()
    expect(lockOf(PA)).toMatchObject({ sendSettled: true, phase: 'sending' })
    settle(t, 'ok')
    expect(lockOf(PA)).toBeNull()
  })

  it('还没发出就 settle / release：直接释放', () => {
    settle(take(), 'fail')
    expect(lockOf(PA)).toBeNull()
    expect(release(take())).toBe(true)
  })
})

describe('结果未知：核对一致才放', () => {
  it('一致且原写已结算 → 释放', async () => {
    const { g } = toUnknown()
    g.open(); await flush(); await flush()
    expect(await verify('screen:SCREEN-1')).toBe('released')
    expect(lockOf(PA)).toBeNull()
  })

  it('核对不一致 / 读取失败：保持，可以再核对', async () => {
    let mode: 'mismatch' | 'throw' | 'ok' = 'mismatch'
    const { g } = toUnknown(gate(), async () => { if (mode === 'throw') throw new Error('503'); return mode === 'ok' })
    g.open(); await flush(); await flush()
    expect(await verify('screen:SCREEN-1')).toBe('mismatch')
    mode = 'throw'
    expect(await verify('screen:SCREEN-1')).toBe('failed')
    expect(lockOf(PA)?.phase).toBe('unknown')
    mode = 'ok'
    expect(await verify('screen:SCREEN-1')).toBe('released')
  })

  it('一致但原写还没结算：不放（send-pending）；原写迟到结算后再核对才放', async () => {
    const { g } = toUnknown()
    expect(await verify('screen:SCREEN-1')).toBe('send-pending')
    expect(lockOf(PA)?.phase).toBe('unknown')
    g.open(); await flush(); await flush()
    expect(lockOf(PA)?.phase).toBe('unknown') // 结算本身不放：结论是 unknown，仍要核对
    expect(await verify('screen:SCREEN-1')).toBe('released')
  })

  it('release 在 unknown 时被拒；没有登记核对函数时 verify 不做事', async () => {
    const t = take()
    markSent(t, Promise.resolve())
    settle(t, 'unknown')
    await flush(); await flush()
    expect(release(t)).toBe(false)
    expect(await verify('screen:SCREEN-1')).toBe('none')
    expect(lockOf(PA)?.verifiable).toBe(false)
  })
})

describe('截止时间只改标记', () => {
  it('markOverdue 不放锁', async () => {
    const t = take()
    markSent(t, new Promise(() => {}))
    markOverdue(t)
    settle(t, 'unknown')
    expect(lockOf(PA)).toMatchObject({ overdue: true, phase: 'unknown' })
    expect(acquire(PB).ok).toBe(false)
  })
})

describe('核对绑定账号', () => {
  it('账号变了：不调核对函数、不解锁（account-changed）；新账号看到 mine=false', async () => {
    const fn = vi.fn(async () => true)
    const { g } = toUnknown(gate(), fn)
    g.open(); await flush(); await flush()
    account = 'user:B#2'
    expect(await verify('screen:SCREEN-1')).toBe('account-changed')
    expect(fn).not.toHaveBeenCalled()
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', mine: false })
  })

  it('读取途中换账号：结果作废，不解锁', async () => {
    const { g } = toUnknown(gate(), async () => { account = 'user:A#3'; return true }) // 同号重登也换代
    g.open(); await flush(); await flush()
    expect(await verify('screen:SCREEN-1')).toBe('account-changed')
    expect(lockOf(PA)?.phase).toBe('unknown')
  })

  it('默认账号来源是 api/session：退出后代次变化，核对按 account-changed', async () => {
    __resetWriteLockForTests()
    setConfig({ apiBase: '/api', dataSource: 'real' })
    __resetHttpForTests(); __resetSessionForTests(); clearTokens()
    __resetWriteLockForTests()
    fakeBackend({
      '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
      '/me': () => json({ user_entity: { id: 'u1', name: '甲' } }),
      '/auth/invalidate': () => json({}),
    })
    await signIn('a', 'pw', true)
    const before = currentAccount()
    expect(before).toMatch(/^u1#/)
    const { g } = toUnknown()
    g.open(); await flush(); await flush()
    const notes: number[] = []
    const off = subscribe(() => notes.push(lockVersion()))
    await signOut()
    expect(currentAccount()).not.toBe(before)
    expect(notes.length).toBeGreaterThan(0) // 账号变化会通知订阅者（mine 可能变化）
    expect(lockOf(PA)?.mine).toBe(false)
    await signIn('a', 'pw', true) // 同号重登：仍不是发起时那次会话
    expect(currentAccount()).not.toBe(before)
    expect(await verify('screen:SCREEN-1')).toBe('account-changed')
    off()
    setConfig(null)
  })
})

describe('订阅与模块级', () => {
  it('每次状态变化都通知订阅者', async () => {
    const seen: number[] = []
    const off = subscribe(() => seen.push(lockVersion()))
    const g = gate()
    const t = take()
    markSent(t, g.p)
    settle(t, 'ok')
    g.open(); await flush(); await flush()
    expect(seen.length).toBeGreaterThanOrEqual(4) // acquire、markSent、settle、结算 / 释放
    off()
    take(PC)
    expect(seen.length).toBeLessThan(10)
  })

  it('订阅者抛错不影响锁', () => {
    const off = subscribe(() => { throw new Error('坏了') })
    take()
    expect(lockOf(PA)?.phase).toBe('held')
    off()
  })

  it('组件卸载再挂载：锁仍在（模块级），页面能显示常驻锁提示', () => {
    function Banner() {
      useSyncExternalStore(subscribe, lockVersion, lockVersion)
      const l = lockOf(PB)
      return createElement('div', { 'data-testid': 'b' }, l ? `锁：${l.label} ${l.phase}` : '无锁')
    }
    const first = render(createElement(Banner))
    expect(first.getByTestId('b').textContent).toBe('无锁')
    let t!: LockToken
    act(() => { t = take() })
    expect(first.getByTestId('b').textContent).toBe('锁：客厅 held')
    first.unmount()
    act(() => { markSent(t, new Promise(() => {})); settle(t, 'unknown') })
    const second = render(createElement(Banner))
    expect(second.getByTestId('b').textContent).toBe('锁：客厅 unknown')
  })
})
