// S12b 批量控制器：逐个项目走 S12a 状态机。下发函数、回读都注入假的，不连任何接口。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetWriteLockForTests, lockOf } from '@/api/writeLock'
import { ApiError } from '@/api/errors'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'
import { createUnifiedBatch, summarizeRooms, unifiedAppCode, type BatchProject, type BatchSender, type UnifiedSnapshot } from '../batch'
import { echoMismatches } from '../rules'

const P = (id: string, code: string, extra: Partial<BatchProject> = {}): BatchProject => ({ id, code, name: '项目' + code, programCode: 1, online: true, ...extra })

/** 假写入口：同写入口一样，先同步跑 beforeSend，不通过就不「发出」（不计入 wire） */
function fakeWire(reply: (p: BatchProject) => Promise<{ success: boolean; msg: string }> = async () => ({ success: true, msg: '' })) {
  const wire: string[] = []
  const send = vi.fn<BatchSender>(async (p, _q, o) => {
    if (!o.beforeSend()) throw new ApiError('write_blocked', '发送前复核未通过，未下发')
    wire.push(p.id)
    return reply(p)
  })
  return { send, wire }
}

function setup(projects: BatchProject[], opts: { send?: BatchSender; reads?: Record<string, UnifiedSnapshot[]>; deadlineMs?: number; realNow?: boolean } = {}) {
  let list = projects
  const reads = opts.reads ?? {}
  const readBack = vi.fn(async (id: string) => reads[id]?.shift() ?? { rooms: 2, roomSwitch: 1, roomTemp: 26 })
  const w = fakeWire()
  const send = opts.send ? vi.fn(opts.send) : w.send
  const batch = createUnifiedBatch({ getProjects: () => list, readBack, send, log: () => {}, deadlineMs: opts.deadlineMs, now: opts.realNow ? undefined : () => new Date('2026-11-24T10:00:00') })
  return { batch, readBack, send, wire: w.wire, setList: (l: BatchProject[]) => { list = l } }
}
beforeEach(() => { __resetWriteLockForTests(() => ({ user: 'u', gen: 1 })) })
const gated = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r }); return { gate, release } }

describe('summarizeRooms（ctrl 200 → 回读快照）', () => {
  it('全部房间一致才给值；65536 / -1 视为没读到；不一致为 null', () => {
    expect(summarizeRooms([{ switch: 1, setTemp: 25.5 }, { switch: 1, setTemp: 25.5 }])).toEqual({ rooms: 2, roomSwitch: 1, roomTemp: 25.5, perRoom: { roomSwitch: [1, 1], roomTemp: [25.5, 25.5] } })
    expect(summarizeRooms([{ switch: 1, setTemp: 25.5 }, { switch: 0, setTemp: 26 }])).toEqual({ rooms: 2, roomSwitch: null, roomTemp: null, perRoom: { roomSwitch: [1, 0], roomTemp: [25.5, 26] } })
    expect(summarizeRooms([{ switch: 65536, setTemp: 65536 }])).toEqual({ rooms: 1, roomSwitch: null, roomTemp: null, perRoom: { roomSwitch: [null], roomTemp: [null] } })
    expect(summarizeRooms([])).toEqual({ rooms: 0, roomSwitch: null, roomTemp: null, perRoom: { roomSwitch: [], roomTemp: [] } })
  })

  it('房间开关未上报（后端 11/25 答复第 1 条）：开关读数一律 null（核对时无法核对），温度照常；-100 无效、0 有效', () => {
    const s = summarizeRooms([{ switch: 0, setTemp: 26 }, { switch: 1, setTemp: 26 }], { switchReported: false })
    expect(s).toEqual({ rooms: 2, roomSwitch: null, roomTemp: 26, perRoom: { roomSwitch: [null, null], roomTemp: [26, 26] } })
    expect(echoMismatches({ systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 }, s).map((m) => m.kind)).toEqual(['missing'])
    expect(summarizeRooms([{ switch: 0, setTemp: -100 }], { switchReported: true })).toMatchObject({ roomSwitch: 0, roomTemp: null })
  })

  it('逐房间温度保留原始读数核对（不先四舍五入）：24.494 与 24.5 差 0.006 算一致', async () => {
    const s = summarizeRooms([{ switch: 1, setTemp: 24.494 }])
    expect(s.perRoom?.roomTemp).toEqual([24.494])
    expect(s.roomTemp).toBe(24.49)
    const { batch } = setup([P('a', '1')], { reads: { a: [{ rooms: 1, roomSwitch: 1, roomTemp: 26 }, s] } })
    batch.prepare(['a'], { roomTemp: 24.5 })
    expect((await batch.start()).rows[0].status).toBe('success')
  })

  it('replyOk：只有控制屏应答 success=true 才标记（进度据此显示「已下发，正在核对…」）', async () => {
    let n = 0
    const { batch } = setup([P('a', '1'), P('b', '2')], { send: async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); return n++ === 0 ? { success: false, msg: '设备忙' } : { success: true, msg: '' } } })
    batch.prepare(['a', 'b'], { roomSwitch: 1 })
    const done = await batch.start()
    expect(done.rows.map((r) => r.replyOk)).toEqual([false, true])
  })

  it('is_connected=false 的房间不参与核对，记 offline；系统开关 / 运行模式不给键', () => {
    const s = summarizeRooms([{ switch: 0, setTemp: 21.5, isConnected: false }, { switch: 1, setTemp: 24.5, isConnected: true }])
    expect(s).toEqual({ rooms: 2, roomSwitch: 1, roomTemp: 24.5, offline: 1, perRoom: { roomSwitch: [1], roomTemp: [24.5] } })
    expect('systemSwitch' in s || 'systemMode' in s).toBe(false)
  })
})

describe('unifiedAppCode', () => {
  it('演示数据的 11/21/31 在演示模式下按通用版（1）处理；真实数据原样', () => {
    expect(unifiedAppCode(11, true)).toBe(1)
    expect(unifiedAppCode(12, true)).toBe(12)
    expect(unifiedAppCode(11, false)).toBe(11)
  })
})

describe('prepare：任一项目校验不过就整体不下发', () => {
  it('项目离线：报项目名，不回读、不下发', async () => {
    const { batch, readBack, send } = setup([P('a', '240829001'), P('b', '260911001', { online: false })])
    const s = batch.prepare(['a', 'b'], { roomSwitch: 1 })
    expect(s.phase).toBe('idle')
    expect(s.errors).toEqual(['项目260911001：项目离线，不能下发'])
    await batch.start()
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([12, 8])('app_code %i：温度设定被拒，房间开关可以', (code) => {
    const { batch } = setup([P('a', '1', { programCode: code })])
    expect(batch.prepare(['a'], { roomTemp: 25 }).errors).toEqual(['该应用类型不支持温度设定'])
    expect(batch.prepare(['a'], { roomSwitch: 1 }).phase).toBe('confirming')
  })

  it('温度范围 16–30、步长 0.5', () => {
    const { batch } = setup([P('a', '1')])
    for (const t of [15.5, 30.5, 25.25]) expect(batch.prepare(['a'], { roomTemp: t }).phase).toBe('idle')
    for (const t of [16, 30, 25.5]) {
      expect(batch.prepare(['a'], { roomTemp: t }).phase).toBe('confirming')
      batch.cancel()
    }
  })

  it('全部「不变」：只提示一次「没有要下发的设置」', () => {
    const { batch } = setup([P('a', '1'), P('b', '2')])
    expect(batch.prepare(['a', 'b'], {}).errors).toEqual(['没有要下发的设置'])
  })

  it('通过后停在 confirming，给出确认弹窗要列的值；取消后不下发', async () => {
    const { batch, send } = setup([P('a', '1')])
    const s = batch.prepare(['a'], { systemMode: Mode.OPERATION_MODE_AUTO, roomTemp: 24.5 })
    expect(s.phase).toBe('confirming')
    expect(s.items).toEqual([{ label: '运行模式', value: '自动模式' }, { label: '房间温度', value: '24.5°C' }])
    batch.cancel()
    expect(batch.getState().phase).toBe('idle')
    await batch.start()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('start：逐个下发，三种结果，不重试', () => {
  it('写入口拿到整个 Project；每个项目下发前后各读一次', async () => {
    const a = P('a', '240829001'), b = P('b', '260911001')
    const { batch, readBack, send } = setup([a, b], { reads: { a: [{ rooms: 2, roomSwitch: 0, roomTemp: 26 }, { rooms: 2, roomSwitch: 1, roomTemp: 26 }] } })
    batch.prepare(['a', 'b'], { roomSwitch: 1 })
    const done = await batch.start()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).toBe(a)
    expect(send.mock.calls[1][0]).toBe(b)
    expect(send.mock.calls[0][1]).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 })
    expect(readBack.mock.calls.map((c) => c[0])).toEqual(['a', 'a', 'b', 'b'])
    expect(done.phase).toBe('done')
    expect(done.rows.map((r) => r.status)).toEqual(['success', 'success'])
    const s = done.rows[0].state
    expect(s.status === 'success' && [s.before, s.after]).toEqual([{ rooms: 2, roomSwitch: 0, roomTemp: 26 }, { rooms: 2, roomSwitch: 1, roomTemp: 26 }])
    expect(done.rows[0].at).toBe('2026-11-24 10:00:00')
  })

  it('控制屏拒绝 → 失败，只发一次，不重试；下一个项目照常', async () => {
    let n = 0
    const { batch, send } = setup([P('a', '1'), P('b', '2')], { send: async () => (n++ === 0 ? { success: false, msg: '设备忙' } : { success: true, msg: '' }) })
    batch.prepare(['a', 'b'], { roomSwitch: 1 })
    const done = await batch.start()
    expect(send).toHaveBeenCalledTimes(2)
    expect(done.rows.map((r) => r.status)).toEqual(['failure', 'success'])
    // 再调 start 不会重发
    await batch.start()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('超时且回读不一致 → 结果未知（unknown），不重试', async () => {
    const { batch, send } = setup([P('a', '1')], {
      send: async () => { throw new ApiError('timeout', '请求超时') },
      reads: { a: [{ rooms: 1, roomSwitch: 1, roomTemp: 26 }, { rooms: 1, roomSwitch: 1, roomTemp: 26 }] },
    })
    batch.prepare(['a'], { roomTemp: 22 })
    const done = await batch.start()
    expect(send).toHaveBeenCalledTimes(1)
    expect(done.rows[0].status).toBe('unknown')
    expect(done.rows[0].state.status === 'unknown' && done.rows[0].state.error).toBe('已下发，结果未知，请刷新查看')
  })

  it('确认后项目离线了 → 该项目未下发；其他照常', async () => {
    const a = P('a', '1'), b = P('b', '2')
    const t = setup([a, b])
    t.batch.prepare(['a', 'b'], { roomSwitch: 1 })
    t.setList([{ ...a, online: false }, b])
    const done = await t.batch.start()
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.send.mock.calls[0][0].id).toBe('b')
    expect(done.rows.map((r) => r.status)).toEqual(['not-sent', 'success'])
  })

  it('项目 code 变了 → 写入口不会拿到旧项目（本地拦截，没发出）', async () => {
    const a = P('a', '240829001')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const t = setup([a])
    t.readBack.mockImplementationOnce(async () => { await gate; return { rooms: 1, roomSwitch: 0, roomTemp: 26 } })
    t.batch.prepare(['a'], { roomSwitch: 1 })
    const p = t.batch.start()
    t.setList([{ ...a, code: '999' }])
    release()
    const done = await p
    expect(t.send).not.toHaveBeenCalled()
    expect(done.rows[0].status).toBe('not-sent')
  })

  it('页面卸载（abort）：后面的项目不再下发', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const t = setup([P('a', '1'), P('b', '2')])
    t.readBack.mockImplementationOnce(async () => { await gate; return { rooms: 1, roomSwitch: 0, roomTemp: 26 } })
    t.batch.prepare(['a', 'b'], { roomSwitch: 1 })
    const p = t.batch.start()
    t.batch.abort()
    release()
    const done = await p
    expect(t.send).not.toHaveBeenCalled()
    expect(done.rows.map((r) => r.status)).toEqual(['not-sent', 'not-sent'])
  })

  it('截止时：已发出未回应的立即标「已下发，结果未知」，没发出的标「未下发（超时）」，不再等；截止后绝不再发写', async () => {
    const hang = gated()
    const projects = [P('a', '1'), P('b', '2'), P('c', '3')]
    let sentA = false
    const send = vi.fn<BatchSender>(async (p, _q, o) => {
      if (!o.beforeSend()) throw new ApiError('write_blocked', 'x')
      if (p.id === 'a') { sentA = true; await hang.gate; return { success: true, msg: '' } }
      return { success: true, msg: '' }
    })
    const t = setup(projects, { send, deadlineMs: 60, realNow: true })
    t.batch.prepare(['a', 'b', 'c'], { roomSwitch: 1 })
    const t0 = Date.now()
    const done = await t.batch.start() // a 的 203 一直不回
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(sentA).toBe(true)
    expect(done.phase).toBe('done')
    expect(done.rows.map((r) => r.status)).toEqual(['unknown', 'not-sent', 'not-sent'])
    expect(done.rows[0].note).toMatch(/已下发，结果未知/)
    expect(done.rows[1].note).toMatch(/未下发（超时）/)
    // a 迟到的应答不改结果；b、c 不会再发
    hang.release()
    await new Promise((r) => setTimeout(r, 50))
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.batch.getState().rows.map((r) => r.status)).toEqual(['unknown', 'not-sent', 'not-sent'])
  })

  it('截止时还在下发前读取（或等令牌续期）的项目：之后 beforeSend 拒绝，不发写', async () => {
    const slow = gated()
    const t = setup([P('a', '1')], { deadlineMs: 40, realNow: true })
    t.readBack.mockImplementationOnce(async () => { await slow.gate; return { rooms: 1, roomSwitch: 0, roomTemp: 26 } })
    t.batch.prepare(['a'], { roomSwitch: 1 })
    const done = await t.batch.start()
    expect(done.rows[0].status).toBe('not-sent')
    slow.release()
    await new Promise((r) => setTimeout(r, 50))
    expect(t.wire).toEqual([])
  })

  it('截止时写入口已调用、还在等令牌续期：截止后才跑 beforeSend → 拒绝，不发写，标「未下发（超时）」', async () => {
    const token = gated()
    const wire: string[] = []
    const verdicts: boolean[] = []
    const send = vi.fn<BatchSender>(async (_p, _q, o) => {
      await token.gate
      const ok = o.beforeSend(); verdicts.push(ok)
      if (!ok) throw new ApiError('write_blocked', 'x')
      wire.push('a'); return { success: true, msg: '' }
    })
    const t = setup([P('a', '1')], { send, deadlineMs: 40, realNow: true })
    t.batch.prepare(['a'], { roomSwitch: 1 })
    const done = await t.batch.start()
    expect(done.rows[0].status).toBe('not-sent')
    expect(done.rows[0].note).toMatch(/未下发（超时）/)
    token.release()
    await new Promise((r) => setTimeout(r, 30))
    expect(verdicts).toEqual([false])
    expect(wire).toEqual([])
  })

  it('beforeSend 自己核对截止时间：截止已过但截止定时器还没触发时也拒绝', async () => {
    const token = gated()
    let t = 0
    const wire: string[] = []
    const projects = [P('a', '1')]
    const send = vi.fn<BatchSender>(async (_p, _q, o) => { await token.gate; if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); wire.push('a'); return { success: true, msg: '' } })
    const batch = createUnifiedBatch({ getProjects: () => projects, readBack: async () => ({ rooms: 1, roomSwitch: 0, roomTemp: 26 }), send, log: () => {}, now: () => new Date(t), deadlineMs: 35_000 })
    batch.prepare(['a'], { roomSwitch: 1 })
    const p = batch.start()
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    t = 35_000 // 时钟已过截止（真实定时器 35 秒后才会触发）
    token.release()
    const done = await p
    expect(wire).toEqual([])
    const st = done.rows[0].state
    expect(st.status === 'failure' && st.outcome).toBe('not-sent')
  })

  it('旧批次里超时标「未下发」的写请求，不能借下一批的截止时间放行；它还没结算时同屏写锁拦住下一批（未下发），结算后放锁', async () => {
    const token = gated()
    const wire: string[] = []
    let n = 0
    const send = vi.fn<BatchSender>(async (_p, _q, o) => {
      const tag = `batch${++n}:a`
      if (n === 1) await token.gate
      if (!o.beforeSend()) throw new ApiError('write_blocked', 'x')
      wire.push(tag); return { success: true, msg: '' }
    })
    const t = setup([P('a', '1')], { send, deadlineMs: 40, realNow: true })
    t.batch.prepare(['a'], { roomSwitch: 1 })
    await t.batch.start()
    t.batch.reset()
    // 旧批次的写 Promise 没结算前锁不放：第二批在 prepare 就按「上一条下发还在处理中」整体不下发
    const s2 = t.batch.prepare(['a'], { roomSwitch: 0 })
    expect(s2.phase).toBe('idle')
    expect(s2.errors.join()).toContain('上一条下发还在处理中')
    const p2 = t.batch.start()
    token.release()
    await p2
    await new Promise((r) => setTimeout(r, 30))
    // 旧批次那条也不会借第二批放行；结算后锁放开
    expect(wire).toEqual([])
    expect(lockOf({ id: 'a' })).toBeNull()
  })

  it.each([
    ['成功（只算已下发，回读没完成 → 结果未知）', { success: true, msg: '' }, 'unknown'],
    ['明确拒绝', { success: false, msg: '设备忙' }, 'failure'],
  ] as const)('截止时 203 已%s、只是下发后回读没完成', async (_n, reply, status) => {
    const slow = gated()
    let reads = 0
    const t = setup([P('a', '1')], { send: async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); return reply }, deadlineMs: 60, realNow: true })
    t.readBack.mockImplementation(async () => { if (reads++ === 1) await slow.gate; return { rooms: 1, roomSwitch: 0, roomTemp: 26 } })
    t.batch.prepare(['a'], { roomSwitch: 1 })
    const done = await t.batch.start()
    expect(done.rows[0].status).toBe(status)
    expect(done.rows[0].note).toMatch(/回读在 35 秒截止前未完成/)
    slow.release()
  })

  it('下发前读到房间都关着、这次又要设温度：照发（后端 11/25 答复第 16 条，不再拦）；同时开房间也照发', async () => {
    const t = setup([P('a', '1')], { reads: { a: [{ rooms: 2, roomSwitch: 0, roomTemp: 26 }] } })
    t.batch.prepare(['a'], { roomTemp: 24 })
    await t.batch.start()
    expect(t.wire).toEqual(['a'])
    // 换一个项目（第一条的写锁要到核对一致或到期才放）
    const t2 = setup([P('b', '2')], { reads: { b: [{ rooms: 2, roomSwitch: 0, roomTemp: 26 }] } })
    t2.batch.prepare(['b'], { roomSwitch: 1, roomTemp: 24 })
    await t2.batch.start()
    expect(t2.wire).toEqual(['b'])
  })

  it('确认后强制刷新一次项目列表：最新结果里离线 → 不下发；每批只拉一次', async () => {
    const a = P('a', '1'), b = P('b', '2')
    const refresh = vi.fn(async () => [{ ...a, online: false }, b])
    const w = fakeWire()
    const batch = createUnifiedBatch({ getProjects: () => [a, b], readBack: async () => ({ rooms: 1, roomSwitch: 1, roomTemp: 26 }), send: w.send, log: () => {}, refreshProjects: refresh })
    batch.prepare(['a', 'b'], { roomSwitch: 1 })
    const done = await batch.start()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(w.wire).toEqual(['b'])
    expect(done.rows.map((r) => r.status)).toEqual(['not-sent', 'success'])
  })

  it('刷新项目列表失败：整批不下发、不回读', async () => {
    const readBack = vi.fn(async () => ({ rooms: 1, roomSwitch: 0, roomTemp: 26 }))
    const w = fakeWire()
    const batch = createUnifiedBatch({ getProjects: () => [P('a', '1')], readBack, send: w.send, log: () => {}, refreshProjects: async () => { throw new Error('503') } })
    batch.prepare(['a'], { roomSwitch: 1 })
    const done = await batch.start()
    expect(w.wire).toEqual([])
    expect(readBack).not.toHaveBeenCalled()
    expect(done.rows[0].status).toBe('not-sent')
    expect(done.rows[0].note).toMatch(/刷新项目在线状态失败/)
  })

  it('账号绑定：确认后等令牌续期期间换了账号 → 不发写', async () => {
    const token = gated()
    let acct = 'u1'
    const wire: string[] = []
    const send = vi.fn<BatchSender>(async (_p, _q, o) => { await token.gate; if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); wire.push('a'); return { success: true, msg: '' } })
    const batch = createUnifiedBatch({ getProjects: () => [P('a', '1')], readBack: async () => ({ rooms: 1, roomSwitch: 0, roomTemp: 26 }), send, log: () => {}, getAccount: () => acct })
    batch.prepare(['a'], { roomSwitch: 1 })
    const p = batch.start()
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    acct = 'u2'
    token.release()
    await p
    expect(wire).toEqual([])
    // 账号没变则照发
    acct = 'u1'
    batch.reset(); batch.prepare(['a'], { roomSwitch: 1 })
    const p2 = batch.start(); token.release(); await p2
    expect(wire).toEqual(['a'])
  })

  it('取消信号：beforeSend 最先检查，页面卸载（abort）后信号已中止', async () => {
    const token = gated()
    let sig!: AbortSignal
    const verdicts: boolean[] = []
    const send = vi.fn<BatchSender>(async (_p, _q, o) => { sig = o.signal; await token.gate; verdicts.push(o.beforeSend()); throw new ApiError('write_blocked', 'x') })
    const batch = createUnifiedBatch({ getProjects: () => [P('a', '1')], readBack: async () => ({ rooms: 1, roomSwitch: 0, roomTemp: 26 }), send, log: () => {} })
    batch.prepare(['a'], { roomSwitch: 1 })
    const p = batch.start()
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    batch.abort()
    expect(sig.aborted).toBe(true)
    token.release()
    await p
    expect(verdicts).toEqual([false])
  })

  it('beforeSend：等令牌续期期间项目离线 / 页面卸载 → 不发写', async () => {
    for (const how of ['offline', 'unmount'] as const) {
      const token = gated()
      const a = P('a', '1')
      let list = [a]
      const wire: string[] = []
      const send = vi.fn<BatchSender>(async (_p, _q, o) => {
        await token.gate // 模拟写入口在等令牌续期
        if (!o.beforeSend()) throw new ApiError('write_blocked', 'x')
        wire.push('a')
        return { success: true, msg: '' }
      })
      const batch = createUnifiedBatch({ getProjects: () => list, readBack: async () => ({ rooms: 1, roomSwitch: 0, roomTemp: 26 }), send, log: () => {} })
      batch.prepare(['a'], { roomSwitch: 1 })
      const p = batch.start()
      await vi.waitFor(() => expect(send).toHaveBeenCalled())
      if (how === 'offline') list = [{ ...a, online: false }]
      else batch.abort()
      token.release()
      const done = await p
      expect(wire, how).toEqual([])
      // 写入口拦下：失败（未执行）；页面卸载时则是没开始发就终止
      const st = done.rows[0].state
      expect(st.status === 'failure' && st.outcome, how).toBe('not-sent')
    }
  })

  it('运行中重复 start 返回同一个 Promise；运行中 prepare 无效', async () => {
    const t = setup([P('a', '1')])
    t.batch.prepare(['a'], { roomSwitch: 1 })
    const p1 = t.batch.start()
    expect(t.batch.start()).toBe(p1)
    expect(t.batch.prepare(['a'], { roomSwitch: 0 }).phase).toBe('running')
    await p1
    expect(t.send).toHaveBeenCalledTimes(1)
  })
})
