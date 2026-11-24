// 统一控制状态机。全部用注入的假函数，不连任何后端。
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { TEXT } from '../constants'
import type { UnifiedLogEntry } from '../log'
import { createUnifiedController, INITIAL, outcomeOf, transition, type UnifiedEvent, type UnifiedState, type UnifiedTarget } from '../machine'
import type { UnifiedContext } from '../rules'

type Snap = { roomTemp: number; roomSwitch: number }
const CTX: UnifiedContext = { projectId: '66cfd7959fb60d63c917fd0a', projectCode: '240829001', projectName: '测试项目0829', appCode: 1, online: true }
const T: UnifiedTarget = { projectId: CTX.projectId, projectCode: '240829001', projectName: '测试项目0829' }
const Q = { systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: 24 }

function deferred<V>() {
  let resolve!: (v: V) => void, reject!: (e: unknown) => void
  const promise = new Promise<V>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

function setup(over: Partial<Parameters<typeof createUnifiedController<Snap>>[0]> = {}, ctx: UnifiedContext | null = CTX) {
  let context: UnifiedContext | null = ctx
  const reads: Snap[] = [{ roomTemp: 22, roomSwitch: 1 }, { roomTemp: 24, roomSwitch: 1 }]
  const readBack = vi.fn(async () => reads.shift() ?? { roomTemp: 0, roomSwitch: 0 })
  const send = vi.fn(async () => ({ success: true, msg: '' }))
  const logs: UnifiedLogEntry[] = []
  const ctl = createUnifiedController<Snap>({
    getContext: () => context,
    readBack,
    send,
    verify: () => [],
    log: (e) => logs.push(e),
    ...over,
  })
  return { ctl, readBack, send, logs, setContext: (c: UnifiedContext | null) => { context = c } }
}

describe('transition（纯函数）', () => {
  const idle: UnifiedState<Snap> = INITIAL
  const confirming = transition<Snap>(idle, { type: 'REQUEST', target: T, draft: { roomTemp: 24 }, query: Q })
  const sending = transition<Snap>(confirming, { type: 'CONFIRM' })
  const before = { roomTemp: 22, roomSwitch: 1 }
  const success = transition<Snap>(sending, { type: 'SUCCEED', before, after: before, mismatches: [] })
  const failure = transition<Snap>(sending, { type: 'FAIL', outcome: 'rejected', error: 'x' })

  it('合法转移', () => {
    expect(transition<Snap>(idle, { type: 'REJECT', errors: ['e'] })).toEqual({ status: 'idle', errors: ['e'] })
    expect(confirming).toMatchObject({ status: 'confirming', target: T, query: Q, items: [{ label: TEXT.roomTemp, value: '24°C' }] })
    expect(transition(confirming, { type: 'CANCEL' })).toEqual({ status: 'idle', errors: [] })
    expect(sending).toEqual({ status: 'sending', target: T, query: Q, step: 'read-before' })
    expect(transition(sending, { type: 'STEP', step: 'send', before })).toMatchObject({ step: 'send', before })
    expect(transition(transition(sending, { type: 'STEP', step: 'send', before }), { type: 'STEP', step: 'read-after' })).toMatchObject({ step: 'read-after', before })
    expect(success).toMatchObject({ status: 'success', before, after: before, mismatches: [] })
    expect(failure).toMatchObject({ status: 'failure', outcome: 'rejected', error: 'x' })
    expect(transition(success, { type: 'RESET' })).toEqual({ status: 'idle', errors: [] })
    expect(transition(failure, { type: 'RESET' })).toEqual({ status: 'idle', errors: [] })
  })

  it('不合法的事件原样返回（同一引用）', () => {
    const all: UnifiedEvent<Snap>[] = [
      { type: 'REJECT', errors: [] }, { type: 'REQUEST', target: T, draft: {}, query: Q }, { type: 'CANCEL' }, { type: 'CONFIRM' },
      { type: 'STEP', step: 'send' }, { type: 'SUCCEED', before, after: null, mismatches: [] }, { type: 'FAIL', outcome: 'unknown', error: '' }, { type: 'RESET' },
    ]
    const allowed: Record<string, string[]> = {
      idle: ['REJECT', 'REQUEST'],
      confirming: ['CANCEL', 'CONFIRM'],
      sending: ['STEP', 'SUCCEED', 'FAIL'],
      success: ['RESET'],
      failure: ['RESET'],
    }
    for (const s of [idle, confirming, sending, success, failure]) {
      for (const e of all) {
        const next = transition(s, e)
        if (allowed[s.status].includes(e.type)) expect(next, `${s.status} + ${e.type}`).not.toBe(s)
        else expect(next, `${s.status} + ${e.type}`).toBe(s)
      }
    }
  })

  it('sending 里不能直接 CONFIRM / RESET / CANCEL（防重复提交、不能中途放弃）', () => {
    expect(transition(sending, { type: 'CONFIRM' })).toBe(sending)
    expect(transition(sending, { type: 'RESET' })).toBe(sending)
    expect(transition(sending, { type: 'CANCEL' })).toBe(sending)
  })
})

describe('控制器：正常流程', () => {
  it('idle → confirming → sending → success；前后各读一次，下发一次', async () => {
    const { ctl, readBack, send, logs } = setup()
    const seen: string[] = []
    ctl.subscribe(() => seen.push(ctl.getState().status + (ctl.getState().status === 'sending' ? ':' + (ctl.getState() as { step: string }).step : '')))
    expect(ctl.request({ roomTemp: 24 })).toMatchObject({ status: 'confirming', target: T, query: Q })
    expect(send).not.toHaveBeenCalled()
    const end = await ctl.confirm()
    expect(end).toEqual({ status: 'success', target: T, query: Q, before: { roomTemp: 22, roomSwitch: 1 }, after: { roomTemp: 24, roomSwitch: 1 }, afterError: undefined, mismatches: [] })
    expect(seen).toEqual(['confirming', 'sending:read-before', 'sending:send', 'sending:read-after', 'success'])
    expect(readBack).toHaveBeenCalledTimes(2)
    expect(readBack).toHaveBeenNthCalledWith(1, CTX.projectId)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(CTX.projectId, Q)
    // 调用顺序：读 → 发 → 读
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

  it('校验不过停在 idle 并带 errors；非 idle 时 request 无效', async () => {
    const { ctl } = setup({}, { ...CTX, appCode: 12 })
    expect(ctl.request({ roomTemp: 24 })).toEqual({ status: 'idle', errors: [TEXT.tempDisabledByApp] })
    ctl.request({ roomSwitch: 1 })
    const confirming = ctl.getState()
    expect(ctl.request({ systemSwitch: 0 })).toBe(confirming)
  })

  it('verify 给出的不一致项记在 success 里', async () => {
    const { ctl } = setup({ verify: (q, _b, a) => (a.roomTemp === q.roomTemp ? [] : [`温度回读 ${a.roomTemp}`]), readBack: vi.fn(async () => ({ roomTemp: 22, roomSwitch: 1 })) })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success', mismatches: ['温度回读 22'] })
  })

  it('下发后回读失败：仍是 success（Reply success 即已生效），带 afterError', async () => {
    let n = 0
    const { ctl } = setup({ readBack: vi.fn(async () => { if (n++) throw new ApiError('unavailable', '控制屏未连接'); return { roomTemp: 22, roomSwitch: 1 } }) })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success', after: null, afterError: `${TEXT.readAfterFailed}：控制屏未连接`, mismatches: [] })
  })

  it('verify 抛错时带前缀记为不一致', async () => {
    const { ctl } = setup({ verify: () => { throw new Error('映射失败') } })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success', mismatches: [`${TEXT.verifyFailed}：映射失败`] })
  })

  it('下发失败且回读失败：afterError 不说「已生效」', async () => {
    let n = 0
    const { ctl } = setup({
      send: vi.fn(async () => { throw new ApiError('timeout', '未收到控制屏应答，下发结果未知') }),
      readBack: vi.fn(async () => { if (n++) throw new Error('x'); return { roomTemp: 22, roomSwitch: 1 } }),
    })
    ctl.request({ roomTemp: 24 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'unknown', after: null, afterError: `${TEXT.readAfterFailedUnknown}：x` })
  })
})

describe('控制器：离线与复核', () => {
  it('离线时 request 被拦截，不读不发', () => {
    const { ctl, readBack, send, logs } = setup({}, { ...CTX, online: false })
    expect(ctl.request({ roomSwitch: 1 })).toEqual({ status: 'idle', errors: [TEXT.offline] })
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(logs[0]).toMatchObject({ event: 'blocked', message: TEXT.offline })
  })

  it('确认弹窗打开期间项目离线：confirm 退回 idle，不发', async () => {
    const { ctl, send, readBack, setContext } = setup()
    ctl.request({ roomSwitch: 1 })
    setContext({ ...CTX, online: false })
    expect(await ctl.confirm()).toEqual({ status: 'idle', errors: [TEXT.offline] })
    expect(readBack).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('确认弹窗打开期间 app_code 变成 8：confirm 退回 idle，不发', async () => {
    const { ctl, send, setContext } = setup()
    ctl.request({ roomTemp: 24 })
    setContext({ ...CTX, appCode: 8 })
    expect(await ctl.confirm()).toEqual({ status: 'idle', errors: [TEXT.tempDisabledByApp] })
    expect(send).not.toHaveBeenCalled()
  })

  it('确认弹窗打开期间切换了项目：confirm 退回 idle，不发', async () => {
    const { ctl, send, setContext } = setup()
    ctl.request({ roomSwitch: 1 })
    setContext({ ...CTX, projectId: 'other-project-000000' })
    expect(await ctl.confirm()).toEqual({ status: 'idle', errors: [TEXT.projectChanged] })
    setContext(null)
    ctl.request({ roomSwitch: 1 })
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [TEXT.noProject] })
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['离线', (c: UnifiedContext) => ({ ...c, online: false }), TEXT.offline],
    ['换了项目', (c: UnifiedContext) => ({ ...c, projectId: 'another-project-0001' }), TEXT.projectChanged],
    ['项目没了', () => null, TEXT.projectChanged],
    ['app_code 变成 12', (c: UnifiedContext) => ({ ...c, appCode: 12 }), TEXT.tempDisabledByApp],
    ['温度范围收窄', (c: UnifiedContext) => ({ ...c, tempRange: { max: 23 } }), TEXT.tempOutOfRange({ min: 16, max: 23, step: 0.5 })],
  ] as const)('下发前读取期间%s：不下发，failure/not-sent', async (_n, change, msg) => {
    const gate = deferred<Snap>()
    const readBack = vi.fn(() => gate.promise)
    const { ctl, send, setContext } = setup({ readBack })
    ctl.request({ roomSwitch: 1, roomTemp: 24 })
    const p = ctl.confirm()
    setContext(change(CTX))
    gate.resolve({ roomTemp: 22, roomSwitch: 1 })
    expect(await p).toMatchObject({ status: 'failure', outcome: 'not-sent', error: msg, before: { roomTemp: 22 } })
    expect(send).not.toHaveBeenCalled()
    expect(readBack).toHaveBeenCalledTimes(1)
  })

  it('idle 下调 confirm 无效', async () => {
    const { ctl, send } = setup()
    expect(await ctl.confirm()).toEqual(INITIAL)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('控制器：重复点击', () => {
  it('sending 期间连点确认只下发一次，返回同一个 Promise', async () => {
    const gate = deferred<{ success: boolean; msg: string }>()
    const send = vi.fn(() => gate.promise)
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomTemp: 24 })
    const p1 = ctl.confirm()
    const p2 = ctl.confirm()
    const p3 = ctl.confirm()
    expect(p2).toBe(p1)
    expect(p3).toBe(p1)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(ctl.getState()).toMatchObject({ status: 'sending', step: 'send' })
    // sending 期间 request / cancel / reset 都无效
    ctl.request({ roomSwitch: 0 }); ctl.cancel(); ctl.reset()
    expect(ctl.getState()).toMatchObject({ status: 'sending' })
    gate.resolve({ success: true, msg: '' })
    await p1
    expect(ctl.getState().status).toBe('success')
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    // 结束后再点确认也不会再发
    await ctl.confirm()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('下发前读取期间重复点击也只读一次', async () => {
    const gate = deferred<Snap>()
    const readBack = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ roomTemp: 24, roomSwitch: 1 })
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomTemp: 24 })
    const p = ctl.confirm(); ctl.confirm(); ctl.confirm()
    expect(readBack).toHaveBeenCalledTimes(1)
    gate.resolve({ roomTemp: 22, roomSwitch: 1 })
    await p
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
  })
})

describe('控制器：失败不重试', () => {
  it('控制屏拒绝（success=false）→ failure/rejected；只发一次，回读一次核对', async () => {
    const send = vi.fn(async () => { throw new ApiError('ctrl', '该软件类型不支持此控制') })
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomTemp: 24 })
    const end = await ctl.confirm()
    expect(end).toMatchObject({ status: 'failure', outcome: 'rejected', error: `${TEXT.failure}：该软件类型不支持此控制`, before: { roomTemp: 22 }, after: { roomTemp: 24 } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    // 等一会儿也不会自己重发
    await new Promise((r) => setTimeout(r, 20))
    expect(send).toHaveBeenCalledTimes(1)
    // 失败后 confirm 无效，只能 reset 后重新走确认
    await ctl.confirm()
    expect(send).toHaveBeenCalledTimes(1)
    ctl.reset()
    expect(ctl.getState()).toEqual({ status: 'idle', errors: [] })
  })

  it.each([
    ['timeout', '未收到控制屏应答，下发结果未知'],
    ['network', '网络中断，下发结果未知'],
  ] as const)('%s → outcome=unknown，回读用来核对', async (kind, msg) => {
    const send = vi.fn(async () => { throw new ApiError(kind, msg) })
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'unknown', error: `${TEXT.failure}：${msg}`, after: { roomTemp: 24 } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(2)
  })

  it.each(['write_blocked', 'bad_request'] as const)('%s → outcome=not-sent，不做下发后回读', async (kind) => {
    const send = vi.fn(async () => { throw new ApiError(kind, '下发已关闭（writeMode=off）') })
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomSwitch: 1 })
    const end = await ctl.confirm()
    expect(end).toMatchObject({ status: 'failure', outcome: 'not-sent' })
    expect((end as { after?: unknown }).after).toBeUndefined()
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('下发前读取失败：不下发，failure/not-sent', async () => {
    const readBack = vi.fn(async () => { throw new ApiError('unavailable', '控制屏未连接') })
    const { ctl, send } = setup({ readBack })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'not-sent', error: `${TEXT.readBeforeFailed}：控制屏未连接` })
    expect(send).not.toHaveBeenCalled()
    expect(readBack).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['服务端 500', new ApiError('server', '内部错误', { status: 500, code: 13 }), 'unknown'],
    ['控制屏 503', new ApiError('unavailable', '控制屏消息发送失败', { status: 503, code: 14 }), 'unknown'],
    ['后端返回取消 code 1', new ApiError('aborted', '请求已取消', { status: 499, code: 1 }), 'unknown'],
    ['后端参数错误 code 3', new ApiError('bad_request', '参数错误', { status: 400, code: 3 }), 'rejected'],
    ['网关无权限', new ApiError('forbidden', '无权限', { status: 403 }), 'rejected'],
    ['令牌失效', new ApiError('unauthenticated', '登录已过期', { status: 401, code: 16 }), 'rejected'],
    ['发出后被取消（无状态 aborted）', new ApiError('aborted', '请求已取消'), 'unknown'],
    ['前端写防护（无状态）', new ApiError('write_blocked', '下发已关闭'), 'not-sent'],
  ] as const)('%s → %s；只要不是 not-sent 就回读', async (_n, err, outcome) => {
    expect(outcomeOf(err)).toBe(outcome)
    const send = vi.fn(async () => { throw err })
    const { ctl, readBack } = setup({ send })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledTimes(outcome === 'not-sent' ? 1 : 2)
  })

  it('普通异常按结果未知处理', async () => {
    const { ctl } = setup({ send: vi.fn(async () => { throw new Error('boom') }) })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'unknown' })
  })
})

describe('控制器：其他', () => {
  it('dispose 后结果不再更新状态、不再通知', async () => {
    const gate = deferred<{ success: boolean; msg: string }>()
    const { ctl } = setup({ send: vi.fn(() => gate.promise) })
    const fn = vi.fn()
    ctl.subscribe(fn)
    ctl.request({ roomSwitch: 1 })
    const p = ctl.confirm()
    const calls = fn.mock.calls.length
    ctl.dispose()
    gate.resolve({ success: true, msg: '' })
    await p
    expect(ctl.getState().status).toBe('sending')
    expect(fn.mock.calls.length).toBe(calls)
  })

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
