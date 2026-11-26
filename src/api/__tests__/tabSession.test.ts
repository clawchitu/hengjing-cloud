// @vitest-environment jsdom
// 令牌改存 sessionStorage 后的跨标签页行为：新开标签页要令牌、续期广播、一起退出、旧 localStorage 令牌清除。
// 「别的标签页」用同名 BroadcastChannel 模拟（同一进程里的另一个频道对象收得到本页的消息，本页也收得到它的）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../config'
import { __resetHttpForTests, refreshSession, request } from '../http'
import { __resetSessionForTests, ASK_TIMEOUT_MS, getSession, initSession, restoreSession, signIn, signOut } from '../session'
import { SESSION_CHANNEL, type SessionMessage } from '../sessionChannel'
import { readTokens, TOKEN_KEY, writeTokens, type Tokens } from '../tokens'
import { fakeBackend, json } from './helpers'

const HOUR = 3600_000
const jwt = (sub: string, n = 1) => `h.${btoa(JSON.stringify({ sub, n })).replace(/=+$/, '')}.s`
const tk = (sub: string, n: number, ttl = 2 * HOUR): Tokens => ({ accessToken: jwt(sub, n), refreshToken: `R${n}`, expiresAt: Date.now() + ttl })

/** 另一个标签页：收到的消息记在 got 里，send 发消息 */
function otherTab(onMessage?: (m: SessionMessage, send: (m: SessionMessage) => void) => void) {
  const c = new BroadcastChannel(SESSION_CHANNEL)
  const got: SessionMessage[] = []
  const send = (m: SessionMessage) => c.postMessage(m)
  c.addEventListener('message', (e: MessageEvent<SessionMessage>) => { got.push(e.data); onMessage?.(e.data, send) })
  tabs.push(c)
  return { got, send }
}
const tabs: BroadcastChannel[] = []

let unwire: () => void = () => {}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  setConfig({ apiBase: '/api', dataSource: 'real' })
  __resetHttpForTests(); __resetSessionForTests()
  unwire = initSession()
})
afterEach(() => {
  unwire()
  tabs.splice(0).forEach((c) => c.close())
  vi.unstubAllGlobals(); vi.useRealTimers(); setConfig(null)
})

describe('存储位置与迁移', () => {
  it('登录后令牌只在 sessionStorage，不在 localStorage', async () => {
    fakeBackend({ '/auth/login': () => json({ access_token: jwt('u1'), refresh_token: 'R1', expires_in: 7200 }), '/me': () => json({ user_entity: { id: 'u1' } }) })
    await signIn('d', 'pw')
    expect(JSON.parse(sessionStorage.getItem(TOKEN_KEY)!)).toMatchObject({ refreshToken: 'R1' })
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('关浏览器（sessionStorage 清空）后重新打开：没有别的标签页 → 未登录，不发 /me', async () => {
    writeTokens(tk('u1', 1))
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    sessionStorage.clear()
    await restoreSession()
    expect(getSession().status).toBe('anon')
    expect(be.counts['/me']).toBeUndefined()
  })

  it('旧版本留在 localStorage 的令牌：启动时清掉，不拿来恢复；账号偏好不动', async () => {
    unwire()
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tk('u1', 1)))
    const prefs = {
      'hjc-recent-projects:user:u1': '["p1"]',
      'hjc-pinned-projects:user:u1': '["p2"]',
      'hjc-weather-city:user:u1': '{"code":"110000"}',
      'hjc-project': 'p1',
    }
    for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v)
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    unwire = initSession()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(readTokens()).toBeNull()
    await restoreSession()
    expect(getSession().status).toBe('anon')
    expect(be.counts['/me']).toBeUndefined()
    for (const [k, v] of Object.entries(prefs)) expect(localStorage.getItem(k)).toBe(v)
  })

  it('readTokens 不读 localStorage（即使清理之后又被写回）', () => {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tk('u1', 1)))
    expect(readTokens()).toBeNull()
  })
})

describe('新开标签页向已登录的标签页要令牌', () => {
  it('有已登录的标签页回应 → 用它的令牌恢复登录，不登录', async () => {
    const t = tk('u1', 1)
    otherTab((m, send) => { if (m.type === 'ask') send({ type: 'give', id: m.id, tokens: t }) })
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    expect(getSession().status).toBe('authed')
    expect(readTokens()).toEqual(t)
    expect(be.callsTo('/me')[0].headers.Authorization).toBe(`Bearer ${t.accessToken}`)
    expect(be.counts['/auth/login']).toBeUndefined()
  })

  it('要令牌期间是 loading（路由守卫不跳登录页）', async () => {
    otherTab()
    const p = restoreSession()
    expect(getSession().status).toBe('loading')
    await p
    expect(getSession().status).toBe('anon')
  })

  it('没有标签页回应：约 300ms 后转为未登录', async () => {
    vi.useFakeTimers()
    const { got } = otherTab() // 在线但不回应（比如它自己也在登录页）
    fakeBackend({})
    let done = false
    void restoreSession().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 50)
    expect(done).toBe(false)
    expect(getSession().status).toBe('loading')
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(true)
    expect(getSession().status).toBe('anon')
    expect(got.some((m) => m.type === 'ask')).toBe(true)
  })

  it('已登录的本页回应别的标签页的 ask；未登录、恢复中的不回应', async () => {
    const { got, send } = otherTab()
    // 未登录：不回应
    send({ type: 'ask', id: 'q1' })
    await new Promise((r) => setTimeout(r, 30))
    expect(got.filter((m) => m.type === 'give')).toEqual([])
    // 已登录：回应自己的令牌
    const t = tk('u1', 1)
    writeTokens(t)
    fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    send({ type: 'ask', id: 'q2' })
    await vi.waitFor(() => expect(got).toContainEqual({ type: 'give', id: 'q2', tokens: t }))
  })

  it('要令牌期间别的标签页续期、续期广播先于回应到达（不同标签页）：采用续期后的令牌', async () => {
    const rotator = otherTab()
    otherTab((m, send) => {
      if (m.type !== 'ask') return
      rotator.send({ type: 'rotated', from: 'R1', to: tk('u1', 2) })
      setTimeout(() => send({ type: 'give', id: m.id, tokens: tk('u1', 1) }), 20)
    })
    fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    expect(getSession().status).toBe('authed')
    expect(readTokens()?.refreshToken).toBe('R2')
  })

  it('回应的 id 不是本页问的、或令牌格式不对：不采用', async () => {
    otherTab((m, send) => {
      if (m.type !== 'ask') return
      send({ type: 'give', id: 'not-mine', tokens: tk('u9', 9) })
      send({ type: 'give', id: m.id, tokens: { accessToken: '', refreshToken: 'x', expiresAt: 1 } as Tokens })
    })
    fakeBackend({})
    await restoreSession()
    expect(getSession().status).toBe('anon')
    expect(readTokens()).toBeNull()
  })

  it('要令牌期间本页自己登录了：迟到的回应不覆盖新登录', async () => {
    let answer!: () => void
    otherTab((m, send) => { if (m.type === 'ask') answer = () => send({ type: 'give', id: m.id, tokens: tk('u2', 7) }) })
    fakeBackend({ '/auth/login': () => json({ access_token: jwt('u1'), refresh_token: 'R1', expires_in: 7200 }), '/me': () => json({ user_entity: { id: 'u1' } }) })
    const restoring = restoreSession()
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    await signIn('d', 'pw')
    answer()
    await restoring
    await new Promise((r) => setTimeout(r, 30))
    expect(readTokens()?.refreshToken).toBe('R1')
    expect(getSession().status).toBe('authed')
  })
})

describe('续期、登录、退出在标签页之间广播', () => {
  it('续期成功 → 广播旧 refresh → 新令牌；别的标签页拿到的是新令牌', async () => {
    writeTokens(tk('u1', 1, 30_000))
    const { got } = otherTab()
    fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }), '/auth/refresh': () => json({ access_token: jwt('u1', 2), refresh_token: 'R2', expires_in: 7200 }) })
    await restoreSession()
    await refreshSession()
    await vi.waitFor(() => expect(got).toContainEqual(expect.objectContaining({ type: 'rotated', from: 'R1', to: expect.objectContaining({ refreshToken: 'R2' }) })))
  })

  it('收到别的标签页的续期广播 → 本页换上新令牌，之后续期用新的 refresh_token', async () => {
    writeTokens(tk('u1', 1))
    const { send } = otherTab()
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }), '/auth/refresh': () => json({ access_token: jwt('u1', 3), refresh_token: 'R3', expires_in: 7200 }) })
    await restoreSession()
    send({ type: 'rotated', from: 'R1', to: tk('u1', 2, 30_000) })
    await vi.waitFor(() => expect(readTokens()?.refreshToken).toBe('R2'))
    await refreshSession()
    expect((be.callsTo('/auth/refresh')[0].body as { refresh_token: string }).refresh_token).toBe('R2')
    expect(getSession().status).toBe('authed')
  })

  it('续期成功后多占锁一小会儿：排队的标签页先收到广播再拿锁', async () => {
    let releasedAt = 0
    vi.stubGlobal('navigator', { locks: { request: (_n: string, fn: () => Promise<unknown>) => fn().finally(() => { releasedAt = Date.now() }) } })
    writeTokens(tk('u1', 1, 30_000))
    fakeBackend({ '/auth/refresh': () => json({ access_token: jwt('u1', 2), refresh_token: 'R2', expires_in: 7200 }) })
    await refreshSession()
    const resolvedAt = Date.now()
    expect(releasedAt).toBe(0) // 结果已经交给调用方，锁还占着
    await vi.waitFor(() => expect(releasedAt).toBeGreaterThan(0))
    expect(releasedAt - resolvedAt).toBeGreaterThanOrEqual(90)
  })

  it('本页退出 → 广播 logout', async () => {
    writeTokens(tk('u1', 1))
    const { got } = otherTab()
    fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }), '/auth/invalidate': () => json({}) })
    await restoreSession()
    await signOut()
    await vi.waitFor(() => expect(got).toContainEqual({ type: 'logout' }))
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  for (const [name, invalidate] of [
    ['invalidate 返回 500', () => json({ code: 13, message: 'internal' }, 500)],
    ['invalidate 断网', () => { throw new TypeError('Failed to fetch') }],
  ] as const) {
    it(`退出时${name}：本地照样清干净（sessionStorage、之后的请求不带 Bearer），照样广播`, async () => {
      writeTokens(tk('u1', 1))
      const { got } = otherTab()
      let storedAtInvalidate: string | null = 'unset'
      const be = fakeBackend({
        '/me': () => json({ user_entity: { id: 'u1' } }),
        '/auth/invalidate': () => { storedAtInvalidate = sessionStorage.getItem(TOKEN_KEY); return invalidate() },
        '/x': () => json({}),
      })
      await restoreSession()
      await signOut()
      // 先清本地再调 invalidate（invalidate 带的是取出来的旧令牌）
      expect(storedAtInvalidate).toBeNull()
      expect(be.callsTo('/auth/invalidate')[0].headers.Authorization).toBe(`Bearer ${jwt('u1', 1)}`)
      expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
      expect(readTokens()).toBeNull()
      expect(getSession().status).toBe('anon')
      await vi.waitFor(() => expect(got).toContainEqual({ type: 'logout' }))
      await request('/x').catch(() => {})
      expect(be.callsTo('/x')[0]?.headers.Authorization).toBeUndefined()
    })
  }

  it('别的标签页退出 → 本页清令牌、转为未登录，不再调 invalidate', async () => {
    writeTokens(tk('u1', 1))
    const { send } = otherTab()
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    send({ type: 'logout' })
    await vi.waitFor(() => expect(getSession().status).toBe('anon'))
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(be.counts['/auth/invalidate']).toBeUndefined()
  })

  it('恢复时断网落在登录页、还留着令牌的标签页：收到退出广播也清令牌，刷新不能再进去', async () => {
    writeTokens(tk('u1', 1))
    const { send } = otherTab()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    await restoreSession()
    expect(getSession().status).toBe('anon')
    expect(readTokens()).not.toBeNull()
    send({ type: 'logout' })
    await vi.waitFor(() => expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull())
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession() // 网络恢复后按 F5
    expect(getSession().status).toBe('anon')
    expect(be.counts['/me']).toBeUndefined()
  })

  it('登录页上留着令牌的标签页不跟着别处续期', async () => {
    writeTokens(tk('u1', 1))
    const { send } = otherTab()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    await restoreSession()
    send({ type: 'rotated', from: 'R1', to: tk('u1', 2) })
    await new Promise((r) => setTimeout(r, 30))
    expect(readTokens()?.refreshToken).toBe('R1')
  })

  it('同一会话的续期广播只重排定时器：令牌没有 sub 也不重新取 /me', async () => {
    writeTokens({ accessToken: 'opaque-1', refreshToken: 'R1', expiresAt: Date.now() + HOUR })
    const { send } = otherTab()
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    send({ type: 'rotated', from: 'R1', to: { accessToken: 'opaque-2', refreshToken: 'R2', expiresAt: Date.now() + 2 * HOUR } })
    await vi.waitFor(() => expect(readTokens()?.refreshToken).toBe('R2'))
    await new Promise((r) => setTimeout(r, 10))
    expect(be.counts['/me']).toBe(1)
    expect(getSession().status).toBe('authed')
  })

  it('本页登录 → 广播 login；在登录页的标签页收到别处的 login 不自动登录', async () => {
    const { got, send } = otherTab()
    fakeBackend({ '/auth/login': () => json({ access_token: jwt('u1'), refresh_token: 'R1', expires_in: 7200 }), '/me': () => json({ user_entity: { id: 'u1' } }) })
    await signIn('d', 'pw')
    await vi.waitFor(() => expect(got).toContainEqual(expect.objectContaining({ type: 'login', to: expect.objectContaining({ refreshToken: 'R1' }) })))
    await signOut()
    send({ type: 'login', to: tk('u1', 5) })
    await new Promise((r) => setTimeout(r, 30))
    expect(getSession().status).toBe('anon')
    expect(readTokens()).toBeNull()
  })

  it('已登录时别的标签页同一账号重新登录 → 换上新令牌（旧 refresh_token 已作废），不重新取 /me', async () => {
    writeTokens(tk('u1', 1))
    const { send } = otherTab()
    const be = fakeBackend({ '/me': () => json({ user_entity: { id: 'u1' } }) })
    await restoreSession()
    send({ type: 'login', to: tk('u1', 8) })
    await vi.waitFor(() => expect(readTokens()?.refreshToken).toBe('R8'))
    await new Promise((r) => setTimeout(r, 10))
    expect(be.counts['/me']).toBe(1)
    expect(getSession().status).toBe('authed')
  })
})
