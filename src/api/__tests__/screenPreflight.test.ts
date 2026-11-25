// 下发前控制屏实时预检（ctrl 205）与 504 文案：只把 fetch 换成假后端，不连任何真实后端。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '../auth'
import { setConfig } from '../config'
import { ApiError, errorFromResponse } from '../errors'
import { __resetHttpForTests } from '../http'
import { NO_REPLY_504_NOTE, preflightScreen, SCREEN_CHECK_MS, withNoReplyNote } from '../screenPreflight'
import { clearTokens, writeTokens } from '../tokens'
import { fakeBackend, json, text } from './helpers'

const R205 = '/ctrl/device-summary-get'

beforeEach(() => {
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
  it('其他失败（500、无权限、断网）→ offline', async () => {
    fakeBackend({ [R205]: () => json({ code: 13, message: 'x' }, 500) })
    expect(await preflightScreen('P1')).toBe('offline')
    fakeBackend({})
    expect(await preflightScreen('P1')).toBe('offline')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await preflightScreen('P1')).toBe('offline')
  })
  it('单独 5 秒超时：4.9 秒还在等，5 秒到 → timeout，并中止 205 请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(SCREEN_CHECK_MS).toBe(5_000)
    let aborted = false
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, j) => {
      init.signal?.addEventListener('abort', () => { aborted = true; j(new DOMException('aborted', 'AbortError')) })
    })))
    let got: string | null = null
    void preflightScreen('P1').then((r) => { got = r })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(got).toBe('timeout')
    expect(aborted).toBe(true)
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
