// 下发前控制屏实时预检（ctrl 205）与 504 文案：只把 fetch 换成假后端，不连任何真实后端。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '../auth'
import { setConfig } from '../config'
import { ApiError, errorFromResponse } from '../errors'
import { __resetHttpForTests } from '../http'
import { checkScreenOnce, NO_REPLY_504_NOTE, preflightScreen, SCREEN_CHECK_MS, SCREEN_ERROR_TEXT, SCREEN_FORBIDDEN_TEXT, SCREEN_OFFLINE_ROW, SCREEN_TIMEOUT_ROW, SCREEN_TIMEOUT_TEXT, screenBlockRow, screenBlockText, withNoReplyNote } from '../screenPreflight'
import { clearTokens, writeTokens } from '../tokens'
import { fakeBackend, json, text } from './helpers'

// 账号的 permission_paths 里有没有 205（本地 can(CONN_ROUTE)）
let canConn = true
let sessionStatus = 'authed'
vi.mock('@/data/session', () => ({ can: () => canConn }))
vi.mock('../session', async (orig) => ({ ...(await orig<typeof import('../session')>()), getSession: () => ({ status: sessionStatus }) }))

const R205 = '/ctrl/device-summary-get'

beforeEach(() => {
  canConn = true
  sessionStatus = 'authed'
  __resetHttpForTests(); clearTokens()
  writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
  setCurrentUserId('u1')
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setConfig(null) })

describe('preflightScreen（ctrl 205）', () => {
  it('205 正常 → online；每次都现查（两次调用两次请求，不缓存），请求体带项目 id', async () => {
    const be = fakeBackend({ [R205]: () => json({ body: '' }) })
    expect(await preflightScreen('P1')).toBe('online')
    expect(await preflightScreen('P1')).toBe('online')
    expect(be.callsTo(R205)).toHaveLength(2)
    expect((be.callsTo(R205)[0].body as { project_id: string }).project_id).toBe('P1')
  })
  it('205 返回 503（code 14 或网关纯文本）→ offline', async () => {
    fakeBackend({ [R205]: () => json({ code: 14, message: 'no stream' }, 503) })
    expect(await preflightScreen('P1')).toBe('offline')
    fakeBackend({ [R205]: () => text('service unavailable', 503) })
    expect(await preflightScreen('P1')).toBe('offline')
  })
  it('205 返回 403（网关 no permission / JSON code 7）→ forbidden（单独文案）；token err 不算', async () => {
    fakeBackend({ [R205]: () => text('no permission', 403) })
    expect(await preflightScreen('P1')).toBe('forbidden')
    fakeBackend({ [R205]: () => json({ code: 7, message: 'permission denied' }, 403) })
    expect(await preflightScreen('P1')).toBe('forbidden')
    expect(screenBlockText('forbidden')).toBe(SCREEN_FORBIDDEN_TEXT)
    expect(screenBlockText('offline')).toBe('控制屏未连接，暂不能下发')
  })
  it('本地 permission_paths 没有 205 → forbidden，不发请求', async () => {
    canConn = false
    const be = fakeBackend({ [R205]: () => json({ body: '' }) })
    expect(await preflightScreen('P1')).toBe('forbidden')
    expect(be.calls).toHaveLength(0)
  })
  it('会话还没就绪（loading、anon，权限列表不可信）：不按本地权限判 forbidden，照常请求 205', async () => {
    canConn = false
    for (const st of ['loading', 'anon']) {
      sessionStatus = st
      const be = fakeBackend({ [R205]: () => json({ body: '' }) })
      expect(await preflightScreen('P1')).toBe('online')
      expect(be.callsTo(R205)).toHaveLength(1)
    }
  })
  it('其他失败（500、断网）→ error（不说控制屏未连接），不重查', async () => {
    const be = fakeBackend({ [R205]: () => json({ code: 13, message: 'x' }, 500) })
    expect(await preflightScreen('P1')).toBe('error')
    expect(be.callsTo(R205)).toHaveLength(1)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await preflightScreen('P1')).toBe('error')
  })
  it('503、403 直接拦，不重查（各只发 1 次 205）', async () => {
    let be = fakeBackend({ [R205]: () => json({ code: 14, message: 'no stream' }, 503) })
    expect(await preflightScreen('P1')).toBe('offline')
    expect(be.callsTo(R205)).toHaveLength(1)
    be = fakeBackend({ [R205]: () => text('no permission', 403) })
    expect(await preflightScreen('P1')).toBe('forbidden')
    expect(be.callsTo(R205)).toHaveLength(1)
  })
  it('文案分开（S13 P2）：503「控制屏未连接」、两次超时「控制屏在线检查超时，未下发，请重试」、其他失败「在线检查失败」', () => {
    expect(SCREEN_TIMEOUT_TEXT).toBe('控制屏在线检查超时，未下发，请重试')
    expect(screenBlockText('timeout')).toBe(SCREEN_TIMEOUT_TEXT)
    expect(screenBlockText('timeout')).not.toContain('未连接')
    expect(screenBlockText('error')).toBe(SCREEN_ERROR_TEXT)
    expect(screenBlockText('error')).not.toContain('未连接')
    expect(screenBlockRow('offline')).toBe(SCREEN_OFFLINE_ROW)
    expect(screenBlockRow('timeout')).toBe(SCREEN_TIMEOUT_ROW)
    expect(screenBlockRow('timeout')).not.toContain('未连接')
  })
  it('checkScreenOnce：单独 5 秒超时，4.9 秒还在等，5 秒到 → timeout，并中止 205 请求；不重查', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(SCREEN_CHECK_MS).toBe(5_000)
    let aborted = false
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, j) => {
      init.signal?.addEventListener('abort', () => { aborted = true; j(new DOMException('aborted', 'AbortError')) })
    }))
    vi.stubGlobal('fetch', f)
    let got: string | null = null
    void checkScreenOnce('P1').then((r) => { got = r })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(got).toBe('timeout')
    expect(aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('preflightScreen：第一次 5 秒超时（中止）→ 再查一次；第二次也 5 秒超时 → timeout。共 2 次 205、最坏 10 秒', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const signals: AbortSignal[] = []
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, j) => {
      signals.push(init.signal!)
      init.signal?.addEventListener('abort', () => j(new DOMException('aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', f)
    let got: string | null = null
    void preflightScreen('P1').then((r) => { got = r })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f).toHaveBeenCalledTimes(2)
    expect(signals[0].aborted).toBe(true) // 第一次真正中止
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(4_900)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(got).toBe('timeout')
    expect(signals[1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f).toHaveBeenCalledTimes(2) // 只重查一次
  })
  it('第一次超时、第二次在线 → online（放行）；预检只发 205，不发任何写请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let n = 0
    const be = fakeBackend({ [R205]: () => (++n === 1 ? new Promise<Response>(() => {}) : json({ body: '' })) })
    let got: string | null = null
    void preflightScreen('P1').then((r) => { got = r })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(10)
    expect(got).toBe('online')
    expect(be.callsTo(R205)).toHaveLength(2)
    expect(be.calls.every((c) => c.url.endsWith(R205))).toBe(true)
  })
  it('第一次超时后迟到的应答直接丢弃：第一次 7 秒才回「在线」、第二次一直不回 → 仍是 timeout（只得出一个结论）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let n = 0
    // 假后端不理会中止：第一次 7 秒时照样返回成功
    vi.stubGlobal('fetch', vi.fn(() => (++n === 1 ? new Promise<Response>((r) => { setTimeout(() => r(json({ body: '' })), 7_000) }) : new Promise<Response>(() => {}))))
    const seen: string[] = []
    void preflightScreen('P1').then((x) => { seen.push(x) })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(seen).toEqual(['timeout'])
  })
  it('第一次超时、第二次 503 → offline（按第二次的结论）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let n = 0
    fakeBackend({ [R205]: () => (++n === 1 ? new Promise<Response>(() => {}) : json({ code: 14, message: 'no stream' }, 503)) })
    let got: string | null = null
    void preflightScreen('P1').then((r) => { got = r })
    await vi.advanceTimersByTimeAsync(5_010)
    expect(got).toBe('offline')
  })
  it('第一次超时期间调用方取消 → 不重查', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, j) => {
      init.signal?.addEventListener('abort', () => j(new DOMException('aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', f)
    const ac = new AbortController()
    let got: string | null = null
    void preflightScreen('P1', ac.signal).then((r) => { got = r })
    await vi.advanceTimersByTimeAsync(1_000)
    ac.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(got).toBe('offline')
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('调用方已取消 → offline，不发请求', async () => {
    const be = fakeBackend({ [R205]: () => json({ body: '' }) })
    const ac = new AbortController()
    ac.abort()
    expect(await preflightScreen('P1', ac.signal)).toBe('offline')
    expect(be.callsTo(R205)).toHaveLength(0)
  })
  it('演示数据模式不发请求，按 online', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'mock' })
    const be = fakeBackend({})
    expect(await preflightScreen('P1')).toBe('online')
    expect(be.calls).toHaveLength(0)
  })
})

describe('withNoReplyNote（纯文本 504 补一句）', () => {
  it('网关纯文本 504：说明后补「控制屏 10 秒内没有应答，可能离线」，kind / status 不变；只补一次', () => {
    const e = errorFromResponse(504, 'text/plain', 'upstream request timeout')
    const n = withNoReplyNote(e) as ApiError
    expect(n.message).toBe(`请求超时；${NO_REPLY_504_NOTE}`)
    expect([n.kind, n.status, n.code]).toEqual(['timeout', 504, undefined])
    expect((withNoReplyNote(n) as ApiError).message).toBe(n.message)
  })
  it('带 gRPC 码的 JSON 504（code 4）、其他错误、非 ApiError 原样返回', () => {
    const j = errorFromResponse(504, 'application/json', JSON.stringify({ code: 4, message: 'deadline' }))
    expect(withNoReplyNote(j)).toBe(j)
    const s = errorFromResponse(500, 'text/plain', 'oops')
    expect(withNoReplyNote(s)).toBe(s)
    const x = new Error('x')
    expect(withNoReplyNote(x)).toBe(x)
  })
})
