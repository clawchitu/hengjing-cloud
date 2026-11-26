import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { can as matchPath, getCurrentUserId } from '../auth'
import { setConfig } from '../config'
import { __resetHttpForTests, adoptRotation, onSessionExpired, refreshSession, request } from '../http'
import { __resetSessionForTests, can, getSession, initSession, restoreSession, signIn, signOut } from '../session'
import { clearTokens, readTokens, writeTokens } from '../tokens'
import { fakeBackend, json, text } from './helpers'

const HOUR = 3600_000
const tokens = (n: number, ttl = 2 * HOUR) => ({ access_token: `A${n}`, refresh_token: `R${n}`, expires_in: ttl / 1000 })
/** 带 sub 的假 JWT（只有 payload 有意义） */
const jwt = (sub: string, n = 1) => `h.${btoa(JSON.stringify({ sub, n })).replace(/=+$/, '')}.s`
const PATHS = ['/v1/me', '/v1/projects', '/v1/project/{id}', '/v1/ctrl/room-temperature-get']

let unwire: () => void = () => {}
beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  __resetHttpForTests(); __resetSessionForTests(); clearTokens()
  unwire = initSession()
})
afterEach(() => { unwire(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('登录', () => {
  it('一律传 isdp=true；平台账号（/me 没有 type）→ 非经销商', async () => {
    const be = fakeBackend({
      '/auth/login': () => json(tokens(1)),
      '/me': () => json({ user_entity: { id: 'u1', name: '平台' }, permission_paths: PATHS }),
    })
    const info = await signIn('admin', 'pw', true)
    expect(be.callsTo('/auth/login')[0].body).toEqual({ mobile: 'admin', password: 'pw', isdp: true })
    expect(be.callsTo('/auth/login')[0].headers.Authorization).toBeUndefined()
    expect(be.callsTo('/me')[0].headers.Authorization).toBe('Bearer A1')
    expect(info).toMatchObject({ dealer: false, user: { id: 'u1' } })
    expect(getSession().status).toBe('authed')
  })

  it('type=1 → 经销商；type=0 → 平台', async () => {
    let type = 1
    fakeBackend({ '/auth/login': () => json(tokens(1)), '/me': () => json({ user_entity: { id: 'u2', type } }) })
    expect((await signIn('d', 'pw', false)).dealer).toBe(true)
    type = 0
    expect((await signIn('d', 'pw', false)).dealer).toBe(false)
  })

  it('经销商未配置集成功能（500 code 13）→ 原样提示，不登录', async () => {
    fakeBackend({ '/auth/login': () => json({ code: 13, message: '经销商未配置集成功能' }, 500) })
    await expect(signIn('d', 'pw', false)).rejects.toMatchObject({ kind: 'server', message: '经销商未配置集成功能' })
    expect(getSession().status).toBe('anon')
    expect(readTokens()).toBeNull()
  })

  it('密码错误（401 code 16）提示后端文案，不触发续期', async () => {
    const be = fakeBackend({ '/auth/login': () => json({ code: 16, message: '密码错误，请重试' }, 401) })
    await expect(signIn('d', 'bad', false)).rejects.toMatchObject({ message: '密码错误，请重试' })
    expect(be.counts['/auth/refresh']).toBeUndefined()
  })

  it('/me 失败视为登录失败：清令牌、保持未登录', async () => {
    fakeBackend({ '/auth/login': () => json(tokens(1)), '/me': () => json({ code: 13, message: 'x' }, 500) })
    await expect(signIn('d', 'pw', true)).rejects.toMatchObject({ kind: 'server' })
    expect(readTokens()).toBeNull()
    expect(getSession().status).toBe('anon')
  })

  it('错误信息里不出现令牌原文', async () => {
    fakeBackend({ '/auth/login': () => json(tokens(1)), '/me': () => json({ code: 13, message: '查询失败 Bearer A1-secret-token' }, 500) })
    const e = await signIn('d', 'pw', true).catch((x: Error) => x)
    expect(String((e as Error).message)).not.toContain('A1-secret-token')
  })
})

describe('恢复与过期', () => {
  it('刷新页面：有令牌就取 /me 恢复', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    fakeBackend({ '/me': () => json({ user_entity: { id: 'u1', type: 1 }, permission_paths: PATHS }) })
    const p = restoreSession()
    expect(getSession().status).toBe('loading')
    await p
    expect(getSession()).toMatchObject({ status: 'authed', info: { dealer: true } })
  })

  it('没有令牌：直接未登录，不发请求', async () => {
    const be = fakeBackend({})
    await restoreSession()
    expect(getSession().status).toBe('anon')
    expect(be.calls).toHaveLength(0)
  })

  it('403 token err 当作令牌失效：续期也被拒 → 回到未登录（reason=unauthenticated）', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    fakeBackend({
      '/me': (_c, n) => (n === 1 ? json({ user_entity: { id: 'u1' } }) : text('token err', 403)),
      '/auth/refresh': () => json({ code: 16, message: 'invalid refresh_token' }, 401),
      '/projects': () => text('token err', 403),
    })
    await restoreSession()
    expect(getSession().status).toBe('authed')
    await expect(request('/projects')).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(getSession()).toMatchObject({ status: 'anon', reason: { kind: 'unauthenticated' } })
    expect(readTokens()).toBeNull()
  })

  it('403 token err → 续期成功后重放，会话保持', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    fakeBackend({
      '/me': () => json({ user_entity: { id: 'u1' } }),
      '/auth/refresh': () => json(tokens(2)),
      '/projects': (c) => (c.headers.Authorization === 'Bearer A2' ? json({ entities: [] }) : text('token err', 403)),
    })
    await restoreSession()
    await expect(request('/projects')).resolves.toEqual({ entities: [] })
    expect(getSession().status).toBe('authed')
    expect(readTokens()?.refreshToken).toBe('R2')
  })

  it('断网时恢复失败：按未登录处理，但不清令牌', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await restoreSession()
    expect(getSession()).toMatchObject({ status: 'anon', reason: { kind: 'network' } })
    expect(readTokens()?.refreshToken).toBe('R1')
  })

  it('过期前 60 秒主动续期（定时器）', async () => {
    vi.useFakeTimers()
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }), '/auth/refresh': () => json(tokens(2)) })
    await restoreSession()
    await vi.advanceTimersByTimeAsync(HOUR - 120_000)
    expect(be.counts['/auth/refresh']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(70_000)
    expect(be.counts['/auth/refresh']).toBe(1)
    expect(readTokens()?.accessToken).toBe('A2')
  })

  it('主动退出：调 /auth/invalidate 带 user_id，清令牌', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u9' } }), '/auth/invalidate': () => json({}) })
    await restoreSession()
    await signOut()
    expect(be.callsTo('/auth/invalidate')[0].body).toEqual({ user_id: 'u9' })
    expect(getSession().status).toBe('anon')
    expect(readTokens()).toBeNull()
  })
})

describe('刷新竞争（多标签页，Web Locks）', () => {
  /** 串行执行的假 LockManager；onAcquire 在拿到锁、执行回调之前调用，用来模拟别的标签页先刷新了 */
  function fakeLocks(onAcquire?: () => void) {
    let chain: Promise<unknown> = Promise.resolve()
    const request = vi.fn((_name: string, fn: () => Promise<unknown>) => {
      const run = chain.then(() => { onAcquire?.(); return fn() })
      chain = run.catch(() => {})
      return run
    })
    vi.stubGlobal('navigator', { locks: { request } })
    return request
  }

  it('等锁期间别的标签页已轮换令牌 → 直接用新令牌，不再发刷新', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 30_000 })
    const req = fakeLocks(() => writeTokens({ accessToken: 'A2', refreshToken: 'R2', expiresAt: Date.now() + HOUR }))
    const be = fakeBackend({ '/auth/refresh': () => json({ code: 16, message: 'invalid refresh_token' }, 401), '/x': () => json({}) })
    await expect(request('/x')).resolves.toEqual({})
    expect(req).toHaveBeenCalledWith('hjc-token-refresh', expect.any(Function))
    expect(be.counts['/auth/refresh']).toBeUndefined()
    expect(be.callsTo('/x')[0].headers.Authorization).toBe('Bearer A2')
  })

  it('页内并发 + 锁：只发一次刷新', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 30_000 })
    const req = fakeLocks()
    const be = fakeBackend({ '/auth/refresh': async () => { await new Promise((r) => setTimeout(r, 10)); return json(tokens(2)) }, '/x': () => json({}) })
    await Promise.all([request('/x'), request('/x'), refreshSession(), refreshSession()])
    expect(req).toHaveBeenCalledTimes(1)
    expect(be.counts['/auth/refresh']).toBe(1)
  })

  it('别的标签页退出（logout 广播）→ 本页清令牌、转为未登录', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    const other = new BroadcastChannel('hjc-session')
    other.postMessage({ type: 'logout' })
    await vi.waitFor(() => expect(getSession().status).toBe('anon'))
    expect(readTokens()).toBeNull()
    other.close()
  })
})

describe('can()', () => {
  it('按 /v1 路由模板匹配，{id} 匹配任意一段', () => {
    expect(matchPath(PATHS, '/projects')).toBe(true)
    expect(matchPath(PATHS, '/v1/projects')).toBe(true)
    expect(matchPath(PATHS, 'project/66cfd7959fb60d63c917fd0a')).toBe(true)
    expect(matchPath(PATHS, '/project')).toBe(false)
    expect(matchPath(PATHS, '/project/a/b')).toBe(false)
    expect(matchPath(PATHS, '/weather')).toBe(false)
  })

  it('会话里的 can()：未登录一律 false，登录后按 permission_paths', async () => {
    expect(can('/projects')).toBe(false)
    fakeBackend({ '/auth/login': () => json(tokens(1)), '/me': () => json({ user_entity: { id: 'u1', type: 1 }, permission_paths: PATHS }) })
    await signIn('d', 'pw', false)
    expect(can('/projects')).toBe(true)
    expect(can('/ctrl/room-temperature-get')).toBe(true)
    expect(can('/weather')).toBe(false)
    await signOut().catch(() => {})
    expect(can('/projects')).toBe(false)
  })

  it('/me 没有 permission_paths → 全部 false', async () => {
    fakeBackend({ '/auth/login': () => json(tokens(1)), '/me': () => json({ user_entity: { id: 'u1' } }) })
    await signIn('d', 'pw', false)
    expect(can('/projects')).toBe(false)
  })
})

describe('交错与跨标签页（第一轮评审补充）', () => {
  /** 另一个标签页：经同名 BroadcastChannel 发消息 */
  const others: BroadcastChannel[] = []
  afterEach(() => { others.splice(0).forEach((c) => c.close()) })
  function otherTab() {
    const c = new BroadcastChannel('hjc-session')
    others.push(c)
    return (m: unknown) => c.postMessage(m)
  }

  it('别的标签页换了账号登录（sub 变了）→ 重新取 /me，身份跟着换', async () => {
    const post = otherTab()
    writeTokens({ accessToken: jwt('u1'), refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const be = fakeBackend({ '/me': (c) => json({ user_entity: c.headers.Authorization === `Bearer ${jwt('u2')}` ? { id: 'u2', type: 1 } : { id: 'u1' } }) })
    await restoreSession()
    expect(getSession().info?.dealer).toBe(false)
    post({ type: 'login', to: { accessToken: jwt('u2'), refreshToken: 'X1', expiresAt: Date.now() + HOUR } })
    await vi.waitFor(() => expect(getSession().info?.user.id).toBe('u2'))
    expect(getSession().info?.dealer).toBe(true)
    expect(be.counts['/me']).toBe(2)
  })

  it('别的标签页只是续期（sub 不变）→ 不重新取 /me', async () => {
    const post = otherTab()
    writeTokens({ accessToken: jwt('u1'), refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    post({ type: 'rotated', from: 'R1', to: { accessToken: jwt('u1', 2), refreshToken: 'R2', expiresAt: Date.now() + 2 * HOUR } })
    await vi.waitFor(() => expect(readTokens()?.refreshToken).toBe('R2'))
    await new Promise((r) => setTimeout(r, 10))
    expect(be.counts['/me']).toBe(1)
    expect(getSession().status).toBe('authed')
  })

  it('退出途中重新登录：旧的退出完成后不清新会话', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    let release!: () => void
    fakeBackend({
      '/me': () => json({ user_entity: { id: 'u1' } }),
      '/auth/invalidate': () => new Promise<Response>((r) => { release = () => r(json({})) }),
      '/auth/login': () => json(tokens(5)),
    })
    await restoreSession()
    const out = signOut()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await signIn('d', 'pw', true)
    release()
    await out
    expect(readTokens()?.refreshToken).toBe('R5')
    expect(getSession().status).toBe('authed')
  })

  it('登录途中点了退出：登录结果作废，写进去的令牌收回', async () => {
    let release!: () => void
    fakeBackend({ '/auth/login': () => new Promise<Response>((r) => { release = () => r(json(tokens(1))) }), '/me': () => json({ user_entity: { id: 'u1' } }) })
    const p = signIn('d', 'pw', true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await signOut()
    release()
    await expect(p).rejects.toMatchObject({ kind: 'aborted' })
    expect(readTokens()).toBeNull()
    expect(getSession().status).toBe('anon')
  })

  it('复制出来的标签页（sessionStorage 不共享）：收到广播就换上新令牌', () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const to = { accessToken: 'A2', refreshToken: 'R2', expiresAt: Date.now() + 2 * HOUR }
    adoptRotation({ type: 'rotated', from: 'R0', to })
    expect(readTokens()?.refreshToken).toBe('R1') // 不是自己的旧值，不动
    adoptRotation({ type: 'rotated', from: 'R1', to })
    expect(readTokens()).toEqual(to)
  })

  it('刷新被拒、但等待期间收到别的标签页的广播 → 用新令牌，不踢下线', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 30_000 })
    const expired = vi.fn()
    onSessionExpired(expired)
    const to = { accessToken: 'A2', refreshToken: 'R2', expiresAt: Date.now() + 2 * HOUR }
    fakeBackend({ '/auth/refresh': () => {
      setTimeout(() => adoptRotation({ type: 'rotated', from: 'R1', to }), 50) // 广播晚于本页的刷新请求到达
      return json({ code: 16, message: 'invalid refresh_token' }, 401)
    } })
    await expect(refreshSession()).resolves.toMatchObject({ accessToken: 'A2' })
    expect(expired).not.toHaveBeenCalled()
  })

  it('续期断网 → 按过期回登录页（不保留、不空转重试）', async () => {
    vi.useFakeTimers()
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 62_000 }) // 定时器约 7 秒后触发
    let n = 0
    vi.stubGlobal('fetch', async (u: string) => {
      if (u.endsWith('/me')) return json({ user_entity: { id: 'u1' } })
      n++
      throw new TypeError('fetch failed')
    })
    await restoreSession()
    await vi.advanceTimersByTimeAsync(8000)
    expect(n).toBe(1)
    expect(getSession()).toMatchObject({ status: 'anon', reason: { kind: 'unauthenticated' } })
    expect(readTokens()).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(n).toBe(1)
  })

  it('网络恢复（online）时剩余时长已进入续期窗口 → 立即续期', async () => {
    const win = new EventTarget()
    unwire()
    vi.stubGlobal('window', win)
    unwire = initSession()
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }), '/auth/refresh': () => json(tokens(2)) })
    await restoreSession()
    win.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 10))
    expect(be.counts['/auth/refresh']).toBeUndefined() // 还剩 1 小时，不续
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 30_000 })
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(readTokens()?.accessToken).toBe('A2'))
  })

  it('initSession 的清理函数会清掉续期定时器', async () => {
    vi.useFakeTimers()
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 2 * 60_000 })
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }), '/auth/refresh': () => json(tokens(2)) })
    await restoreSession()
    unwire()
    unwire = () => {}
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(be.counts['/auth/refresh']).toBeUndefined()
  })

  it('已登录但令牌被别处清掉：下次排定时器时兜底转为未登录', async () => {
    vi.useFakeTimers()
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 2 * 60_000 })
    fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    clearTokens()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(getSession().status).toBe('anon')
  })

  it('没有令牌时 restoreSession 也可以无条件调用：loading 中途令牌没了 → anon', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    let release!: () => void
    fakeBackend({ '/me': () => new Promise<Response>((r) => { release = () => r(json({ user_entity: { id: 'u1' } })) }) })
    const p = restoreSession()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    clearTokens()
    await restoreSession()
    expect(getSession().status).toBe('anon')
    release()
    await p
    expect(getSession().status).toBe('anon') // 过时的恢复结果被丢弃
  })

  it('退出：先清本地，再用取出的令牌调 invalidate', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    let seenLocal: unknown = 'unset'
    const be = fakeBackend({
      '/me': () => json({ user_entity: { id: 'u1' } }),
      '/auth/invalidate': () => { seenLocal = readTokens(); return json({}) },
    })
    await restoreSession()
    await signOut()
    expect(seenLocal).toBeNull()
    expect(be.callsTo('/auth/invalidate')[0].headers.Authorization).toBe('Bearer A1')
  })

  it('过期通知按会话去重：重新登录后 3 秒内再次过期，照样转为未登录', async () => {
    fakeBackend({
      '/auth/login': (_c, n) => json(tokens(n)),
      '/me': () => json({ user_entity: { id: 'u1' } }),
      '/x': () => text('token err', 403),
      '/auth/refresh': () => json({ code: 16, message: 'invalid refresh_token' }, 401),
    })
    await signIn('d', 'pw', true)
    await expect(request('/x')).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(getSession().status).toBe('anon')
    await signIn('d', 'pw', true)
    expect(getSession().status).toBe('authed')
    await expect(request('/x')).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(getSession().status).toBe('anon')
    expect(readTokens()).toBeNull()
  })
})

describe('交错与跨标签页（第二轮评审补充）', () => {
  it('旧登录晚于新登录完成：不覆盖新会话的令牌和身份', async () => {
    const release: Array<() => void> = []
    fakeBackend({
      '/auth/login': (c) => new Promise<Response>((r) => {
        const n = (c.body as { mobile: string }).mobile === 'old' ? 1 : 2
        release.push(() => r(json({ access_token: jwt(`u${n}`), refresh_token: `R${n}`, expires_in: 7200 })))
      }),
      '/me': (c) => json({ user_entity: { id: c.headers.Authorization === `Bearer ${jwt('u1')}` ? 'u1' : 'u2' } }),
    })
    const old = signIn('old', 'pw', true)
    await vi.waitFor(() => expect(release).toHaveLength(1))
    const fresh = signIn('new', 'pw', true)
    await vi.waitFor(() => expect(release).toHaveLength(2))
    release[1]()
    await fresh
    release[0]()
    await expect(old).rejects.toMatchObject({ kind: 'aborted' })
    expect(readTokens()?.refreshToken).toBe('R2')
    expect(getSession()).toMatchObject({ status: 'authed', info: { user: { id: 'u2' } } })
    expect(getCurrentUserId()).toBe('u2')
  })

  it('旧账号发起的请求在换账号后才 401：不用新账号的令牌重放，也不登出新会话', async () => {
    writeTokens({ accessToken: jwt('u1'), refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    let release!: () => void
    const be = fakeBackend({
      '/x': (c) => (c.headers.Authorization === `Bearer ${jwt('u1')}`
        ? new Promise<Response>((r) => { release = () => r(text('token err', 403)) })
        : json({ ok: 1 })),
    })
    const p = request('/x')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    writeTokens({ accessToken: jwt('u2'), refreshToken: 'X1', expiresAt: Date.now() + HOUR })
    release()
    await expect(p).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(be.counts['/x']).toBe(1)
    expect(readTokens()?.refreshToken).toBe('X1')
  })

  it('已登录时别的标签页换了账号：重新取 /me 期间是 loading（不显示旧身份）', async () => {
    writeTokens({ accessToken: jwt('u1'), refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    let release!: () => void
    fakeBackend({ '/me': async (c) => {
      if (c.headers.Authorization === `Bearer ${jwt('u1')}`) return json({ user_entity: { id: 'u1' } })
      await new Promise<void>((r) => { release = r })
      return json({ user_entity: { id: 'u2' } })
    } })
    await restoreSession()
    const other = new BroadcastChannel('hjc-session')
    other.postMessage({ type: 'login', to: { accessToken: jwt('u2'), refreshToken: 'X1', expiresAt: Date.now() + HOUR } })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    other.close()
    expect(getSession()).toMatchObject({ status: 'loading', info: null })
    expect(can('/projects')).toBe(false)
    release()
    await vi.waitFor(() => expect(getSession().info?.user.id).toBe('u2'))
  })

  it('还没刷新过的标签页也能收到广播（initSession 时就订阅）', async () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const other = new BroadcastChannel('hjc-session')
    other.postMessage({ type: 'rotated', from: 'R1', to: { accessToken: 'A2', refreshToken: 'R2', expiresAt: Date.now() + 2 * HOUR } })
    await vi.waitFor(() => expect(readTokens()?.refreshToken).toBe('R2'))
    other.close()
  })
})

describe('第二轮 Opus 建议', () => {
  it('没有令牌时 restoreSession 总会通知订阅者（store 首屏不会卡在 loading）', async () => {
    const seen: string[] = []
    const off = (await import('../session')).subscribeSession((s) => seen.push(s.status))
    await restoreSession()
    // 先向别的标签页要令牌（loading），没有回应 → anon
    expect(seen).toEqual(['loading', 'anon'])
    off()
  })

  it('已是 anon 时收到过期通知不作废正在进行的登录', async () => {
    let release!: () => void
    fakeBackend({ '/auth/login': () => new Promise<Response>((r) => { release = () => r(json(tokens(1))) }), '/me': () => json({ user_entity: { id: 'u1' } }) })
    const p = signIn('d', 'pw', true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await request('/x').catch(() => {}) // 没有令牌的请求 → 过期通知
    release()
    await expect(p).resolves.toMatchObject({ user: { id: 'u1' } })
    expect(getSession().status).toBe('authed')
  })
})
