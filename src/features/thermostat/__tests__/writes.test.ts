// 下发状态机（writes.ts）：preflight → sending → verifying → done | unknown-locked 的每条边。
// 会话与当前项目用可控的假实现，不发任何请求。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'

let userKey: string | null = 'user:A'
let storedProject = 'P1'
vi.mock('@/data/session', () => ({ getSessionView: () => ({ userKey }) }))
vi.mock('@/api/session', () => ({ subscribeSession: () => () => {} }))
vi.mock('@/data/org/current', () => ({ getStoredProjectId: () => storedProject }))

const W = await import('../writes')

type Spec = Parameters<typeof W.runOp<number>>[0]
function spec(o: Partial<Spec> = {}) {
  const calls: string[] = []
  const toasts: string[] = []
  const s: Spec = {
    projectId: 'P1', target: 'R1', subject: '客厅', okText: '客厅 已下发',
    preflight: async () => { calls.push('preflight'); return { ok: true, payload: 1 } },
    send: async () => { calls.push('send') },
    verify: async () => { calls.push('verify') },
    present: () => true,
    toast: (t) => { toasts.push(t) },
    ...o,
  }
  return { s, calls, toasts }
}
const gate = () => { let open = () => {}; const p = new Promise<void>((r) => { open = r }); return { p, open } }
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { userKey = 'user:A'; storedProject = 'P1'; W.__resetWritesForTests() })
afterEach(() => { vi.useRealTimers() })

describe('正常路径', () => {
  it('preflight → sending → verifying → done：按顺序调用，阶段可见，结束释放锁并提示成功', async () => {
    const g = gate()
    const phases: (string | undefined)[] = []
    const { s, calls, toasts } = spec({ send: async () => { phases.push(W.lockOf('P1')?.phase); calls.push('send'); await g.p } })
    const run = W.runOp(s)
    await tick()
    expect(W.lockOf('P1')?.phase).toBe('sending')
    g.open()
    expect(await run).toBe('ok')
    expect(calls).toEqual(['preflight', 'send', 'verify'])
    expect(phases).toEqual(['sending'])
    expect(W.lockOf('P1')).toBeNull()
    expect(toasts).toEqual(['客厅 已下发'])
  })

  it('同一项目已持锁：第二个操作直接 busy，不调任何回调；别的项目不受影响', async () => {
    const g = gate()
    const a = spec({ send: async () => { await g.p } })
    const run = W.runOp(a.s)
    await tick()
    const b = spec()
    expect(await W.runOp(b.s)).toBe('busy')
    expect(b.calls).toEqual([])
    storedProject = '' // 还没选过当前项目：任何项目都算当前
    expect(await W.runOp(spec({ projectId: 'P2' }).s)).toBe('ok')
    g.open(); await run
  })
})

describe('preflight', () => {
  it('不一致 / 读取失败 / 抛错 / 超时：不写、释放锁、提示重新核对', async () => {
    for (const preflight of [
      async () => ({ ok: false as const, reason: '房间已关闭' }),
      async () => { throw new ApiError('unavailable', '控制屏未连接') },
      () => new Promise<never>(() => {}),
    ]) {
      W.LIMITS.preflightMs = 20
      const { s, calls, toasts } = spec({ preflight })
      expect(await W.runOp(s)).toBe('aborted')
      expect(calls).toEqual([])
      expect(W.lockOf('P1')).toBeNull()
      expect(toasts[0]).toMatch(/本次未下发，请重新核对/)
    }
  })

  it('预检期间离开页面 / 切项目 / 会话变化：中止，不写，不提示', async () => {
    for (const change of [() => { storedProject = 'P2' }, () => { userKey = 'user:B' }, () => { userKey = null }]) {
      W.__resetWritesForTests(); storedProject = 'P1'; userKey = 'user:A'
      const { s, calls, toasts } = spec({ preflight: async () => { change(); return { ok: true, payload: 1 } } })
      expect(await W.runOp(s)).toBe('aborted')
      expect(calls).toEqual([])
      expect(toasts).toEqual([])
      expect(W.lockOf('P1')).toBeNull()
    }
    let here = true
    const left = spec({ present: () => here, preflight: async () => { here = false; return { ok: true, payload: 1 } } })
    expect(await W.runOp(left.s)).toBe('aborted')
    expect(left.calls).toEqual([])
  })

  it('同账号重新登录（代次变化）也算会话变化', async () => {
    const { s, calls } = spec({ preflight: async () => { userKey = null; W.currentSessionKey(); userKey = 'user:A'; return { ok: true, payload: 1 } } })
    expect(await W.runOp(s)).toBe('aborted')
    expect(calls).toEqual([])
  })
})

describe('sending', () => {
  it('确定失败（success=false、写防护）：不进 unknown；写防护不回读', async () => {
    const f = spec({ send: async () => { throw new ApiError('ctrl', '控制屏拒绝') } })
    expect(await W.runOp(f.s)).toBe('fail')
    expect(f.calls).toEqual(['preflight', 'verify'])
    expect(W.lockOf('P1')).toBeNull()
    expect(f.toasts[0]).toBe('客厅 下发失败：控制屏拒绝')
    const b = spec({ send: async () => { throw new ApiError('write_blocked', '名单外') } })
    expect(await W.runOp(b.s)).toBe('fail')
    expect(b.calls).toEqual(['preflight'])
    expect(W.getResult('P1', 'R1')).toMatchObject({ outcome: 'fail', text: '未下发：名单外' })
  })

  it('超时 / 500：结果未知；回读成功 → 释放锁，结果记为「已读到」', async () => {
    const { s, toasts } = spec({ send: async () => { throw new ApiError('server', '内部错误') } })
    expect(await W.runOp(s)).toBe('unknown')
    expect(toasts[0]).toBe('客厅 下发结果未知：内部错误')
    expect(W.lockOf('P1')).toBeNull()
    expect(W.getResult('P1', 'R1')).toMatchObject({ outcome: 'unknown', readback: 'ok' })
  })

  it('请求永不返回：到总期限进入 unknown-locked；核对读取成功后才解锁，核对失败仍锁住', async () => {
    W.LIMITS.writeTotalMs = 30
    const { s, calls } = spec({ send: () => new Promise<never>(() => {}) })
    expect(await W.runOp(s)).toBe('unknown')
    expect(calls).toEqual(['preflight']) // 期限已用完，回读也超时
    expect(W.lockOf('P1')?.phase).toBe('unknown-locked')
    expect(await W.runOp(spec().s)).toBe('busy')
    expect(await W.checkLocked('P1', async () => { throw new Error('读不到') })).toBe(false)
    expect(W.lockOf('P1')?.phase).toBe('unknown-locked')
    expect(await W.checkLocked('P1', async () => [])).toBe(true)
    expect(W.lockOf('P1')).toBeNull()
  })
})

describe('verifying', () => {
  it('成功但回读失败 / 抛错：unknown-locked（不能确认面板现状）', async () => {
    const { s } = spec({ verify: async () => { throw new Error('boom') } })
    expect(await W.runOp(s)).toBe('ok')
    expect(W.lockOf('P1')?.phase).toBe('unknown-locked')
  })

  it('确定失败后回读失败：写没生效，释放锁', async () => {
    const { s } = spec({ send: async () => { throw new ApiError('ctrl', 'x') }, verify: async () => { throw new Error('boom') } })
    expect(await W.runOp(s)).toBe('fail')
    expect(W.lockOf('P1')).toBeNull()
  })

  it('写的过程中会话变了：不回读（不用新凭据）、不提示、新会话看不到结果；成功则释放锁', async () => {
    const g = gate()
    const { s, calls, toasts } = spec({ send: async () => { await g.p } })
    const run = W.runOp(s)
    await tick()
    userKey = 'user:B'
    g.open()
    expect(await run).toBe('ok')
    expect(calls).toEqual(['preflight'])
    expect(toasts).toEqual([])
    expect(W.getResult('P1', 'R1')).toBeNull()
    expect(W.lockOf('P1')).toBeNull()
  })

  it('写的过程中会话变了且结果未知：保持锁（unknown-locked），新会话能看到锁但看不到结果', async () => {
    const g = gate()
    const { s, calls } = spec({ send: async () => { await g.p; throw new ApiError('timeout', '未收到控制屏应答') } })
    const run = W.runOp(s)
    await tick()
    userKey = 'user:B'
    g.open()
    expect(await run).toBe('unknown')
    expect(calls).toEqual(['preflight'])
    expect(W.lockOf('P1')?.phase).toBe('unknown-locked')
    expect(W.lockOf('P1')?.sessionKey).not.toBe(W.currentSessionKey())
    expect(W.getResult('P1', 'R1')).toBeNull()
  })

  it('完成时已切到别的项目：不提示，结果留给原项目（同一会话回去能看到）', async () => {
    const g = gate()
    const { s, toasts } = spec({ send: async () => { await g.p } })
    const run = W.runOp(s)
    await tick()
    storedProject = 'P2'
    g.open()
    await run
    expect(toasts).toEqual([])
    expect(W.getResult('P1', 'R1')).toMatchObject({ outcome: 'ok', text: '客厅 已下发' })
  })
})

describe('收尾', () => {
  it('提示回调抛异常：状态机照常收尾、释放锁', async () => {
    const { s } = spec({ toast: () => { throw new Error('toast 坏了') } })
    expect(await W.runOp(s)).toBe('ok')
    expect(W.lockOf('P1')).toBeNull()
  })
  it('send 抛非 ApiError：按结果未知处理并回读', async () => {
    const { s, calls } = spec({ send: async () => { throw new TypeError('坏了') } })
    expect(await W.runOp(s)).toBe('unknown')
    expect(calls).toEqual(['preflight', 'verify'])
    expect(W.lockOf('P1')).toBeNull()
  })
})
