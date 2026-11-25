// @vitest-environment jsdom
// S12 下发结果口径改 B（Fable 11/25）：
// 1. 混合字段的总结果排序：结果未知 > 未变化 > 无法核对 > 已生效
// 2. 逐字段列出各自的状态；混合时标题按计数写（「1 项未生效，1 项无法核对」），不压成一个词
// 3. 写锁按字段判断：每个字段回读一致或到期才结束，全部结束才放锁；之后的复核读到一致的字段算结束
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import * as L from '@/api/writeLock'
import { createUnifiedBatch, type BatchProject, type BatchSender, type UnifiedSnapshot } from '../batch'
import { echoMismatches, echoVerdict, fieldResults, overallOf, resultTitle, type FieldStatus } from '../rules'

const Q = (o: Partial<{ systemSwitch: number; systemMode: number; roomSwitch: number; roomTemp: number }>) => ({ systemSwitch: -1, systemMode: -1, roomSwitch: -1, roomTemp: -1, ...o })
const st = (...xs: FieldStatus[]) => xs.map((status) => ({ status }))

describe('总结果排序 B 与标题', () => {
  it('未变化 + 无法核对：总结果是未变化，标题带计数', () => {
    // 系统开关 200 里读不到（无法核对），房间开关读到关着（未变化）
    const rs = fieldResults(Q({ systemSwitch: 1, roomSwitch: 1 }), { roomSwitch: 0, perRoom: { roomSwitch: [0, 0] } })
    expect(rs.map((r) => [r.field, r.status])).toEqual([['systemSwitch', 'unverifiable'], ['roomSwitch', 'unchanged']])
    expect(overallOf(rs)).toBe('unchanged')
    expect(resultTitle(rs)).toBe('1 项未生效，1 项无法核对')
  })
  it('排序：结果未知 > 未变化 > 无法核对 > 已生效', () => {
    expect(overallOf(st('applied', 'unverifiable'))).toBe('unverifiable')
    expect(overallOf(st('unverifiable', 'unchanged'))).toBe('unchanged')
    expect(overallOf(st('unchanged', 'unknown'))).toBe('unknown')
    expect(overallOf(st('applied'))).toBe('applied')
  })
  it('单一结果：标题就是那个词；三种混合按排序逐项计数', () => {
    expect(resultTitle(st('applied', 'applied'))).toBe('已生效')
    expect(resultTitle(st('unverifiable'))).toBe('无法核对')
    expect(resultTitle(st('applied', 'unknown', 'unchanged', 'unchanged'))).toBe('1 项结果未知，2 项未生效，1 项已生效')
  })
  it('逐字段：回读失败 / 有房间离线 → 结果未知；应答未知时只有回读一致的算已生效', () => {
    const q = Q({ roomSwitch: 1, roomTemp: 26 })
    expect(fieldResults(q, null).map((r) => r.status)).toEqual(['unknown', 'unknown'])
    expect(fieldResults(q, { roomSwitch: 1, roomTemp: 26, offline: 1 }).map((r) => r.status)).toEqual(['unknown', 'unknown'])
    expect(fieldResults(q, { roomSwitch: 1, roomTemp: 25 }, { replied: false }).map((r) => r.status)).toEqual(['applied', 'unknown'])
    // 同一字段既有不一致、又有没回报：按排序算未变化
    expect(fieldResults(Q({ roomSwitch: 1 }), { roomSwitch: null, perRoom: { roomSwitch: [0, null] } })[0].status).toBe('unchanged')
  })
  it('房间开关未上报 + 有房间离线：开关单独判无法核对，温度仍按离线判结果未知；只改开关时整体无法核对', () => {
    const snap = { roomSwitch: null, roomTemp: 26, offline: 1, switchUnreported: true, perRoom: { roomSwitch: [null], roomTemp: [26] } }
    expect(fieldResults(Q({ roomSwitch: 1, roomTemp: 26 }), snap).map((r) => r.status)).toEqual(['unverifiable', 'unknown'])
    expect(fieldResults(Q({ roomSwitch: 1 }), snap).map((r) => r.status)).toEqual(['unverifiable'])
    const ms = echoMismatches(Q({ roomSwitch: 1 }), snap)
    expect(echoVerdict(ms, snap, ['roomSwitch'])).toBe('unverifiable')
    expect(echoVerdict(echoMismatches(Q({ roomSwitch: 1, roomTemp: 26 }), snap), snap, ['roomSwitch', 'roomTemp'])).toBe('unknown')
    // 开关可信时离线照旧结果未知
    expect(echoVerdict(ms, { ...snap, switchUnreported: undefined }, ['roomSwitch'])).toBe('unknown')
  })
})

describe('写锁按字段判断（跟总结果无关）', () => {
  const P: BatchProject = { id: 'p1', code: 'p1', name: '项目', programCode: 1, online: true, controlScreenId: 'S1' }
  const okSend: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); return { success: true, msg: '' } }
  const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
  const snapOf = (sw: number, t: number): UnifiedSnapshot => ({ rooms: 2, roomSwitch: sw, roomTemp: t, perRoom: { roomSwitch: [sw, sw], roomTemp: [t, t] } })
  beforeEach(() => {
    localStorage.clear()
    L.__resetWriteLockForTests(() => ({ user: 'u1', gen: 1 }))
    L.configureWriteLock({ resolveProject: (id) => (id === 'p1' ? { id: 'p1', controlScreenId: 'S1' } : null) })
  })

  it('下发后回读一个字段一致、一个不一致 → 锁不放；之后复核读到另一个也一致（前一个这次又不一致）→ 两个字段都已结束，放锁', async () => {
    const reads = [snapOf(0, 24), snapOf(1, 24), snapOf(1, 24)] // 下发前；下发后（开关一致、温度不一致）；自动核对（同样）
    const readBack = vi.fn(async () => reads.shift() ?? snapOf(0, 26)) // 再之后：开关不一致、温度一致
    const b = createUnifiedBatch({ getProjects: () => [P], readBack, send: okSend, log: () => {}, now: () => new Date() })
    b.prepare(['p1'], { roomSwitch: 1, roomTemp: 26 })
    const done = await b.start()
    await flush()
    expect(done.rows[0].status).toBe('unapplied')
    expect(L.lockOf('screen:S1')?.phase).toBe('unknown')
    expect(await L.verify('screen:S1')).toBe('released')
  })

  it('总结果是已生效以外的任何一种，只要还有字段没结束都不提前放锁；改了系统开关的等到期', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const readBack = vi.fn(async () => snapOf(1, 24))
      const b = createUnifiedBatch({ getProjects: () => [P], readBack, send: okSend, log: () => {}, now: () => new Date() })
      b.prepare(['p1'], { systemSwitch: 1, roomSwitch: 1 })
      const done = await b.start()
      await flush()
      expect(done.rows[0].status).toBe('unverifiable') // 房间开关已一致，系统开关无法核对
      expect(L.lockOf('screen:S1')?.phase).toBe('unknown')
      expect(await L.verify('screen:S1')).toBe('mismatch')
      vi.advanceTimersByTime(L.DEFAULT_TTL_MS + 10)
      expect(L.lockOf('screen:S1')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('迟到或失效的核对不改字段状态：超时后才到的一致读数、读数途中换了账号 → 不提交；之后读到不一致仍保持锁', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let acct = { user: 'u1', gen: 1 }
      L.__resetWriteLockForTests(() => acct)
      L.configureWriteLock({ resolveProject: (id) => (id === 'p1' ? { id: 'p1', controlScreenId: 'S1' } : null) })
      const off = snapOf(0, 24)
      let mode: 'off' | 'late-on' | 'switch-acct' = 'off'
      const readBack = vi.fn(async (): Promise<UnifiedSnapshot> => {
        if (mode === 'late-on') return new Promise((r) => setTimeout(() => r(snapOf(1, 24)), L.VERIFY_TIMEOUT_MS + 1000)) // 不理会中止，超时后才到
        if (mode === 'switch-acct') { acct = { user: 'u2', gen: 2 }; return snapOf(1, 24) }
        return off
      })
      const b = createUnifiedBatch({ getProjects: () => [P], readBack, send: okSend, log: () => {}, now: () => new Date() })
      b.prepare(['p1'], { roomSwitch: 1 })
      expect((await b.start()).rows[0].status).toBe('unapplied')
      await flush()
      expect(L.lockOf('screen:S1')?.phase).toBe('unknown')
      // 1. 超时：读数迟到（一致），这次核对作废，不提交
      mode = 'late-on'
      const late = L.verify('screen:S1')
      await vi.advanceTimersByTimeAsync(L.VERIFY_TIMEOUT_MS + 2000)
      expect(await late).toBe('failed')
      // 2. 读数途中换了账号：作废，不提交
      mode = 'switch-acct'
      expect(await L.verify('screen:S1')).toBe('account-changed')
      acct = { user: 'u1', gen: 1 }
      // 3. 之后读到不一致：字段没被前两次提交为结束，锁仍保持
      mode = 'off'
      expect(await L.verify('screen:S1')).toBe('mismatch')
      expect(L.lockOf('screen:S1')?.phase).toBe('unknown')
    } finally { vi.useRealTimers() }
  })
})
