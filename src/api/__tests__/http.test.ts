import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../config'
import { __resetHttpForTests, onSessionExpired, refreshSession, request, requestWrite, WRITE_ACCOUNT_TEXT, WRITE_AUTH_TEXT, WRITE_LOGIN_ABNORMAL_TEXT, WRITE_CANCELLED_TEXT, WRITE_OFFLINE_TEXT, WRITE_RECHECK_TEXT } from '../http'
import { clearTokens, readTokens, writeTokens } from '../tokens'
import { fakeBackend, json, sealedBody, text } from './helpers'

const HOUR = 3600_000
/** 带 sub 的 JWT 形状令牌（写请求要求能解析出 sub） */
const J = (n: number, sub = 'u1') => `h.${btoa(JSON.stringify({ sub, n }))}.s`
const login = (access = 'A1', refresh = 'R1', ttl = 2 * HOUR) =>
  writeTokens({ accessToken: access, refreshToken: refresh, expiresAt: Date.now() + ttl })

/** 每次刷新都轮换：R{n} → R{n+1}；旧 refresh 再用就 401 */
function rotatingRefresh(delayMs = 5, mk: (gen: number) => string = (g) => `A${g}`) {
  let gen = 1
  return async (c: { body: unknown; headers: Record<string, string> }) => {
    await new Promise((r) => setTimeout(r, delayMs))
    const b = c.body as { refresh_token?: string }
    if (!c.headers.Authorization?.startsWith('Bearer ')) return json({ code: 16, message: 'no token' }, 401)
    if (b.refresh_token !== `R${gen}`) return json({ code: 16, message: 'invalid refresh_token' }, 401)
    gen++
    return json({ access_token: mk(gen), refresh_token: `R${gen}`, expires_in: 7200 })
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

  it('续期时断网：同样按过期处理（续期失败一律回登录页）', async () => {
    login('A1', 'R1', 10_000)
    const expired = vi.fn()
    onSessionExpired(expired)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expect(request('/x')).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(readTokens()).toBeNull()
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('普通请求断网（令牌没到续期窗口）：不续期、不清登录态', async () => {
    login()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expect(request('/x')).rejects.toMatchObject({ kind: 'network' })
    expect(readTokens()?.refreshToken).toBe('R1')
  })

  it('刷新途中重新登录：旧刷新的结果不覆盖新会话', async () => {
    login()
    fakeBackend({ '/auth/refresh': async () => {
      writeTokens({ accessToken: 'NEW', refreshToken: 'NEWR', expiresAt: Date.now() + HOUR }) // 模拟期间重新登录
      return json({ access_token: 'A2', refresh_token: 'R2', expires_in: 7200 })
    } })
    await expect(refreshSession()).resolves.toMatchObject({ accessToken: 'NEW' })
    expect(readTokens()?.refreshToken).toBe('NEWR')
  })

  it('刷新途中重新登录：旧刷新失败不清新会话，直接用新会话的令牌', async () => {
    login()
    const expired = vi.fn()
    onSessionExpired(expired)
    fakeBackend({ '/auth/refresh': async () => {
      writeTokens({ accessToken: 'NEW', refreshToken: 'NEWR', expiresAt: Date.now() + HOUR })
      return json({ code: 16, message: 'invalid refresh_token' }, 401)
    } })
    await expect(refreshSession()).resolves.toMatchObject({ accessToken: 'NEW' })
    expect(readTokens()?.refreshToken).toBe('NEWR')
    expect(expired).not.toHaveBeenCalled()
  })

  it('refresh 返回 200 但缺令牌 → 续期失败，按过期处理', async () => {
    login()
    fakeBackend({ '/auth/refresh': () => json({}) })
    await expect(refreshSession()).rejects.toMatchObject({ kind: 'unauthenticated', cause: { kind: 'server' } })
    expect(readTokens()).toBeNull()
  })

  it('无权限（no permission）不触发续期', async () => {
    login()
    const be = fakeBackend({ '/weather': () => text('no permission', 403) })
    await expect(request('/weather')).rejects.toMatchObject({ kind: 'forbidden' })
    expect(be.counts['/auth/refresh']).toBeUndefined()
  })
})

describe('写请求：不重放、发送前同步复核（S12b）', () => {
  // 写防护：测试环境 + 白名单项目
  const P = { id: 'e1', code: '240829001' }
  beforeEach(() => { setConfig({ apiBase: '/api', apiEnv: 'test' }) })
  const route = '/ctrl/project-room-switch-set'

  it.each([
    ['401 code 16', () => json({ code: 16, message: 'token expired' }, 401)],
    ['网关 403 token err', () => text('token err', 403)],
  ])('%s：不续期重放，写接口只发一次；提示「登录状态已更新，请重新下发」，没有 status（未执行）', async (_n, h) => {
    login(J(1))
    const be = fakeBackend({ [route]: h, '/auth/refresh': rotatingRefresh(5, J) })
    const e = (await requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') }).catch((x: unknown) => x)) as { status?: number }
    expect(e).toMatchObject({ kind: 'unauthenticated', message: WRITE_AUTH_TEXT })
    expect(e.status).toBeUndefined()
    await new Promise((r) => setTimeout(r, 30))
    expect(be.callsTo(route)).toHaveLength(1)
    // 后台续期一次，让登录状态更新
    expect(be.callsTo('/auth/refresh')).toHaveLength(1)
    expect(readTokens()?.accessToken).toBe(J(2))
  })

  it('读请求原有的续期重放不受影响', async () => {
    login()
    const be = fakeBackend({ '/x': (c) => (c.headers.Authorization === 'Bearer A2' ? json({ ok: 1 }) : json({ code: 16 }, 401)), '/auth/refresh': rotatingRefresh() })
    await expect(request('/x')).resolves.toEqual({ ok: 1 })
    expect(be.callsTo('/x')).toHaveLength(2)
  })

  it('令牌快过期：先续期再发（用新令牌），只发一次', async () => {
    login(J(1), 'R1', 10_000)
    const be = fakeBackend({ [route]: () => json({ body: '' }), '/auth/refresh': rotatingRefresh(5, J) })
    await requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') })
    expect(be.callsTo(route)).toHaveLength(1)
    expect(be.callsTo(route)[0].headers.Authorization).toBe(`Bearer ${J(2)}`)
  })

  it('beforeSend 返回 false / 抛错：不发，write_blocked', async () => {
    login(J(1))
    const be = fakeBackend({ [route]: () => json({ body: '' }) })
    for (const beforeSend of [() => false, () => { throw new Error('x') }]) {
      await expect(requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') }, { beforeSend })).rejects.toMatchObject({ kind: 'write_blocked', message: WRITE_RECHECK_TEXT })
    }
    expect(be.callsTo(route)).toHaveLength(0)
  })

  it('beforeSend 在令牌续期完成之后才执行：续期期间页面卸载 / 项目离线 → 不发', async () => {
    for (const what of ['卸载', '离线']) {
      __resetHttpForTests(); clearTokens()
      login(J(1), 'R1', 10_000) // 快过期，要先续期
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const refresh = rotatingRefresh(0, J)
      const be = fakeBackend({ [route]: () => json({ body: '' }), '/auth/refresh': async (c) => { await gate; return refresh(c) } })
      const page = { alive: true, online: true }
      const order: string[] = []
      const p = requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') }, { beforeSend: () => { order.push('check'); return page.alive && page.online } })
      await vi.waitFor(() => expect(be.callsTo('/auth/refresh')).toHaveLength(1))
      expect(order).toEqual([]) // 续期还没完，复核还没跑
      if (what === '卸载') page.alive = false
      else page.online = false
      release()
      await expect(p, what).rejects.toMatchObject({ kind: 'write_blocked' })
      expect(order).toEqual(['check'])
      expect(be.callsTo(route), what).toHaveLength(0)
    }
  })

  it('等待令牌续期期间被取消（signal 中止）：最先检查信号，写请求的 fetch 0 次，beforeSend 不再调用', async () => {
    login(J(1), 'R1', 10_000)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const refresh = rotatingRefresh(0, J)
    const be = fakeBackend({ [route]: () => json({ body: '' }), '/auth/refresh': async (c) => { await gate; return refresh(c) } })
    const ac = new AbortController()
    const beforeSend = vi.fn(() => true)
    const p = requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') }, { signal: ac.signal, beforeSend })
    await vi.waitFor(() => expect(be.callsTo('/auth/refresh')).toHaveLength(1))
    ac.abort()
    release()
    await expect(p).rejects.toMatchObject({ kind: 'write_blocked', message: WRITE_CANCELLED_TEXT })
    expect(beforeSend).not.toHaveBeenCalled()
    expect(be.callsTo(route)).toHaveLength(0)
  })

  it('503 code 14（控制屏未连接）：提示「控制屏未连接，未下发」，带 code 14，只发一次', async () => {
    login(J(1))
    const be = fakeBackend({ [route]: () => json({ code: 14, message: 'no stream' }, 503) })
    await expect(requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') })).rejects.toMatchObject({ kind: 'unavailable', code: 14, message: WRITE_OFFLINE_TEXT })
    expect(be.callsTo(route)).toHaveLength(1)
  })

  it('账号绑定：续期期间别的标签页换了账号（refreshSession 直接返回新账号令牌）→ 不发，写请求 fetch 0 次', async () => {
    const tok = (sub: string, n: number) => `h.${btoa(JSON.stringify({ sub, n })).replace(/=+$/, '')}.s`
    writeTokens({ accessToken: tok('u1', 1), refreshToken: 'R1', expiresAt: Date.now() + 10_000 })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const be = fakeBackend({ [route]: () => json({ body: '' }), '/auth/refresh': async () => { await gate; return json({ code: 16 }, 401) } })
    const beforeSend = vi.fn(() => true)
    const p = requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') }, { beforeSend })
    await vi.waitFor(() => expect(be.callsTo('/auth/refresh')).toHaveLength(1))
    // 另一个标签页登录了别的账号
    writeTokens({ accessToken: tok('u2', 1), refreshToken: 'R9', expiresAt: Date.now() + 2 * HOUR })
    release()
    await expect(p).rejects.toMatchObject({ kind: 'write_blocked', message: WRITE_ACCOUNT_TEXT })
    expect(beforeSend).not.toHaveBeenCalled()
    expect(be.callsTo(route)).toHaveLength(0)
  })

  it('令牌解析不出 sub（发起时或续期后）：一律不发，提示「登录状态异常，请重新登录后下发」，按未执行（本地拦截、无 status）', async () => {
    for (const [what, start, next] of [['发起时', 'A1', J(2)], ['续期后', J(1), 'A2']] as const) {
      __resetHttpForTests(); clearTokens()
      writeTokens({ accessToken: start, refreshToken: 'R1', expiresAt: Date.now() + 10_000 })
      const be = fakeBackend({ [route]: () => json({ body: '' }), '/auth/refresh': () => json({ access_token: next, refresh_token: 'R2', expires_in: 7200 }) })
      const beforeSend = vi.fn(() => true)
      const e = (await requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') }, { beforeSend }).catch((x: unknown) => x)) as { kind?: string; message?: string; status?: number }
      expect(e, what).toMatchObject({ kind: 'write_blocked', message: WRITE_LOGIN_ABNORMAL_TEXT })
      expect(e.status).toBeUndefined()
      expect(beforeSend).not.toHaveBeenCalled()
      expect(be.callsTo(route), what).toHaveLength(0)
    }
  })

  it('Codex 场景：发起时令牌没有 sub，续期期间别的标签页换号、refreshSession 返回新账号令牌 → 不发', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 10_000 })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const be = fakeBackend({ [route]: () => json({ body: '' }), '/auth/refresh': async () => { await gate; return json({ code: 16 }, 401) } })
    const p = requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') })
    await vi.waitFor(() => expect(be.callsTo('/auth/refresh')).toHaveLength(1))
    writeTokens({ accessToken: J(1, 'u2'), refreshToken: 'R9', expiresAt: Date.now() + 2 * HOUR })
    release()
    await expect(p).rejects.toMatchObject({ kind: 'write_blocked', message: WRITE_LOGIN_ABNORMAL_TEXT })
    expect(be.callsTo(route)).toHaveLength(0)
  })

  it.each([
    ['空串', ''], ['只有空白', '  '], ['数字', 123], ['null', null],
  ])('sub 为%s：按没有 sub 处理，201/204/206 都拦下，fetch 0 次', async (_n, sub) => {
    const tok = `h.${btoa(JSON.stringify({ sub }))}.s`
    writeTokens({ accessToken: tok, refreshToken: 'R1', expiresAt: Date.now() + 2 * HOUR })
    const routes = ['/ctrl/room-temperature-set', '/ctrl/running-ctrl-set', route]
    const be = fakeBackend(Object.fromEntries(routes.map((r) => [r, () => json({ body: '' })])))
    for (const op of ['ctrl-201', 'ctrl-204', 'ctrl-206'] as const) {
      await expect(requestWrite(op, [P], { body: sealedBody(op) }), op).rejects.toMatchObject({ kind: 'write_blocked', message: WRITE_LOGIN_ABNORMAL_TEXT })
    }
    for (const r of routes) expect(be.callsTo(r), r).toHaveLength(0)
  })

  it('等待续期期间存储里的令牌被换成没有 sub 的：不发，提示「登录状态异常，请重新登录后下发」', async () => {
    writeTokens({ accessToken: J(1), refreshToken: 'R1', expiresAt: Date.now() + 10_000 })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const be = fakeBackend({ [route]: () => json({ body: '' }), '/auth/refresh': async () => { await gate; return json({ access_token: J(2), refresh_token: 'R2', expires_in: 7200 }) } })
    const p = requestWrite('ctrl-206', [P], { body: sealedBody('ctrl-206') })
    await vi.waitFor(() => expect(be.callsTo('/auth/refresh')).toHaveLength(1))
    // 续期期间存储被换成没有 sub 的令牌（refreshSession 发现存储已变，直接返回它）
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: '' }))}.s`, refreshToken: 'R3', expiresAt: Date.now() + 2 * HOUR })
    release()
    const e = (await p.catch((x: unknown) => x)) as { kind?: string; message?: string; status?: number }
    expect(e).toMatchObject({ kind: 'write_blocked', message: WRITE_LOGIN_ABNORMAL_TEXT })
    expect(e.status).toBeUndefined()
    expect(be.callsTo(route)).toHaveLength(0)
  })
})
