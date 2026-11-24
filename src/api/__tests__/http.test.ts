import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../config'
import { __resetHttpForTests, onSessionExpired, refreshSession, request } from '../http'
import { clearTokens, readTokens, writeTokens } from '../tokens'
import { fakeBackend, json, text } from './helpers'

const HOUR = 3600_000
const login = (access = 'A1', refresh = 'R1', ttl = 2 * HOUR) =>
  writeTokens({ accessToken: access, refreshToken: refresh, expiresAt: Date.now() + ttl })

/** 每次刷新都轮换：R{n} → R{n+1}；旧 refresh 再用就 401 */
function rotatingRefresh(delayMs = 5) {
  let gen = 1
  return async (c: { body: unknown; headers: Record<string, string> }) => {
    await new Promise((r) => setTimeout(r, delayMs))
    const b = c.body as { refresh_token?: string }
    if (!c.headers.Authorization?.startsWith('Bearer ')) return json({ code: 16, message: 'no token' }, 401)
    if (b.refresh_token !== `R${gen}`) return json({ code: 16, message: 'invalid refresh_token' }, 401)
    gen++
    return json({ access_token: `A${gen}`, refresh_token: `R${gen}`, expires_in: 7200 })
  }
}

beforeEach(() => { setConfig({ apiBase: '/api' }); __resetHttpForTests(); clearTokens() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('请求封装', () => {
  it('带 Bearer 令牌，POST JSON', async () => {
    login()
    const be = fakeBackend({ '/projects': () => json({ entities: [] }) })
    await expect(request('/projects', { body: { only_online: true } })).resolves.toEqual({ entities: [] })
    expect(be.calls[0]).toMatchObject({ url: '/api/projects', method: 'POST', body: { only_online: true } })
    expect(be.calls[0].headers.Authorization).toBe('Bearer A1')
  })

  it('auth:false 不带令牌；空响应体返回 {}', async () => {
    const be = fakeBackend({ '/auth/login': () => new Response('', { status: 200 }) })
    await expect(request('/auth/login', { auth: false })).resolves.toEqual({})
    expect(be.calls[0].headers.Authorization).toBeUndefined()
  })

  it('没有令牌时直接按过期处理，不发请求', async () => {
    const be = fakeBackend({})
    const expired = vi.fn()
    onSessionExpired(expired)
    await expect(request('/me', { method: 'GET' })).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(be.calls).toHaveLength(0)
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('超时归为 timeout', async () => {
    login()
    // 永不返回、只响应 abort 的 fetch
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))
    }))
    await expect(request('/slow', { timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' })
  })
})

describe('令牌续期', () => {
  it('网关 403 token err → 续期后重放一次', async () => {
    login()
    const be = fakeBackend({
      '/me': (c) => (c.headers.Authorization === 'Bearer A2' ? json({ user_entity: { id: 'u1' } }) : text('token err', 403)),
      '/auth/refresh': rotatingRefresh(),
    })
    await expect(request('/me', { method: 'GET' })).resolves.toEqual({ user_entity: { id: 'u1' } })
    const r = be.callsTo('/auth/refresh')
    expect(r).toHaveLength(1)
    // 实测：refresh 必须带当前 access 令牌，body 用 snake_case
    expect(r[0].headers.Authorization).toBe('Bearer A1')
    expect(r[0].body).toEqual({ refresh_token: 'R1' })
    expect(readTokens()).toMatchObject({ accessToken: 'A2', refreshToken: 'R2' })
  })

  it('并发 5 个请求同时 401，只刷新一次，全部用新令牌重放成功', async () => {
    login()
    const be = fakeBackend({
      '/x': (c) => (c.headers.Authorization === 'Bearer A2' ? json({ ok: 1 }) : json({ code: 16, message: 'token expired' }, 401)),
      '/auth/refresh': rotatingRefresh(20),
    })
    const rs = await Promise.all(Array.from({ length: 5 }, () => request('/x')))
    expect(rs).toEqual(Array(5).fill({ ok: 1 }))
    expect(be.counts['/auth/refresh']).toBe(1)
    expect(readTokens()?.refreshToken).toBe('R2')
  })

  it('快过期时先主动续期，并发调用共用一次刷新', async () => {
    login('A1', 'R1', 30_000) // 剩 30 秒 < 60 秒余量
    const be = fakeBackend({ '/x': () => json({}), '/auth/refresh': rotatingRefresh(10) })
    await Promise.all([request('/x'), request('/x'), refreshSession()])
    expect(be.counts['/auth/refresh']).toBe(1)
    expect(be.callsTo('/x').every((c) => c.headers.Authorization === 'Bearer A2')).toBe(true)
  })

  it('续期失败 → 清登录态、只通知一次过期', async () => {
    login()
    const expired = vi.fn()
    onSessionExpired(expired)
    fakeBackend({
      '/x': () => text('token err', 403),
      '/auth/refresh': () => json({ code: 16, message: 'invalid refresh_token' }, 401),
    })
    const rs = await Promise.allSettled([request('/x'), request('/x'), request('/x')])
    expect(rs.every((r) => r.status === 'rejected' && (r.reason as { kind: string }).kind === 'unauthenticated')).toBe(true)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(readTokens()).toBeNull()
  })

  it('重放后仍未认证 → 过期，不再无限刷新', async () => {
    login()
    const expired = vi.fn()
    onSessionExpired(expired)
    const be = fakeBackend({ '/x': () => text('token err', 403), '/auth/refresh': rotatingRefresh() })
    await expect(request('/x')).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(be.counts['/auth/refresh']).toBe(1)
    expect(be.counts['/x']).toBe(2)
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('续期时断网：不清登录态', async () => {
    login('A1', 'R1', 10_000)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expect(request('/x')).rejects.toMatchObject({ kind: 'network' })
    expect(readTokens()?.refreshToken).toBe('R1')
  })

  it('无权限（no permission）不触发续期', async () => {
    login()
    const be = fakeBackend({ '/weather': () => text('no permission', 403) })
    await expect(request('/weather')).rejects.toMatchObject({ kind: 'forbidden' })
    expect(be.counts['/auth/refresh']).toBeUndefined()
  })
})
