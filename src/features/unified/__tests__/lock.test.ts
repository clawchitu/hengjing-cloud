// @vitest-environment jsdom
// S12b 接入写锁（lock.ts + batch.ts）：同屏忙、claim 在 beforeSend 链最后、结果未知持锁、强制重读、刷新后锁仍在、203 核对口径。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/errors'
import * as L from '@/api/writeLock'
import { createUnifiedBatch, summarizeRooms, type BatchProject, type BatchSender } from '../batch'
import { LOCK_BUSY_TEXT, match203, recordOf, rereadHits, resolveOrgProject, setupUnifiedWriteLock, verifiable203 } from '../lock'
import { orgKeys } from '@/data/org/hooks'

const P = (id: string, screen?: string): BatchProject => ({ id, code: id, name: '项目' + id, programCode: 1, online: true, controlScreenId: screen })
const snap = { rooms: 2, roomSwitch: 1, roomTemp: 26 }
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
const acct = { user: 'u1', gen: 1 }

function make(projects: BatchProject[], send: BatchSender) {
  return createUnifiedBatch({ getProjects: () => projects, readBack: async () => snap, send, log: () => {}, now: () => new Date() })
}
async function runOnce(b: ReturnType<typeof make>, ids: string[]) {
  const s = b.prepare(ids, { roomSwitch: 1 })
  if (s.phase !== 'confirming') return s
  const done = await b.start()
  b.reset()
  return done
}

beforeEach(() => { localStorage.clear(); L.__resetWriteLockForTests(() => acct) })

describe('S12b 接入写锁', () => {
  it('同屏忙：两个项目共用一块屏，前一个结果未知 → 后一个不发，提示「上一条下发还在处理中」；之后 prepare 也拦', async () => {
    const wire: string[] = []
    const send: BatchSender = async (p, _q, o) => {
      if (!o.beforeSend()) throw new ApiError('write_blocked', 'x')
      wire.push(p.id)
      throw new ApiError('timeout', '请求超时') // 结果未知
    }
    const b = make([P('a', 'S1'), P('b', 'S1')], send)
    const done = await runOnce(b, ['a', 'b'])
    expect(wire).toEqual(['a'])
    const rb = done.rows.find((r) => r.id === 'b')!
    expect(rb.status).toBe('failure')
    expect(rb.state.status === 'failure' && rb.state.outcome).toBe('not-sent')
    expect(rb.state.status === 'failure' && rb.state.error).toContain(LOCK_BUSY_TEXT)
    const again = b.prepare(['b'], { roomSwitch: 1 })
    expect(again.phase).toBe('idle')
    expect(again.errors.join()).toContain(LOCK_BUSY_TEXT)
  })

  it('claim 在 beforeSend 链的最后：批次复核不过时不认领（锁直接放）；认领时锁已在 sent 之前是 held', async () => {
    const spy = vi.spyOn(L, 'claim')
    let phaseAtSend: string | undefined
    const send: BatchSender = async (p, _q, o) => {
      // 让项目在发送前变离线：批次复核先失败，claim 不应被调用
      if (p.id === 'off') { list[1] = { ...list[1], online: false } }
      expect(L.lockOf({ id: p.id })?.phase).toBe('held')
      const before = spy.mock.results.length
      const ok = o.beforeSend()
      phaseAtSend = L.lockOf({ id: p.id })?.phase
      if (spy.mock.results.length > before) {
        // claim 被调用了：它的返回值就是 beforeSend 的结果（之后没有别的检查），并且认领后进入 sent
        expect(ok).toBe(spy.mock.results.at(-1)!.value)
        expect(phaseAtSend).toBe('sent')
      }
      if (!ok) throw new ApiError('write_blocked', 'x')
      return { success: true, msg: '' }
    }
    const list = [P('ok1'), P('off')]
    const b = make(list, send)
    await runOnce(b, ['ok1', 'off'])
    // ok1：复核通过后才调 claim，并且 claim 是最后一步（认领后进入 sent）
    expect(spy).toHaveBeenCalledTimes(1)
    expect(phaseAtSend).toBe('held') // off：复核不过，没认领
    await flush()
    expect(L.lockOf({ id: 'ok1' })).toBeNull() // 成功 → 放锁
    expect(L.lockOf({ id: 'off' })).toBeNull() // 没认领 → 放锁
    spy.mockRestore()
  })

  it('结果未知持锁：批次截止只改标注不放锁；原 Promise 迟到成功只算已下发 → 按结果未知交给锁核对，核对一致才放', async () => {
    L.configureWriteLock({ resolveProject: (id) => (id === 'u' ? { id: 'u', controlScreenId: 'S9' } : null) })
    // 核对按字段走本次登记的核对函数（用批次的回读），不再用注册的整条核对器
    const readBack = vi.fn(async () => snap)
    let finish!: (v: { success: boolean; msg: string }) => void
    const send: BatchSender = (_p, _q, o) => { if (!o.beforeSend()) return Promise.reject(new ApiError('write_blocked', 'x')); return new Promise((r) => { finish = r }) }
    const b = createUnifiedBatch({ getProjects: () => [P('u', 'S9')], readBack, send, log: () => {}, deadlineMs: 20 })
    b.prepare(['u'], { roomSwitch: 1 })
    const done = await b.start()
    expect(done.rows[0].status).toBe('unknown') // 截止：结果未知
    expect(L.lockOf({ id: 'u', controlScreenId: 'S9' })?.phase).toBe('sent') // 锁仍在
    const reads = readBack.mock.calls.length
    finish({ success: true, msg: '' })
    await flush()
    expect(readBack.mock.calls.length).toBeGreaterThan(reads)
    expect(L.lockOf({ id: 'u', controlScreenId: 'S9' })).toBeNull()
  })

  it('截止后才到的 success=true、核对器回读不一致：锁按结果未知保持，不提前放', async () => {
    L.configureWriteLock({ resolveProject: (id) => (id === 'v' ? { id: 'v', controlScreenId: 'SV2' } : null) })
    // 回读一直是关着：核对不一致
    const readBack = vi.fn(async () => ({ rooms: 2, roomSwitch: 0, roomTemp: 26 }))
    let finish!: (v: { success: boolean; msg: string }) => void
    const send: BatchSender = (_p, _q, o) => { if (!o.beforeSend()) return Promise.reject(new ApiError('write_blocked', 'x')); return new Promise((r) => { finish = r }) }
    const b = createUnifiedBatch({ getProjects: () => [P('v', 'SV2')], readBack, send, log: () => {}, deadlineMs: 20 })
    b.prepare(['v'], { roomSwitch: 1 })
    await b.start()
    b.reset() // 页面拿到结果后立即 reset（取消订阅）
    const reads = readBack.mock.calls.length
    finish({ success: true, msg: '' })
    await flush()
    expect(readBack.mock.calls.length).toBeGreaterThan(reads)
    expect(L.lockOf('screen:SV2')?.phase).toBe('unknown')
  })

  it('截止时已应答 success=true、回读还没完成：截止当下按结果未知结算，锁保持；之后回读迟到也不误放成 ok', async () => {
    L.registerVerifier(203, async () => false)
    let slow!: () => void
    const gate = new Promise<void>((r) => { slow = r })
    let n = 0
    const send: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); return { success: true, msg: '' } }
    const b = createUnifiedBatch({ getProjects: () => [P('d', 'SD')], readBack: async () => { if (n++ === 1) await gate; return snap }, send, log: () => {}, deadlineMs: 30 })
    b.prepare(['d'], { roomSwitch: 1 })
    const done = await b.start()
    expect(done.rows[0].status).toBe('unknown')
    expect(L.lockOf('screen:SD')?.phase).toBe('unknown')
    b.reset()
    slow()
    await flush()
    expect(L.lockOf('screen:SD')?.phase).toBe('unknown')
  })

  it('结果未知：settle(unknown) 后锁保持（未核对时不放）', async () => {
    const send: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); throw new ApiError('network', '网络错误') }
    const b = make([P('n', 'S2')], send)
    await runOnce(b, ['n'])
    await flush()
    const l = L.lockOf({ id: 'n', controlScreenId: 'S2' })
    expect(l?.phase).toBe('unknown')
    expect(L.release({ id: 0, key: 'screen:S2' })).toBe(false)
  })

  it('强制重读：锁到期放开时发出事件，与本页项目（同屏）命中', async () => {
    vi.useFakeTimers()
    try {
      const got = L.acquire({ id: 'x', controlScreenId: 'S3' }, 'x')
      if (!got.ok) throw new Error('busy')
      L.claim(got.token)
      L.markSent(got.token, new Promise(() => {}), recordOf({ systemSwitch: 1, systemMode: 0, roomSwitch: -1, roomTemp: -1 } as never))
      L.settle(got.token, 'unknown')
      const hits: boolean[] = []
      const off = L.onForceReread((ev) => hits.push(rereadHits(ev, [{ id: 'other', controlScreenId: 'S3' }])))
      vi.advanceTimersByTime(L.DEFAULT_TTL_MS + 10)
      expect(hits).toEqual([true])
      expect(L.lockOf('screen:S3')).toBeNull()
      off()
    } finally { vi.useRealTimers() }
  })

  it('刷新后锁仍在：落盘的记录在重新加载模块后恢复为结果未知', async () => {
    const send: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); throw new ApiError('timeout', '超时') }
    const b = make([P('r', 'S4')], send)
    await runOnce(b, ['r'])
    await flush()
    const raw = localStorage.getItem(L.STORAGE_PREFIX + 'screen:S4')
    expect(raw).toBeTruthy()
    expect(raw).not.toContain('项目r') // 不存 label / 项目名
    vi.resetModules()
    const R = await import('@/api/writeLock')
    const l = R.lockOf({ id: 'r', controlScreenId: 'S4' })
    expect(l?.origin).toBe('restored')
    expect(l?.phase).toBe('unknown')
  })
})

describe('203 核对口径', () => {
  const t = (o: object) => recordOf({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: -1, ...o } as never).target
  it('只核对房间开关与设定温度；改了系统开关 / 运行模式的无法核对（不一致）', () => {
    expect(match203(t({ roomSwitch: 1, roomTemp: 26 }), snap)).toBe(true)
    expect(match203(t({ roomTemp: 25 }), snap)).toBe(false)
    expect(match203(t({ roomSwitch: 0 }), snap)).toBe(false)
    expect(verifiable203(t({ systemSwitch: 1, roomSwitch: 1 }))).toBe(false)
    expect(match203(t({ systemSwitch: 1, roomSwitch: 1 }), snap)).toBe(false)
    expect(match203(t({ systemMode: 3 }), snap)).toBe(false)
    expect(match203(t({}), snap)).toBe(false)
    expect(match203(t({ roomSwitch: 1 }), { rooms: 0, roomSwitch: null, roomTemp: null })).toBe(false)
  })
  it('写锁核对用逐房间原始读数（与状态机同口径）：目标 20.01、回读 20.024（四舍五入为 20.02）不一致；24.494 与 24.5 一致；有房间离线不一致', () => {
    const t = (roomTemp: number) => recordOf({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp } as never).target
    expect(match203(t(20.01), summarizeRooms([{ switch: 1, setTemp: 20.024 }]))).toBe(false)
    expect(match203(t(24.5), summarizeRooms([{ switch: 1, setTemp: 24.494 }, { switch: 1, setTemp: 24.5 }]))).toBe(true)
    expect(match203(t(24.5), summarizeRooms([{ switch: 1, setTemp: 24.5 }, { switch: 1, setTemp: 24.5, isConnected: false }]))).toBe(false)
  })

  it('温度容差 0.01（与状态机一致）：差 0.04 不一致', () => {
    expect(match203(t({ roomTemp: 26 }), { ...snap, roomTemp: 25.96 })).toBe(false)
    expect(match203(t({ roomTemp: 26 }), { ...snap, roomTemp: 26.005 })).toBe(true)
  })
  it('resolveOrgProject：缓存里没有组织数据 → 不可见', () => {
    expect(resolveOrgProject(new QueryClient(), 'p1')).toBeNull()
  })
  it('resolveOrgProject：在集成项目里才可见；不在任何集成项目、userKey 不一致、未登录 → 不可见', () => {
    const qc = new QueryClient()
    qc.setQueryData(orgKeys.groups('u1', null), [{ id: 'g', projectIds: ['p1'] }])
    qc.setQueryData(orgKeys.projects('u1', {}), [{ id: 'p1', controlScreenId: 'S1' }, { id: 'p2' }])
    const me = () => ({ authed: true, userKey: 'u1' })
    expect(resolveOrgProject(qc, 'p1', me)).toEqual({ id: 'p1', controlScreenId: 'S1', dtuId: undefined })
    expect(resolveOrgProject(qc, 'p2', me)).toBeNull()
    expect(resolveOrgProject(qc, 'p1', () => ({ authed: true, userKey: 'u2' }))).toBeNull()
    expect(resolveOrgProject(qc, 'p1', () => ({ authed: false, userKey: 'u1' }))).toBeNull()
  })
})

describe('注册了 203 核对器时', () => {
  const me = () => ({ authed: true, userKey: 'u1' })
  function visibleQc() {
    const qc = new QueryClient()
    qc.setQueryData(orgKeys.groups('u1', null), [{ id: 'g', projectIds: ['v'] }])
    qc.setQueryData(orgKeys.projects('u1', {}), [{ id: 'v', controlScreenId: 'SV' }])
    return qc
  }
  it('settle(unknown) 后自动核对：回读不一致保持，一致放锁；改了系统开关的不回读', async () => {
    let cur = { rooms: 2, roomSwitch: 0, roomTemp: 26 }
    const read = vi.fn(async () => cur)
    setupUnifiedWriteLock(visibleQc(), read, me)
    const send: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); throw new ApiError('timeout', '超时') }
    const b = createUnifiedBatch({ getProjects: () => [{ ...P('v', 'SV') }], readBack: read, send, log: () => {}, now: () => new Date() })
    await runOnce(b, ['v'])
    await flush()
    expect(read).toHaveBeenCalled()
    expect(L.lockOf('screen:SV')?.phase).toBe('unknown') // 不一致：保持
    cur = { rooms: 2, roomSwitch: 1, roomTemp: 26 }
    expect(await L.verify('screen:SV')).toBe('released')
    // 改了系统开关：核对直接不一致，不回读
    read.mockClear()
    const got = L.acquire({ id: 'v', controlScreenId: 'SV' }, 'x'); if (!got.ok) throw new Error('busy')
    L.claim(got.token)
    L.markSent(got.token, Promise.reject(new Error('x')).catch(() => { throw new Error('x') }), recordOf({ systemSwitch: 1, systemMode: 0, roomSwitch: 1, roomTemp: -1 } as never))
    await flush()
    L.settle(got.token, 'unknown')
    await flush()
    expect(await L.verify('screen:SV')).toBe('mismatch')
    expect(read).not.toHaveBeenCalled()
  })

  it('结果未知后状态机下发后回读一致：batch 再调一次 verify，核对一致放锁', async () => {
    L.configureWriteLock({ resolveProject: (id) => (id === 'w' ? { id: 'w', controlScreenId: 'SW' } : null) })
    const verifySpy = vi.spyOn(L, 'verify')
    const send: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); throw new ApiError('timeout', '超时') }
    // 下发前读关着；settle(unknown) 后的自动核对也读到关着（控制屏还没生效）；状态机下发后读开着：按回读一致判成功
    const off = { rooms: 2, roomSwitch: 0, roomTemp: 26 }
    let n = 0
    const b = createUnifiedBatch({ getProjects: () => [P('w', 'SW')], readBack: async () => (n++ < 2 ? off : snap), send, log: () => {}, now: () => new Date() })
    const done = await runOnce(b, ['w'])
    await flush()
    expect(done.rows[0].state.status === 'success' && done.rows[0].state.via).toBe('readback')
    // 批次在回读一致后补核对（锁内部 settle(unknown) 后的自动核对不经模块导出，不计在内）
    expect(verifySpy).toHaveBeenCalled()
    expect(L.lockOf('screen:SW')).toBeNull()
    verifySpy.mockRestore()
  })

  // 下发结果口径（Fable 11/24 裁定）：success=true 只算「已下发」，只有回读一致才放锁；未变化 / 无法核对 / 结果未知都锁着，等核对一致或到期
  describe('203 success=true 后按回读结算写锁', () => {
    const okSend: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); return { success: true, msg: '' } }
    const batchWith = (id: string, reads: Array<Record<string, unknown>>, readFail = false) => createUnifiedBatch({
      getProjects: () => [P(id, 'S' + id)], send: okSend, log: () => {}, now: () => new Date(),
      readBack: async () => { const r = reads.shift(); if (!r && readFail) throw new ApiError('unavailable', '控制屏未连接'); return (r ?? snap) as never },
    })
    const off = { rooms: 3, roomSwitch: 0, roomTemp: 24.5, perRoom: { roomSwitch: [0, 0, 0], roomTemp: [21.5, 24.5, 24.5] } }

    it('成功且一致 → 已生效，放锁', async () => {
      const b = batchWith('a1', [off, { rooms: 3, roomSwitch: 1, roomTemp: null, perRoom: { roomSwitch: [1, 1, 1], roomTemp: [21.5, 24.5, 24.5] } }])
      const done = await runOnce(b, ['a1'])
      await flush()
      expect(done.rows[0].status).toBe('success')
      expect(L.lockOf('screen:Sa1')).toBeNull()
    })

    it('成功但读到的值不一致（下发开启、回读关闭）→ 未变化，锁按结果未知保持，到期才放', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        // 之后的核对也读到关着：不一致，锁保持
        const b = batchWith('a2', [off, off, off, off])
        const done = await runOnce(b, ['a2'])
        await flush()
        expect(done.rows[0].status).toBe('unapplied')
        const st = done.rows[0].state
        expect(st.status === 'unapplied' && st.mismatches.map((m) => m.message)).toEqual(['房间开关下发 开启，回读 关闭'])
        expect(L.lockOf('screen:Sa2')?.phase).toBe('unknown')
        vi.advanceTimersByTime(L.DEFAULT_TTL_MS + 10)
        expect(L.lockOf('screen:Sa2')).toBeNull()
      } finally { vi.useRealTimers() }
    })

    it('部分房间一致（3 个里 1 个开）→ 未变化，标出几个房间不一致；锁保持', async () => {
      const b = batchWith('a3', [off, { rooms: 3, roomSwitch: null, roomTemp: null, perRoom: { roomSwitch: [1, 0, 0], roomTemp: [21.5, 24.5, 24.5] } }])
      const done = await runOnce(b, ['a3'])
      await flush()
      const st = done.rows[0].state
      expect(st.status === 'unapplied' && st.mismatches[0].message).toBe('房间开关下发 开启，回读 关闭（3 个房间中 2 个）')
      expect(L.lockOf('screen:Sa3')?.phase).toBe('unknown')
    })

    it('成功但 200 回包为空（没有房间条目）→ 无法核对；锁保持', async () => {
      const b = batchWith('a4', [off, { rooms: 0, roomSwitch: null, roomTemp: null, perRoom: { roomSwitch: [], roomTemp: [] } }])
      const done = await runOnce(b, ['a4'])
      await flush()
      expect(done.rows[0].status).toBe('unverifiable')
      expect(L.lockOf('screen:Sa4')?.phase).toBe('unknown')
    })

    it('成功但下发后回读失败 → 结果未知，锁保持', async () => {
      const b = batchWith('a5', [off], true)
      const done = await runOnce(b, ['a5'])
      await flush()
      expect(done.rows[0].status).toBe('unknown')
      expect(L.lockOf('screen:Sa5')?.phase).toBe('unknown')
    })

    it('锁按结果未知保持后，核对器回读一致 → 提前放锁', async () => {
      L.configureWriteLock({ resolveProject: (id) => (id === 'a6' ? { id: 'a6', controlScreenId: 'Sa6' } : null) })
      L.registerVerifier(203, async () => true)
      const b = batchWith('a6', [off, off])
      const done = await runOnce(b, ['a6'])
      await flush()
      expect(done.rows[0].status).toBe('unapplied')
      expect(L.lockOf('screen:Sa6')).toBeNull()
    })
  })

  it('批次截止调 markOverdue：锁标记已过截止，但不放', async () => {
    const send: BatchSender = (_p, _q, o) => { if (!o.beforeSend()) return Promise.reject(new ApiError('write_blocked', 'x')); return new Promise(() => {}) }
    const b = createUnifiedBatch({ getProjects: () => [P('d', 'SD')], readBack: async () => snap, send, log: () => {}, deadlineMs: 20 })
    b.prepare(['d'], { roomSwitch: 1 })
    await b.start()
    const l = L.lockOf('screen:SD')
    expect(l?.overdue).toBe(true)
    expect(l?.phase).toBe('sent')
  })
})

describe('刷新后补核对（恢复的锁）', () => {
  const rec = { v: 1, op: 'o1', keys: ['screen:SR'], projectId: 'r1', userId: 'u1', sentAt: Date.now() - 1000, msg: 203, deviceId: null, target: { systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 } }
  async function fresh() {
    localStorage.setItem('hjc-write-lock:screen:SR', JSON.stringify({ ...rec, sentAt: Date.now() - 1000 }))
    vi.resetModules()
    const R = await import('@/api/writeLock')
    const M = await import('../lock')
    const { QueryClient: QC } = await import('@tanstack/react-query')
    const { orgKeys: K } = await import('@/data/org/hooks')
    const read = vi.fn(async () => snap)
    const qc = new QC()
    M.setupUnifiedWriteLock(qc, read, () => ({ authed: true, userKey: 'u1' }))
    expect(R.lockOf('screen:SR')?.origin).toBe('restored')
    return { R, qc, read, K }
  }
  it('项目列表先到、集成项目列表后到：后到时才核对，一致放锁', async () => {
    const { R, qc, read, K } = await fresh()
    qc.setQueryData(K.projects('u1', {}), [{ id: 'r1', controlScreenId: 'SR' }])
    await flush()
    expect(read).not.toHaveBeenCalled() // 还解析不出项目：不读
    expect(R.lockOf('screen:SR')).not.toBeNull()
    qc.setQueryData(K.groups('u1', null), [{ id: 'g', projectIds: ['r1'] }])
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(R.lockOf('screen:SR')).toBeNull()
  })
  it('集成项目列表先到、项目列表后到：同样核对一次', async () => {
    const { R, qc, read, K } = await fresh()
    qc.setQueryData(K.groups('u1', null), [{ id: 'g', projectIds: ['r1'] }])
    qc.setQueryData(K.projects('u1', {}), [{ id: 'r1', controlScreenId: 'SR' }])
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(R.lockOf('screen:SR')).toBeNull()
  })
  it('演示数据（initialData 写入缓存，只有 added 事件）：也会补核对', async () => {
    const { R, qc, read, K } = await fresh()
    qc.getQueryCache().build(qc, { queryKey: K.groups('u1', null), initialData: [{ id: 'g', projectIds: ['r1'] }] })
    qc.getQueryCache().build(qc, { queryKey: K.projects('u1', {}), initialData: [{ id: 'r1', controlScreenId: 'SR' }] })
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(R.lockOf('screen:SR')).toBeNull()
  })
})
