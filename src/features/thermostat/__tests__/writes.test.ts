// @vitest-environment jsdom
// 温控下发流程（writes.ts）接共用写锁（src/api/writeLock.ts）：取锁 → 预检 → 认领 → 发送（markSent + 核对函数）→ settle →
// 回读。写锁用真的；会话与当前项目用可控的假实现。不发任何请求。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'

let userKey: string | null = 'user:A'
let storedProject = 'P1'
vi.mock('@/data/session', () => ({ getSessionView: () => ({ userKey }) }))
vi.mock('@/api/session', () => ({ subscribeSession: () => () => {}, getSession: () => ({ status: 'authed', info: { user: { id: 'u1' } } }) }))
vi.mock('@/data/org/current', () => ({ getStoredProjectId: () => storedProject }))

const W = await import('../writes')
const L = await import('@/api/writeLock')

const P1 = { id: 'P1', controlScreenId: 'S1' }
const P2 = { id: 'P2', controlScreenId: 'S1' } // 同一块屏
const REC = { msg: 201, deviceId: 7, target: { temperature: 26, eco: -1, switch: -1 } }

type Spec = Parameters<typeof W.runOp<number, number>>[0]
function spec(o: Partial<Spec> = {}) {
  const calls: string[] = []
  const toasts: string[] = []
  let readValue = 26
  const s: Spec = {
    project: P1, target: 'R1', subject: '客厅', okText: '客厅 已下发',
    preflight: async () => { calls.push('preflight'); return { ok: true, payload: 26 } },
    send: async () => { calls.push('send') },
    record: () => REC,
    read: async () => { calls.push('read'); return readValue },
    matches: (p, v) => p === v,
    present: () => true,
    toast: (t) => { toasts.push(t) },
    ...o,
  }
  return { s, calls, toasts, setRead: (v: number) => { readValue = v } }
}
const gate = () => { let open = () => {}; let fail = (_e?: unknown) => {}; const p = new Promise<void>((r, j) => { open = r; fail = (e) => j(e ?? new Error('x')) }); return { p, open, fail } }
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

beforeEach(() => {
  userKey = 'user:A'; storedProject = 'P1'
  localStorage.clear()
  W.__resetWritesForTests()
  L.__resetWriteLockForTests(() => ({ user: 'u1', gen: 1 }))
  L.configureWriteLock({ resolveProject: (id) => (id === 'P1' ? P1 : id === 'P2' ? P2 : null) })
})
afterEach(() => { vi.useRealTimers() })

describe('正常路径', () => {
  it('取锁 → 预检 → 认领 → 发送（登记原写与核对数据）→ ok → 回读；结束后写锁释放、提示成功', async () => {
    const g = gate()
    let atSend: unknown
    const { s, calls, toasts } = spec({ send: async () => { atSend = L.lockOf(P1); calls.push('send'); await g.p } })
    const run = W.runOp(s)
    await flush()
    expect(atSend).toMatchObject({ phase: 'sent', label: '客厅' }) // 发送时已认领
    expect(W.runningOf('P1')?.stage).toBe('sending')
    expect(JSON.parse(localStorage.getItem(L.STORAGE_PREFIX + 'screen:S1')!)).toMatchObject({ msg: 201, deviceId: 7 }) // markSent 落盘
    g.open()
    expect(await run).toBe('ok')
    expect(calls).toEqual(['preflight', 'send', 'read'])
    expect(L.lockOf(P1)).toBeNull()
    expect(W.runningOf('P1')).toBeNull()
    expect(toasts).toEqual(['客厅 已下发'])
    expect(localStorage.getItem(L.STORAGE_PREFIX + 'screen:S1')).toBeNull()
  })

  it('同一块屏已被锁（另一个项目在下发）：busy，不调任何回调', async () => {
    const g = gate()
    const a = spec({ project: P2, send: async () => { await g.p } })
    const run = W.runOp(a.s)
    await flush()
    const b = spec()
    expect(await W.runOp(b.s)).toBe('busy')
    expect(b.calls).toEqual([])
    g.open(); await run
  })
})

describe('预检', () => {
  it('不一致 / 抛错 / 超时：不写、释放写锁、提示重新核对', async () => {
    for (const preflight of [
      async () => ({ ok: false as const, reason: '房间已关闭' }),
      async () => { throw new ApiError('unavailable', '控制屏未连接') },
      () => new Promise<never>(() => {}),
    ]) {
      W.LIMITS.preflightMs = 20
      const { s, calls, toasts } = spec({ preflight })
      expect(await W.runOp(s)).toBe('aborted')
      expect(calls).toEqual([])
      expect(L.lockOf(P1)).toBeNull()
      expect(toasts[0]).toMatch(/本次未下发，请重新核对/)
    }
  })
  it('预检期间离开页面 / 切项目 / 会话变化：中止，不写，不提示，释放写锁', async () => {
    for (const change of [() => { storedProject = 'P2' }, () => { userKey = 'user:B' }]) {
      W.__resetWritesForTests(); storedProject = 'P1'; userKey = 'user:A'
      const { s, calls, toasts } = spec({ preflight: async () => { change(); return { ok: true, payload: 26 } } })
      expect(await W.runOp(s)).toBe('aborted')
      expect(calls).toEqual([])
      expect(toasts).toEqual([])
      expect(L.lockOf(P1)).toBeNull()
    }
    let here = true
    const left = spec({ present: () => here, preflight: async () => { here = false; return { ok: true, payload: 26 } } })
    expect(await W.runOp(left.s)).toBe('aborted')
    expect(left.calls).toEqual([])
    expect(L.lockOf(P1)).toBeNull()
  })
  it('认领失败（发送前账号变了）：不写，释放写锁', async () => {
    let acct = { user: 'u1', gen: 1 }
    L.__resetWriteLockForTests(() => acct)
    L.configureWriteLock({ resolveProject: () => P1 })
    const { s, calls } = spec({ preflight: async () => { acct = { user: 'u1', gen: 2 }; return { ok: true, payload: 26 } } })
    expect(await W.runOp(s)).toBe('aborted')
    expect(calls).toEqual([])
    expect(L.lockOf(P1)).toBeNull()
  })
})

describe('发送结果', () => {
  it('确定失败（success=false）：写锁释放；写防护拦截（没发出去）不回读', async () => {
    const f = spec({ send: async () => { throw new ApiError('ctrl', '控制屏拒绝') } })
    expect(await W.runOp(f.s)).toBe('fail')
    expect(f.calls).toEqual(['preflight', 'read'])
    expect(L.lockOf(P1)).toBeNull()
    expect(f.toasts[0]).toBe('客厅 下发失败：控制屏拒绝')
    const b = spec({ send: async () => { throw new ApiError('write_blocked', '名单外') } })
    expect(await W.runOp(b.s)).toBe('fail')
    expect(b.calls).toEqual(['preflight'])
    expect(L.lockOf(P1)).toBeNull()
    expect(W.getResult('P1', 'R1')).toMatchObject({ outcome: 'fail', text: '未下发：名单外' })
  })

  it('结果未知（500）：写锁进入 unknown 并自动核对；读数一致 → 解锁，结果记为一致', async () => {
    const { s, toasts } = spec({ send: async () => { throw new ApiError('server', '内部错误') } })
    expect(await W.runOp(s)).toBe('unknown')
    expect(toasts[0]).toBe('客厅 下发结果未知：内部错误')
    await flush()
    expect(L.lockOf(P1)).toBeNull()
    expect(W.getResult('P1', 'R1')).toMatchObject({ outcome: 'unknown', readback: 'ok', matched: true })
  })

  it('结果未知且读数不一致：写锁保持 unknown，结果记为不一致', async () => {
    const x = spec({ send: async () => { throw new ApiError('timeout', '未收到控制屏应答') } })
    x.setRead(25)
    expect(await W.runOp(x.s)).toBe('unknown')
    await flush()
    expect(L.lockOf(P1)?.phase).toBe('unknown')
    expect(W.getResult('P1', 'R1')).toMatchObject({ readback: 'ok', matched: false })
    expect(await W.runOp(spec().s)).toBe('busy')
  })

  it('等应答到期：标记超期、结果未知（等原写结束）；原写迟到成功 → 写锁放开', async () => {
    W.LIMITS.writeDeadlineMs = 20
    const g = gate()
    const { s } = spec({ send: async () => { await g.p } })
    expect(await W.runOp(s)).toBe('unknown')
    expect(L.lockOf(P1)).toMatchObject({ phase: 'unknown', overdue: true, sendSettled: false })
    expect(W.getResult('P1', 'R1')).toMatchObject({ outcome: 'unknown', readback: 'waiting' })
    g.open(); await flush()
    expect(L.lockOf(P1)).toBeNull()
  })

  it('send 同步抛错：按结果未知交给写锁（已认领）', async () => {
    const { s } = spec({ send: () => { throw new TypeError('坏了') } })
    expect(await W.runOp(s)).toBe('unknown')
    await flush()
    expect(L.lockOf(P1)).toBeNull() // 读数一致，核对后解锁
  })
})

describe('展示隔离', () => {
  it('写的过程中会话变了：不提示、不回读，新会话看不到结果', async () => {
    const g = gate()
    const { s, calls, toasts } = spec({ send: async () => { await g.p } })
    const run = W.runOp(s)
    await flush()
    userKey = 'user:B'
    g.open()
    expect(await run).toBe('ok')
    expect(calls).toEqual(['preflight']) // 没有回读（send 用的是自定义实现，不计入）
    expect(toasts).toEqual([])
    expect(W.getResult('P1', 'R1')).toBeNull()
  })
  it('完成时已切到别的项目：不提示，结果留给原项目', async () => {
    const g = gate()
    const { s, toasts } = spec({ send: async () => { await g.p } })
    const run = W.runOp(s)
    await flush()
    storedProject = 'P2'
    g.open()
    await run
    expect(toasts).toEqual([])
    expect(W.getResult('P1', 'R1')).toMatchObject({ outcome: 'ok', text: '客厅 已下发' })
  })
  it('提示回调抛异常：流程照常收尾、写锁释放', async () => {
    const { s } = spec({ toast: () => { throw new Error('toast 坏了') } })
    expect(await W.runOp(s)).toBe('ok')
    expect(L.lockOf(P1)).toBeNull()
  })
  it('渲染期间读取会话标识不通知订阅者（只读）', () => {
    const v = W.__versionForTests()
    userKey = 'user:C'
    W.currentSessionKey()
    expect(W.__versionForTests()).toBe(v)
  })
})
