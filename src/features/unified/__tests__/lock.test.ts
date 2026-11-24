// @vitest-environment jsdom
// S12b 接入写锁（lock.ts + batch.ts）：同屏忙、claim 在 beforeSend 链最后、结果未知持锁、强制重读、刷新后锁仍在、203 核对口径。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/errors'
import * as L from '@/api/writeLock'
import { createUnifiedBatch, type BatchProject, type BatchSender } from '../batch'
import { LOCK_BUSY_TEXT, match203, recordOf, rereadHits, resolveOrgProject, verifiable203 } from '../lock'

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
      const ok = o.beforeSend()
      phaseAtSend = L.lockOf({ id: p.id })?.phase
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

  it('结果未知持锁：批次截止只改标注不放锁；回读一致前锁一直在，原 Promise 迟到成功才放', async () => {
    let finish!: (v: { success: boolean; msg: string }) => void
    const send: BatchSender = (_p, _q, o) => { if (!o.beforeSend()) return Promise.reject(new ApiError('write_blocked', 'x')); return new Promise((r) => { finish = r }) }
    const b = createUnifiedBatch({ getProjects: () => [P('u', 'S9')], readBack: async () => snap, send, log: () => {}, deadlineMs: 20 })
    b.prepare(['u'], { roomSwitch: 1 })
    const done = await b.start()
    expect(done.rows[0].status).toBe('unknown') // 截止：结果未确认
    expect(L.lockOf({ id: 'u', controlScreenId: 'S9' })?.phase).toBe('sent') // 锁仍在
    finish({ success: true, msg: '' })
    await flush()
    expect(L.lockOf({ id: 'u', controlScreenId: 'S9' })).toBeNull()
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
  it('resolveOrgProject：缓存里没有组织数据 → 不可见', () => {
    expect(resolveOrgProject(new QueryClient(), 'p1')).toBeNull()
  })
})
