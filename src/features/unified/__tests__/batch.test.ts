// S12b 批量控制器：逐个项目走 S12a 状态机。下发函数、回读都注入假的，不连任何接口。
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'
import { createUnifiedBatch, summarizeRooms, unifiedAppCode, type BatchProject, type BatchSender, type UnifiedSnapshot } from '../batch'

const P = (id: string, code: string, extra: Partial<BatchProject> = {}): BatchProject => ({ id, code, name: '项目' + code, programCode: 1, online: true, ...extra })

function setup(projects: BatchProject[], opts: { send?: BatchSender; reads?: Record<string, UnifiedSnapshot[]> } = {}) {
  let list = projects
  const reads = opts.reads ?? {}
  const readBack = vi.fn(async (id: string) => reads[id]?.shift() ?? { rooms: 2, roomSwitch: 1, roomTemp: 26 })
  const send = vi.fn(opts.send ?? (async () => ({ success: true, msg: '' })))
  const batch = createUnifiedBatch({ getProjects: () => list, readBack, send, log: () => {}, now: () => new Date('2026-11-24T10:00:00') })
  return { batch, readBack, send, setList: (l: BatchProject[]) => { list = l } }
}

describe('summarizeRooms（ctrl 200 → 回读快照）', () => {
  it('全部房间一致才给值；65536 / -1 视为没读到；不一致为 null', () => {
    expect(summarizeRooms([{ switch: 1, setTemp: 25.5 }, { switch: 1, setTemp: 25.5 }])).toEqual({ rooms: 2, roomSwitch: 1, roomTemp: 25.5 })
    expect(summarizeRooms([{ switch: 1, setTemp: 25.5 }, { switch: 0, setTemp: 26 }])).toEqual({ rooms: 2, roomSwitch: null, roomTemp: null })
    expect(summarizeRooms([{ switch: 65536, setTemp: 65536 }])).toEqual({ rooms: 1, roomSwitch: null, roomTemp: null })
    expect(summarizeRooms([])).toEqual({ rooms: 0, roomSwitch: null, roomTemp: null })
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
    expect(s.status === 'success' && [s.before, s.after, s.verified]).toEqual([{ rooms: 2, roomSwitch: 0, roomTemp: 26 }, { rooms: 2, roomSwitch: 1, roomTemp: 26 }, true])
    expect(done.rows[0].at).toBe('10:00:00')
  })

  it('控制屏拒绝 → 失败，只发一次，不重试；下一个项目照常', async () => {
    let n = 0
    const { batch, send } = setup([P('a', '1'), P('b', '2')], { send: async () => (n++ === 0 ? { success: false, msg: '设备忙' } : { success: true, msg: '' }) })
    batch.prepare(['a', 'b'], { roomSwitch: 0 })
    const done = await batch.start()
    expect(send).toHaveBeenCalledTimes(2)
    expect(done.rows.map((r) => r.status)).toEqual(['failure', 'success'])
    // 再调 start 不会重发
    await batch.start()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('超时且回读不一致 → 结果未确认（unknown），不重试', async () => {
    const { batch, send } = setup([P('a', '1')], {
      send: async () => { throw new ApiError('timeout', '请求超时') },
      reads: { a: [{ rooms: 1, roomSwitch: 1, roomTemp: 26 }, { rooms: 1, roomSwitch: 1, roomTemp: 26 }] },
    })
    batch.prepare(['a'], { roomTemp: 22 })
    const done = await batch.start()
    expect(send).toHaveBeenCalledTimes(1)
    expect(done.rows[0].status).toBe('unknown')
    expect(done.rows[0].state.status === 'unknown' && done.rows[0].state.error).toBe('结果未确认，请刷新查看')
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
