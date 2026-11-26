// 执行记录（unified-ctrls-records）的解析与轮询：记录状态 → 原 203 应答的三种形状（成功 / 明确被拒 / 应答未知）。
// 只注入查询函数和时钟，不发任何请求。
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { cleanMessage, normalizeResult, utcToBeijing, pickRecord, RECORD_EVERY_MS, RECORD_FIRST_MS, RECORD_TEXT, waitRecord } from '../records'

const rec = (result: unknown, extra: Record<string, unknown> = {}) => ({ id: 'r', batch_id: 'B1', project_id: 'p1', result, message: '', ...extra })

/** 假时钟：sleep 只推进时间；query 按调用次数返回 */
function harness(replies: Array<unknown | (() => unknown)>, windowMs = 12_000) {
  let t = 0
  let n = 0
  const query = vi.fn(async () => {
    const r = replies[Math.min(n++, replies.length - 1)]
    const v = typeof r === 'function' ? (r as () => unknown)() : r
    if (v instanceof Error) throw v
    return v
  })
  const deps = { query, sleep: async (ms: number) => { t += ms }, now: () => t, windowMs }
  return { query, deps, elapsed: () => t }
}

describe('normalizeResult', () => {
  it.each([
    [1, 'pending'], [2, 'success'], [3, 'failure'], [4, 'timeout'], ['2', 'success'],
    ['RESULT_WAITING', 'pending'], ['PENDING', 'pending'], ['UNIFIED_CTRLS_RESULT_SUCCESS', 'success'], ['RESULT_FAILED', 'failure'], ['FAIL', 'failure'], ['RESULT_TIMEOUT', 'timeout'],
    [0, 'unknown'], [undefined, 'unknown'], [null, 'unknown'], [5, 'unknown'], ['SUCCESSFUL', 'unknown'], ['', 'unknown'], [true, 'unknown'],
  ])('%s → %s', (v, want) => expect(normalizeResult(v)).toBe(want))
})

describe('pickRecord：batch_id 与 project_id 都对上的恰好一条才采用', () => {
  it('一条', () => expect(pickRecord({ records: [rec(2)] }, 'B1', 'p1')).toEqual({ kind: 'one', result: 'success', message: '', operateTime: null }))
  it('别的批次、别的项目不算', () => {
    expect(pickRecord({ records: [rec(2, { batch_id: 'B0' }), rec(2, { project_id: 'p2' })] }, 'B1', 'p1')).toEqual({ kind: 'none' })
  })
  it('空回包 {}、records 不是数组 → 没有', () => {
    expect(pickRecord({}, 'B1', 'p1')).toEqual({ kind: 'none' })
    expect(pickRecord({ records: 'x' }, 'B1', 'p1')).toEqual({ kind: 'none' })
    expect(pickRecord(null, 'B1', 'p1')).toEqual({ kind: 'none' })
  })
  it('重复 → 无法确认', () => expect(pickRecord({ records: [rec(2), rec(3)] }, 'B1', 'p1')).toEqual({ kind: 'many' }))
})

describe('operate_time：后端 11/26 确认是 UTC（不带时区），前端转北京时间', () => {
  it('01:09:00（UTC）显示成 09:09:00', () => expect(utcToBeijing('2026-11-26 01:09:00')).toBe('2026-11-26 09:09:00'))
  it('跨天', () => expect(utcToBeijing('2026-11-25 20:30:05')).toBe('2026-11-26 04:30:05'))
  it.each([undefined, '', '2026-11-26T01:09:00Z', '2026-13-01 00:00:00', '2026-11-26 25:00:00', 123])('格式不对（%s）→ null，退回前端时间', (v) => expect(utcToBeijing(v)).toBeNull())
  it('pickRecord 带出转换后的时间', () => {
    expect(pickRecord({ records: [rec(2, { operate_time: '2026-11-26 01:13:02' })] }, 'B1', 'p1')).toMatchObject({ operateTime: '2026-11-26 09:13:02' })
  })
})

describe('cleanMessage', () => {
  it('去控制字符、合并空白、截断 80 字', () => {
    expect(cleanMessage('a\u0000b\n  c')).toBe('a b c')
    expect(cleanMessage('长'.repeat(100))).toBe('长'.repeat(80) + '…')
    expect(cleanMessage(3)).toBe('')
  })
})

describe('waitRecord：轮询到终态或窗口结束', () => {
  const ac = () => new AbortController().signal
  it('1 秒后查第一次；成功 → success', async () => {
    const h = harness([{ records: [rec(2)] }])
    expect(await waitRecord('B1', 'p1', ac(), h.deps)).toEqual({ kind: 'success', operateTime: null })
    expect(h.query).toHaveBeenCalledTimes(1)
    expect(h.query).toHaveBeenCalledWith({ batch_id: 'B1' }, expect.anything())
    expect(h.elapsed()).toBe(RECORD_FIRST_MS)
  })
  it('等待中 → 隔 2.5 秒再查 → 失败（带清洗过的 message）', async () => {
    const h = harness([{ records: [rec(1)] }, { records: [rec(3, { message: '屏忙\n' })] }])
    expect(await waitRecord('B1', 'p1', ac(), h.deps)).toEqual({ kind: 'failure', message: '屏忙', operateTime: null })
    expect(h.elapsed()).toBe(RECORD_FIRST_MS + RECORD_EVERY_MS)
  })
  it.each([
    ['超时（4）', [{ records: [rec(4)] }], RECORD_TEXT.timeout],
    ['一直等待中到窗口结束', [{ records: [rec(1)] }], RECORD_TEXT.pending],
    ['一直查不到', [{}], RECORD_TEXT.none],
    ['重复记录', [{ records: [rec(2), rec(2)] }], RECORD_TEXT.many],
    ['状态认不出', [{ records: [rec(0)] }], RECORD_TEXT.unrecognized],
    ['一直查询失败', [new ApiError('server', 'x', { status: 500 })], RECORD_TEXT.readFailed],
    ['403 无权限（立即停）', [new ApiError('forbidden', 'no permission', { status: 403 })], RECORD_TEXT.forbidden],
  ])('%s → 结果未知', async (_n, replies, note) => {
    const h = harness(replies)
    expect(await waitRecord('B1', 'p1', ac(), h.deps)).toEqual({ kind: 'unknown', note })
    // 窗口内结束（12 秒），不无限查
    expect(h.elapsed()).toBeLessThanOrEqual(12_000)
  })
  it('查询失败一次后恢复 → 照常采用', async () => {
    const h = harness([new ApiError('network', 'x'), { records: [rec(2)] }])
    expect(await waitRecord('B1', 'p1', ac(), h.deps)).toEqual({ kind: 'success', operateTime: null })
  })
  it('403 只查一次', async () => {
    const h = harness([new ApiError('forbidden', 'no permission', { status: 403 })])
    await waitRecord('B1', 'p1', ac(), h.deps)
    expect(h.query).toHaveBeenCalledTimes(1)
  })
  it('离开页面（取消）：迟到的成功不采用 → 结果未知', async () => {
    const c = new AbortController()
    const h = harness([() => { c.abort(); return { records: [rec(2)] } }])
    expect(await waitRecord('B1', 'p1', c.signal, h.deps)).toEqual({ kind: 'unknown', note: RECORD_TEXT.aborted })
  })
})
