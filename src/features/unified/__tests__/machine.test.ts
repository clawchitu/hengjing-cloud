// 统一控制状态机。全部用注入的假函数，不连任何后端。
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { WriteProject } from '@/api/guard'
import { TEXT } from '../constants'
import type { UnifiedLogEntry } from '../log'
import { createUnifiedController, INITIAL, outcomeOf, transition, type UnifiedDeps, type UnifiedEvent, type UnifiedState, type UnifiedTarget } from '../machine'
import type { UnifiedContext } from '../rules'

type Snap = { roomTemp: number; roomSwitch: number }
const CTX: UnifiedContext = { projectId: '66cfd7959fb60d63c917fd0a', projectCode: '240829001', projectName: '测试项目0829', appCode: 1, online: true }
const T: UnifiedTarget = { projectId: CTX.projectId, projectCode: '240829001', projectName: '测试项目0829' }
const Q = { systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: 24 }
const BEFORE: Snap = { roomTemp: 22, roomSwitch: 1 }
const AFTER: Snap = { roomTemp: 24, roomSwitch: 1 }

function deferred<V>() {
  let resolve!: (v: V) => void, reject!: (e: unknown) => void
  const promise = new Promise<V>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

function setup(over: Partial<UnifiedDeps<Snap>> = {}, ctx: UnifiedContext | null = CTX) {
  let context: UnifiedContext | null = ctx
  const reads: Snap[] = [BEFORE, AFTER]
  const readBack = vi.fn(async (_id: string, _signal: AbortSignal) => reads.shift() ?? { roomTemp: 0, roomSwitch: 0 })
  const send = vi.fn(async () => ({ success: true, msg: '' }))
  const logs: UnifiedLogEntry[] = []
  const ctl = createUnifiedController<Snap>({
    getContext: () => context,
    readBack,
    send,
    toEcho: (s) => ({ roomTemp: s.roomTemp, roomSwitch: s.roomSwitch }),
    log: (e) => logs.push(e),
    ...over,
  })
  return { ctl, readBack, send, logs, setContext: (c: UnifiedContext | null) => { context = c } }
}

describe('transition（纯函数）', () => {
  const idle: UnifiedState<Snap> = INITIAL
  const confirming = transition<Snap>(idle, { type: 'REQUEST', target: T, draft: { roomTemp: 24 }, query: Q })
  const sending = transition<Snap>(confirming, { type: 'CONFIRM' })
  const sent = transition<Snap>(sending, { type: 'STEP', step: 'send', before: BEFORE })
  const reading = transition<Snap>(sent, { type: 'STEP', step: 'read-after' })
  const success = transition<Snap>(reading, { type: 'SUCCEED', via: 'reply', verified: true, before: BEFORE, after: AFTER, mismatches: [] })
  const failure = transition<Snap>(reading, { type: 'FAIL', outcome: 'rejected', error: 'x' })
  const unknown = transition<Snap>(reading, { type: 'UNKNOWN', cause: 'timeout', before: BEFORE, after: null, mismatches: [] })

  it('合法转移', () => {
    expect(transition<Snap>(idle, { type: 'REJECT', errors: ['e'] })).toEqual({ status: 'idle', errors: ['e'] })
    expect(confirming).toMatchObject({ status: 'confirming', target: T, query: Q, items: [{ label: TEXT.roomTemp, value: '24°C' }] })
    expect(transition(confirming, { type: 'CANCEL' })).toEqual({ status: 'idle', errors: [] })
    expect(transition(confirming, { type: 'ABORT', errors: ['a'] })).toEqual({ status: 'idle', errors: ['a'] })
    expect(sending).toEqual({ status: 'sending', target: T, query: Q, step: 'read-before' })
    expect(transition(sending, { type: 'ABORT', errors: ['a'] })).toEqual({ status: 'idle', errors: ['a'] })
    expect(sent).toMatchObject({ step: 'send', before: BEFORE })
    expect(reading).toMatchObject({ step: 'read-after', before: BEFORE })
    expect(success).toMatchObject({ status: 'success', via: 'reply', verified: true, before: BEFORE, after: AFTER })
    expect(failure).toMatchObject({ status: 'failure', outcome: 'rejected', error: 'x' })
    expect(unknown).toMatchObject({ status: 'unknown', error: TEXT.unconfirmed, cause: 'timeout' })
    for (const end of [success, failure, unknown]) expect(transition(end, { type: 'RESET' })).toEqual({ status: 'idle', errors: [] })
  })

  it('不合法的事件原样返回（同一引用）', () => {
    const all: UnifiedEvent<Snap>[] = [
      { type: 'REJECT', errors: [] }, { type: 'REQUEST', target: T, draft: {}, query: Q }, { type: 'CANCEL' }, { type: 'CONFIRM' },
      { type: 'ABORT', errors: [] }, { type: 'STEP', step: 'send' }, { type: 'SUCCEED', via: 'reply', verified: false, before: BEFORE, after: null, mismatches: [] },
      { type: 'FAIL', outcome: 'not-sent', error: '' }, { type: 'UNKNOWN', cause: '', before: BEFORE, after: null, mismatches: [] }, { type: 'RESET' },
    ]
    const cases: Array<[UnifiedState<Snap>, string, string[]]> = [
      [idle, 'idle', ['REJECT', 'REQUEST']],
      [confirming, 'confirming', ['CANCEL', 'CONFIRM', 'ABORT']],
      [sending, 'sending:read-before', ['ABORT', 'STEP', 'SUCCEED', 'FAIL', 'UNKNOWN']],
      [sent, 'sending:send', ['STEP', 'SUCCEED', 'FAIL', 'UNKNOWN']],
      [reading, 'sending:read-after', ['STEP', 'SUCCEED', 'FAIL', 'UNKNOWN']],
      [success, 'success', ['RESET']],
      [failure, 'failure', ['RESET']],
      [unknown, 'unknown', ['RESET']],
    ]
    for (const [s, name, allowed] of cases) {
      for (const e of all) {
        const next = transition(s, e)
        if (allowed.includes(e.type)) expect(next, `${name} + ${e.type}`).not.toBe(s)
        else expect(next, `${name} + ${e.type}`).toBe(s)
      }
    }
  })

  it('发出之后不能 ABORT / CONFIRM / RESET / CANCEL', () => {
    for (const s of [sent, reading]) for (const type of ['ABORT', 'CONFIRM', 'RESET', 'CANCEL'] as const) {
      expect(transition(s, type === 'ABORT' ? { type, errors: [] } : { type })).toBe(s)
    }
  })
})

describe('控制器：正常流程', () => {
  it('idle → confirming → sending → success（已核对）；前后各读一次，下发一次', async () => {
    const { ctl, readBack, send, logs } = setup()
    const seen: string[] = []
    ctl.subscribe(() => { const s = ctl.getState(); seen.push(s.status + (s.status === 'sending' ? ':' + s.step : '')) })
    expect(ctl.request({ roomTemp: 24 })).toMatchObject({ status: 'confirming', target: T, query: Q })
    expect(send).not.toHaveBeenCalled()
    const end = await ctl.confirm()
    expect(end).toEqual({ status: 'success', target: T, query: Q, via: 'reply', verified: true, before: BEFORE, after: AFTER, afterError: undefined, mismatches: [] })
    expect(seen).toEqual(['confirming', 'sending:read-before', 'sending:send', 'sending:read-after', 'success'])
    expect(readBack).toHaveBeenCalledTimes(2)
    expect(readBack.mock.calls[0][0]).toBe(CTX.projectId)
    expect(readBack.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ id: CTX.projectId, code: CTX.projectCode }, Q)
    expect(readBack.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(readBack.mock.invocationCallOrder[1])
    expect(logs.map((l) => l.event)).toEqual(['confirm', 'read-before', 'send', 'read-after', 'success'])
    ctl.reset()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [] })
  })

  it('cancel：confirming → idle，不读不发', () => {
    const { ctl, readBack, send } = setup()
    ctl.request({ roomSwitch: 1 })
    ctl.cancel()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [] })
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('校验不过停在 idle 并带 errors；非 idle 时 request 无效', () => {
    const { ctl } = setup({}, { ...CTX, appCode: 12 })
    expect(ctl.request({ roomTemp: 24 })).toEqual({ status: 'idle', errors: [TEXT.tempDisabledByApp] })
    ctl.request({ roomSwitch: 1 })
    const confirming = ctl.getState()
    expect(ctl.request({ systemSwitch: 0 })).toBe(confirming)
  })

  it('Reply 成功但回读不一致：success、verified=false，带逐字段不一致项', async () => {
    const { ctl } = setup({ readBack: vi.fn(async () => BEFORE) })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success', via: 'reply', verified: false, mismatches: [{ field: 'roomTemp', kind: 'differ' }] })
  })

  it('Reply 成功但下发后回读失败：仍是 success（已生效），verified=false，带 afterError', async () => {
    let n = 0
    const { ctl } = setup({ readBack: vi.fn(async () => { if (n++) throw new ApiError('unavailable', '控制屏未连接'); return BEFORE }) })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success', verified: false, after: null, afterError: `${TEXT.readAfterFailed}：控制屏未连接`, mismatches: [{ field: 'roomTemp', kind: 'missing' }] })
  })

  it('toEcho 抛错按没读到处理', async () => {
    const { ctl } = setup({ toEcho: () => { throw new Error('映射失败') } })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success', verified: false, mismatches: [{ field: 'roomTemp', kind: 'missing' }] })
  })
})

describe('控制器：离线与复核', () => {
  it('离线时 request 被拦截，不读不发', () => {
    const { ctl, readBack, send, logs } = setup({}, { ...CTX, online: false })
    expect(ctl.request({ roomSwitch: 1 })).toEqual({ status: 'idle', errors: [TEXT.offline] })
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(logs[0]).toMatchObject({ event: 'blocked', codes: ['OFFLINE'] })
  })

  it.each([
    ['离线', (c: UnifiedContext) => ({ ...c, online: false }), [TEXT.offline]],
    ['app_code 变成 8', (c: UnifiedContext) => ({ ...c, appCode: 8 }), [TEXT.tempDisabledByApp]],
    ['切换了项目', (c: UnifiedContext) => ({ ...c, projectId: 'other-project-000000' }), [TEXT.projectChanged]],
    ['项目 code 变了', (c: UnifiedContext) => ({ ...c, projectCode: '260911001' }), [TEXT.projectChanged]],
    ['项目没了', () => null, [TEXT.projectChanged]],
  ] as const)('确认弹窗打开期间%s：confirm 退回 idle，不读不发', async (_n, change, errors) => {
    const { ctl, send, readBack, setContext } = setup()
    ctl.request({ roomTemp: 24 })
    setContext(change(CTX))
    expect(await ctl.confirm()).toEqual({ status: 'idle', errors })
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['离线', (c: UnifiedContext) => ({ ...c, online: false }), [TEXT.offline]],
    ['换了项目 id', (c: UnifiedContext) => ({ ...c, projectId: 'another-project-0001' }), [TEXT.projectChanged]],
    ['项目 code 变了', (c: UnifiedContext) => ({ ...c, projectCode: '260911001' }), [TEXT.projectChanged]],
    ['项目没了', () => null, [TEXT.projectChanged]],
    ['app_code 变成 12', (c: UnifiedContext) => ({ ...c, appCode: 12 }), [TEXT.tempDisabledByApp]],
    ['温度范围收窄', (c: UnifiedContext) => ({ ...c, tempRange: { max: 23 } }), [TEXT.tempOutOfRange({ min: 16, max: 23, step: 0.5 })]],
  ] as const)('下发前读取期间%s：终止，回 idle，不下发', async (_n, change, errors) => {
    const gate = deferred<Snap>()
    const readBack = vi.fn(() => gate.promise)
    const { ctl, send, setContext, logs } = setup({ readBack })
    ctl.request({ roomSwitch: 1, roomTemp: 24 })
    const p = ctl.confirm()
    setContext(change(CTX))
    gate.resolve(BEFORE)
    expect(await p).toEqual({ status: 'idle', errors })
    expect(send).not.toHaveBeenCalled()
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(logs.at(-1)).toMatchObject({ event: 'aborted', codes: ['PROJECT_CHANGED'] })
  })

  it('idle 下调 confirm 无效', async () => {
    const { ctl, send } = setup()
    expect(await ctl.confirm()).toEqual(INITIAL)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('控制器：abort（页面卸载、切换项目）', () => {
  it('confirming 时 abort → idle', () => {
    const { ctl } = setup()
    ctl.request({ roomSwitch: 1 })
    ctl.abort()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [TEXT.aborted] })
  })

  it('下发前读取期间 abort：signal 取消、立即回 idle；读取之后完成也不下发', async () => {
    const gate = deferred<Snap>()
    let seenSignal: AbortSignal | null = null
    const readBack = vi.fn((_id: string, signal: AbortSignal) => { seenSignal = signal; return gate.promise })
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomSwitch: 1 })
    const p = ctl.confirm()
    ctl.abort()
    expect(seenSignal!.aborted).toBe(true)
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [TEXT.aborted] })
    gate.resolve(BEFORE) // 读取函数没理会 signal，照样返回
    await p
    expect(send).not.toHaveBeenCalled()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [TEXT.aborted] })
  })

  it('读取函数响应 signal 而报错：同样回 idle，不算失败', async () => {
    const readBack = vi.fn((_id: string, signal: AbortSignal) => new Promise<Snap>((_r, rej) => signal.addEventListener('abort', () => rej(new ApiError('aborted', '请求已取消')))))
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomSwitch: 1 })
    const p = ctl.confirm()
    ctl.abort()
    await p
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [TEXT.aborted] })
    expect(send).not.toHaveBeenCalled()
  })

  it('abort 后立即开始新一轮：旧一轮的读取晚到不影响新一轮，只下发新一轮', async () => {
    const g1 = deferred<Snap>()
    const readBack = vi.fn().mockReturnValueOnce(g1.promise).mockResolvedValue(AFTER)
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomSwitch: 1 })
    const p1 = ctl.confirm()
    ctl.abort()
    ctl.request({ roomSwitch: 0 })
    const p2 = ctl.confirm()
    expect(p2).not.toBe(p1)
    g1.resolve(BEFORE)
    await p1
    expect((await p2).status).toBe('success')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ id: CTX.projectId, code: CTX.projectCode }, { systemSwitch: -1, systemMode: 0, roomSwitch: 0, roomTemp: -1 })
  })

  it('已经发出后 abort 无效：照常走完回读', async () => {
    const gate = deferred<{ success: boolean; msg: string }>()
    const send = vi.fn(() => gate.promise)
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomTemp: 24 })
    const p = ctl.confirm()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    ctl.abort()
    expect(ctl.getState()).toMatchObject({ status: 'sending', step: 'send' })
    gate.resolve({ success: true, msg: '' })
    expect(await p).toMatchObject({ status: 'success', verified: true })
    expect(readBack).toHaveBeenCalledTimes(2)
  })

  it('CONFIRM 通知里订阅者调用 abort：本轮作废，不读不发，回 idle', async () => {
    const { ctl, readBack, send } = setup()
    ctl.subscribe(() => { if (ctl.getState().status === 'sending') ctl.abort() })
    ctl.request({ roomSwitch: 1 })
    const end = await ctl.confirm()
    expect(end).toEqual({ status: 'idle', errors: [TEXT.aborted] })
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    // 之后还能正常开始新一轮（没有残留的 inflight）
    ctl.request({ roomSwitch: 1 })
    expect(ctl.getState().status).toBe('confirming')
  })

  it('confirm 日志回调里调用 abort：本轮作废，不读不发', async () => {
    let ctlRef: { abort: () => void } | null = null
    const { ctl, readBack, send } = setup({ log: (e) => { if (e.event === 'confirm') ctlRef!.abort() } })
    ctlRef = ctl
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toEqual({ status: 'idle', errors: [TEXT.aborted] })
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('「最后核对 → send」之间不触发任何回调：日志和通知都在 send 调用之后', async () => {
    const order: string[] = []
    let ctlRef: { getState: () => UnifiedState<Snap> } | null = null
    const send = vi.fn(async () => { order.push('send'); return { success: true, msg: '' } })
    const readBack = vi.fn(async () => { order.push('readBack'); return order.filter((x) => x === 'readBack').length > 1 ? AFTER : BEFORE })
    const { ctl } = setup({ send, readBack, log: (e) => order.push(`log:${e.event}`) })
    ctlRef = ctl
    ctl.subscribe(() => { const st = ctlRef!.getState(); order.push(`notify:${st.status}${st.status === 'sending' ? ':' + st.step : ''}`) })
    ctl.request({ roomTemp: 24 })
    await ctl.confirm()
    const i = order.indexOf('send')
    // 前读完成之后、send 之前什么都没有
    expect(order[i - 1]).toBe('readBack')
    expect(order.slice(i + 1, i + 4)).toEqual(['log:read-before', 'notify:sending:send', 'log:send'])
    // confirm 时先通知再写日志，然后才开始前读
    expect(order.slice(0, 4)).toEqual(['notify:confirming', 'notify:sending:read-before', 'log:confirm', 'readBack'])
  })

  it.each([
    ['read-before 日志回调', 'log'],
    ['STEP send 的订阅通知', 'notify'],
  ] as const)('send 调用之后（%s 里）切换项目并 abort：视为已发出，abort 无效，照常走完回读', async (_n, where) => {
    let ctlRef: { abort: () => void; getState: () => UnifiedState<Snap> } | null = null
    let setCtx: ((c: UnifiedContext | null) => void) | null = null
    let fired = false
    const fire = () => { if (fired) return; fired = true; setCtx!({ ...CTX, projectId: 'other-project-000000', projectCode: '260911001' }); ctlRef!.abort() }
    const { ctl, send, readBack, setContext } = setup({ log: (e) => { if (where === 'log' && e.event === 'read-before') fire() } })
    ctlRef = ctl; setCtx = setContext
    ctl.subscribe(() => { const st = ctl.getState(); if (where === 'notify' && st.status === 'sending' && st.step === 'send') fire() })
    ctl.request({ roomTemp: 24 })
    const end = await ctl.confirm()
    expect(fired).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    expect(end).toMatchObject({ status: 'success', verified: true })
  })

  it('send 内部同步调用 abort：已视为发出，abort 无效', async () => {
    let ctlRef: { abort: () => void } | null = null
    const send = vi.fn(async (_p: WriteProject, _q: typeof Q) => ({ success: true, msg: '' }))
    const sendWrap = vi.fn((p: WriteProject, q: typeof Q) => { ctlRef!.abort(); return send(p, q) })
    const { ctl } = setup({ send: sendWrap })
    ctlRef = ctl
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('上一轮已发出的标记不影响下一轮：新一轮前读期间 abort 仍能终止', async () => {
    const gate = deferred<Snap>()
    const readBack = vi.fn().mockResolvedValueOnce(BEFORE).mockResolvedValueOnce(AFTER).mockReturnValueOnce(gate.promise)
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomSwitch: 1 })
    expect((await ctl.confirm()).status).toBe('success')
    ctl.reset()
    ctl.request({ roomSwitch: 0 })
    const p = ctl.confirm()
    ctl.abort()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [TEXT.aborted] })
    gate.resolve(BEFORE)
    await p
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('idle 时 abort 无副作用', () => {
    const { ctl, logs } = setup()
    ctl.abort()
    expect(ctl.getState()).toBe(INITIAL)
    expect(logs).toHaveLength(0)
  })
})

describe('控制器：重复点击', () => {
  it('sending 期间连点确认只下发一次，返回同一个 Promise', async () => {
    const gate = deferred<{ success: boolean; msg: string }>()
    const send = vi.fn(() => gate.promise)
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomTemp: 24 })
    const p1 = ctl.confirm()
    expect(ctl.confirm()).toBe(p1)
    expect(ctl.confirm()).toBe(p1)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    ctl.request({ roomSwitch: 0 }); ctl.cancel(); ctl.reset()
    expect(ctl.getState()).toMatchObject({ status: 'sending' })
    gate.resolve({ success: true, msg: '' })
    await p1
    expect(ctl.getState().status).toBe('success')
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    await ctl.confirm()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('下发前读取期间重复点击也只读一次', async () => {
    const gate = deferred<Snap>()
    const readBack = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(AFTER)
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomTemp: 24 })
    const p = ctl.confirm(); ctl.confirm(); ctl.confirm()
    expect(readBack).toHaveBeenCalledTimes(1)
    gate.resolve(BEFORE)
    await p
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
  })
})

describe('控制器：结果未知（unknown）', () => {
  it.each([
    ['timeout', '未收到控制屏应答，下发结果未知'],
    ['network', '网络中断，下发结果未知'],
  ] as const)('%s 且回读逐字段一致 → success（via=readback，已核对）', async (kind, msg) => {
    const send = vi.fn(async () => { throw new ApiError(kind, msg) })
    const { ctl, readBack, logs } = setup({ send })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success', via: 'readback', verified: true, after: AFTER, mismatches: [] })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    expect(logs.at(-1)).toMatchObject({ event: 'success', codes: ['UNKNOWN', 'VERIFIED'], errorKind: kind })
  })

  it('超时且回读不一致 → unknown，提示结果未确认，带不一致字段；不重试', async () => {
    const send = vi.fn(async () => { throw new ApiError('timeout', '未收到控制屏应答，下发结果未知') })
    const readBack = vi.fn(async () => BEFORE)
    const { ctl } = setup({ send, readBack })
    ctl.request({ roomTemp: 24, roomSwitch: 1 })
    const end = await ctl.confirm()
    expect(end).toMatchObject({ status: 'unknown', error: TEXT.unconfirmed, cause: '未收到控制屏应答，下发结果未知', mismatches: [{ field: 'roomTemp', kind: 'differ' }] })
    expect(TEXT.unconfirmed).toBe('结果未确认，请刷新查看')
    await new Promise((r) => setTimeout(r, 20))
    await ctl.confirm()
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    ctl.reset()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [] })
  })

  it('超时且下发后回读失败 → unknown，所有下发字段记为没读到', async () => {
    let n = 0
    const send = vi.fn(async () => { throw new ApiError('timeout', 'x') })
    const { ctl } = setup({ send, readBack: vi.fn(async () => { if (n++) throw new Error('读失败'); return BEFORE }) })
    ctl.request({ roomTemp: 24, systemSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({
      status: 'unknown', error: TEXT.unconfirmed, after: null, afterError: `${TEXT.readAfterFailedUnknown}：读失败`,
      mismatches: [{ field: 'systemSwitch', kind: 'missing' }, { field: 'roomTemp', kind: 'missing' }],
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['服务端 500', new ApiError('server', '内部错误', { status: 500, code: 13 }), 'unknown'],
    ['控制屏 503', new ApiError('unavailable', '控制屏消息发送失败', { status: 503, code: 14 }), 'unknown'],
    ['后端返回取消 code 1', new ApiError('aborted', '请求已取消', { status: 499, code: 1 }), 'unknown'],
    ['发出后被取消（无状态 aborted）', new ApiError('aborted', '请求已取消'), 'unknown'],
    ['普通异常', new Error('boom'), 'unknown'],
    ['后端参数错误 code 3', new ApiError('bad_request', '参数错误', { status: 400, code: 3 }), 'rejected'],
    ['网关无权限', new ApiError('forbidden', '无权限', { status: 403 }), 'rejected'],
    ['令牌失效（网关拒绝，未转给控制屏）', new ApiError('unauthenticated', '登录已过期', { status: 401, code: 16 }), 'not-sent'],
    ['控制屏 success=false', new ApiError('ctrl', '该软件类型不支持此控制'), 'rejected'],
    ['前端写防护（无状态）', new ApiError('write_blocked', '下发已关闭'), 'not-sent'],
    ['写消息校验不过（无状态）', new ApiError('bad_request', '写消息缺少字段'), 'not-sent'],
  ] as const)('%s → %3$s', async (_n, err, outcome) => {
    expect(outcomeOf(err)).toBe(outcome)
    const send = vi.fn(async () => { throw err })
    const readBack = vi.fn(async () => BEFORE) // 回读不一致
    const { ctl } = setup({ send, readBack })
    ctl.request({ roomSwitch: 0 })
    const end = await ctl.confirm()
    if (outcome === 'unknown') expect(end).toMatchObject({ status: 'unknown' })
    else expect(end).toMatchObject({ status: 'failure', outcome })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(outcome === 'not-sent' ? 1 : 2)
  })
})

describe('控制器：下发函数正常返回 success!==true', () => {
  it.each([
    [{ success: false, msg: '控制屏忙' }, `${TEXT.failure}：控制屏忙`],
    [{ success: false, msg: '' }, `${TEXT.failure}：下发失败`],
    [{ msg: 'x' }, `${TEXT.failure}：x`],
    [null, `${TEXT.failure}：下发失败`],
  ])('%j → failure/rejected（不是 unknown，回读一致也不算成功）；只发一次', async (reply, error) => {
    const send = vi.fn(async () => reply as never)
    const { ctl, readBack } = setup({ send }) // 回读与目标一致
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'rejected', error })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
  })
})

describe('控制器：先更新状态、后写日志', () => {
  it.each(['cancel', 'abort'] as const)('%s：日志回调里看到的已经是 idle；回调里调 confirm 也不会下发', async (op) => {
    let ctlRef: ReturnType<typeof setup>['ctl'] | null = null
    const seen: string[] = []
    const { ctl, send, readBack } = setup({ log: (e) => { if (e.event === 'cancel' || e.event === 'aborted') { seen.push(ctlRef!.getState().status); void ctlRef!.confirm() } } })
    ctlRef = ctl
    ctl.request({ roomSwitch: 1 })
    ctl[op]()
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['idle'])
    expect(send).not.toHaveBeenCalled()
    expect(readBack).not.toHaveBeenCalled()
  })
})

describe('控制器：失败不重试', () => {
  it('控制屏拒绝 → failure/rejected；只发一次，回读一次', async () => {
    const send = vi.fn(async () => { throw new ApiError('ctrl', '该软件类型不支持此控制') })
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'rejected', error: `${TEXT.failure}：该软件类型不支持此控制`, before: BEFORE, after: AFTER })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    await new Promise((r) => setTimeout(r, 20))
    await ctl.confirm()
    expect(send).toHaveBeenCalledTimes(1)
    ctl.reset()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [] })
  })

  it('写防护拦截 → failure/not-sent，不做下发后回读', async () => {
    const send = vi.fn(async () => { throw new ApiError('write_blocked', '下发已关闭（writeMode=off）') })
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomSwitch: 1 })
    const end = await ctl.confirm()
    expect(end).toMatchObject({ status: 'failure', outcome: 'not-sent' })
    expect((end as { after?: unknown }).after).toBeUndefined()
    expect(readBack).toHaveBeenCalledTimes(1)
  })

  it('下发前读取失败：不下发，failure/not-sent', async () => {
    const readBack = vi.fn(async () => { throw new ApiError('unavailable', '控制屏未连接') })
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'not-sent', error: `${TEXT.readBeforeFailed}：控制屏未连接` })
    expect(send).not.toHaveBeenCalled()
    expect(readBack).toHaveBeenCalledTimes(1)
  })
})

describe('控制器：其他', () => {
  it('日志抛错不影响下发', async () => {
    const { ctl, send } = setup({ log: () => { throw new Error('log down') } })
    ctl.request({ roomSwitch: 1 })
    expect((await ctl.confirm()).status).toBe('success')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('退订后不再收到通知', () => {
    const { ctl } = setup()
    const fn = vi.fn()
    const off = ctl.subscribe(fn)
    off()
    ctl.request({ roomSwitch: 1 })
    expect(fn).not.toHaveBeenCalled()
  })
})
