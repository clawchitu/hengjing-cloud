// @vitest-environment jsdom
// 无操作超时（idle.ts + session.ts + http.ts）：8 小时没有用户操作就要重新登录。全部用假时钟。
// 「别的标签页」：最后操作时间在 localStorage 共享，直接写 hjc-last-activity；广播用同名 BroadcastChannel 收。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, setConfig } from '../config'
import { __resetHttpForTests, refreshSession, request } from '../http'
import { ACTIVITY_KEY, IDLE_LOGOUT_TEXT, readLastActivity } from '../idle'
import { __resetSessionForTests, getSession, initSession, isIdleLogout, restoreSession, signIn } from '../session'
import { SESSION_CHANNEL, type SessionMessage } from '../sessionChannel'
import { readTokens, writeTokens } from '../tokens'
import { fakeBackend, json } from './helpers'

const MIN = 60_000
const HOUR = 60 * MIN
const jwt = (sub: string, n = 1) => `h.${btoa(JSON.stringify({ sub, n })).replace(/=+$/, '')}.s`

/** 假后端：登录、/me、invalidate、轮换的 refresh、一个读接口 /projects */
function backend() {
  let n = 1
  return fakeBackend({
    '/auth/login': () => json({ access_token: jwt('u1', 1), refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: 'u1' } }),
    '/auth/invalidate': () => json({}),
    '/auth/refresh': () => { n++; return json({ access_token: jwt('u1', n), refresh_token: `R${n}`, expires_in: 7200 }) },
    '/projects': () => json({ list: [] }),
  })
}

const tabs: BroadcastChannel[] = []
function otherTab() {
  const c = new BroadcastChannel(SESSION_CHANNEL)
  const got: SessionMessage[] = []
  c.addEventListener('message', (e: MessageEvent<SessionMessage>) => { got.push(e.data) })
  tabs.push(c)
  return got
}
const otherTabActs = () => localStorage.setItem(ACTIVITY_KEY, String(Date.now()))
const userActs = (type = 'pointerdown') => window.dispatchEvent(new Event(type))

let unwire: () => void = () => {}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
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

describe('运行中：8 小时无操作', () => {
  it('7 小时 59 分无操作：不退出（期间照常续期）', async () => {
    const be = backend()
    await signIn('d', 'pw')
    await vi.advanceTimersByTimeAsync(7 * HOUR + 59 * MIN)
    expect(getSession().status).toBe('authed')
    expect(be.counts['/auth/refresh']).toBeGreaterThan(0)
    expect(be.counts['/auth/invalidate']).toBeUndefined()
  })

  it('8 小时 1 分无操作：退出，清令牌、调 invalidate、广播给其他标签页，原因是「长时间未操作」', async () => {
    const be = backend()
    const got = otherTab()
    await signIn('d', 'pw')
    await vi.advanceTimersByTimeAsync(8 * HOUR + MIN)
    expect(getSession().status).toBe('anon')
    expect(isIdleLogout(getSession().reason)).toBe(true)
    expect(getSession().reason?.message).toBe(IDLE_LOGOUT_TEXT)
    expect(readTokens()).toBeNull()
    expect(be.callsTo('/auth/invalidate')).toHaveLength(1)
    await vi.waitFor(() => expect(got).toContainEqual({ type: 'logout', reason: 'idle' }))
  })

  it('另一个标签页有操作：本标签页不退出；从那次操作起算满 8 小时才退出', async () => {
    backend()
    await signIn('d', 'pw')
    await vi.advanceTimersByTimeAsync(7 * HOUR)
    otherTabActs()
    await vi.advanceTimersByTimeAsync(HOUR + 2 * MIN) // 距登录 8 小时 2 分
    expect(getSession().status).toBe('authed')
    await vi.advanceTimersByTimeAsync(7 * HOUR)
    expect(getSession().status).toBe('anon')
    expect(isIdleLogout(getSession().reason)).toBe(true)
  })

  it('本页的点击、按键、滚轮、触摸都算操作', async () => {
    backend()
    await signIn('d', 'pw')
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      await vi.advanceTimersByTimeAsync(7 * HOUR)
      userActs(ev)
      expect(readLastActivity()).toBe(Date.now())
    }
    await vi.advanceTimersByTimeAsync(7 * HOUR + 59 * MIN)
    expect(getSession().status).toBe('authed')
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(getSession().status).toBe('anon')
  })

  it('操作节流：同一标签页每分钟最多记一次', async () => {
    backend()
    await signIn('d', 'pw')
    const t0 = readLastActivity()!
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const writes = () => set.mock.calls.filter(([k]) => k === ACTIVITY_KEY).length
    await vi.advanceTimersByTimeAsync(10_000)
    userActs(); userActs('keydown')
    expect(writes()).toBe(0) // 登录时刚记过，不到一分钟
    expect(readLastActivity()).toBe(t0)
    await vi.advanceTimersByTimeAsync(MIN)
    userActs(); userActs('keydown'); userActs('wheel')
    expect(writes()).toBe(1)
    set.mockRestore()
  })

  it('只有后台轮询、没有用户交互：仍然会超时；轮询不更新最后操作时间', async () => {
    const be = backend()
    await signIn('d', 'pw')
    const t0 = readLastActivity()
    const poll = setInterval(() => { void request('/projects', { method: 'GET' }).catch(() => {}) }, 30_000)
    // 页面可见性变化（切走、切回）也不算操作
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(8 * HOUR + MIN)
    clearInterval(poll)
    expect(be.counts['/projects']).toBeGreaterThan(900)
    expect(readLastActivity()).toBe(t0)
    expect(getSession().status).toBe('anon')
    expect(isIdleLogout(getSession().reason)).toBe(true)
  })

  it('超时后的第一下点击不能续上会话', async () => {
    backend()
    await signIn('d', 'pw')
    // 休眠：时钟跳过 9 小时、定时器还没来得及跑
    vi.setSystemTime(Date.now() + 9 * HOUR)
    userActs()
    expect(getSession().status).toBe('anon')
    expect(isIdleLogout(getSession().reason)).toBe(true)
  })

  it('时长按 config.js 的 idleTimeoutHours', async () => {
    setConfig({ apiBase: '/api', dataSource: 'real', idleTimeoutHours: 0.5 })
    backend()
    await signIn('d', 'pw')
    await vi.advanceTimersByTimeAsync(29 * MIN)
    expect(getSession().status).toBe('authed')
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(getSession().status).toBe('anon')
  })
})

describe('超时后不再续期', () => {
  it('定时续期到点时已超时：不发 refresh，直接退出', async () => {
    const be = backend()
    await signIn('d', 'pw')
    const before = be.counts['/auth/refresh'] ?? 0
    // 时钟跳到 9 小时后（休眠唤醒），令牌也早过期了：切回标签页时先查超时
    vi.setSystemTime(Date.now() + 9 * HOUR)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(getSession().status).toBe('anon')
    expect(be.counts['/auth/refresh'] ?? 0).toBe(before)
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(be.counts['/auth/refresh'] ?? 0).toBe(before)
  })

  it('请求触发的续期：已超时就不续期，请求按未登录失败，会话退出', async () => {
    const be = backend()
    await signIn('d', 'pw')
    vi.setSystemTime(Date.now() + 9 * HOUR)
    const e = await request('/projects', { method: 'GET' }).catch((x: unknown) => x)
    expect(e).toMatchObject({ kind: 'unauthenticated', message: IDLE_LOGOUT_TEXT })
    expect(be.counts['/auth/refresh']).toBeUndefined()
    expect(be.counts['/projects']).toBeUndefined()
    expect(getSession().status).toBe('anon')
    expect(isIdleLogout(getSession().reason)).toBe(true)
    await expect(refreshSession()).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(be.counts['/auth/refresh']).toBeUndefined()
  })

  it('超时退出后，之前一直在跑的续期定时器不再续期', async () => {
    const be = backend()
    await signIn('d', 'pw')
    await vi.advanceTimersByTimeAsync(8 * HOUR + MIN)
    expect(getSession().status).toBe('anon')
    const n = be.counts['/auth/refresh'] ?? 0
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(be.counts['/auth/refresh'] ?? 0).toBe(n)
  })
})

describe('启动时（Chrome 恢复会话、刷新页面）', () => {
  const stored = (loginAt: number) => writeTokens({ accessToken: jwt('u1'), refreshToken: 'R1', expiresAt: Date.now() + 2 * HOUR, loginAt })

  it('最后操作超过 8 小时：清令牌、调 invalidate、转为未登录并带「长时间未操作」，不取 /me', async () => {
    const be = backend()
    const got = otherTab()
    stored(Date.now() - 10 * HOUR)
    localStorage.setItem(ACTIVITY_KEY, String(Date.now() - 8 * HOUR - MIN))
    await restoreSession()
    expect(getSession().status).toBe('anon')
    expect(getSession().reason?.message).toBe(IDLE_LOGOUT_TEXT)
    expect(readTokens()).toBeNull()
    expect(be.counts['/me']).toBeUndefined()
    expect(be.callsTo('/auth/invalidate')).toHaveLength(1)
    await vi.waitFor(() => expect(got).toContainEqual({ type: 'logout', reason: 'idle' }))
  })

  it('最后操作 7 小时 59 分前：正常恢复', async () => {
    backend()
    stored(Date.now() - 10 * HOUR)
    localStorage.setItem(ACTIVITY_KEY, String(Date.now() - 7 * HOUR - 59 * MIN))
    await restoreSession()
    expect(getSession().status).toBe('authed')
  })

  it('最后操作时间缺失、损坏，或早于本次登录：一律退出', async () => {
    for (const v of [null, 'abc', '0', 'early']) {
      __resetSessionForTests()
      const be = backend()
      const loginAt = Date.now() - HOUR
      stored(loginAt)
      if (v === null) localStorage.removeItem(ACTIVITY_KEY)
      else localStorage.setItem(ACTIVITY_KEY, v === 'early' ? String(loginAt - 1) : v)
      await restoreSession()
      expect(getSession().status, String(v)).toBe('anon')
      expect(isIdleLogout(getSession().reason), String(v)).toBe(true)
      expect(be.counts['/me'], String(v)).toBeUndefined()
    }
  })

  it('旧版本的令牌（没有 loginAt）：只看最后操作时间', async () => {
    backend()
    writeTokens({ accessToken: jwt('u1'), refreshToken: 'R1', expiresAt: Date.now() + 2 * HOUR })
    localStorage.setItem(ACTIVITY_KEY, String(Date.now() - HOUR))
    await restoreSession()
    expect(getSession().status).toBe('authed')
  })

  it('续期沿用登录时刻：续期之后刷新页面，不会因「最后操作早于令牌」被踢', async () => {
    backend()
    await signIn('d', 'pw')
    const loginAt = readTokens()!.loginAt
    expect(loginAt).toBeTypeOf('number')
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(readTokens()!.refreshToken).not.toBe('R1')
    expect(readTokens()!.loginAt).toBe(loginAt)
    __resetSessionForTests()
    await restoreSession()
    expect(getSession().status).toBe('authed')
  })

  it('登录成功时把最后操作时间写成当前时间', async () => {
    backend()
    localStorage.setItem(ACTIVITY_KEY, String(Date.now() - 20 * HOUR))
    await vi.advanceTimersByTimeAsync(5 * MIN)
    await signIn('d', 'pw')
    expect(readLastActivity()).toBe(Date.now())
  })
})

describe('别的标签页超时退出', () => {
  it('收到 logout（reason: idle）：本页也退出，原因是「长时间未操作」', async () => {
    backend()
    await signIn('d', 'pw')
    const c = new BroadcastChannel(SESSION_CHANNEL); tabs.push(c)
    c.postMessage({ type: 'logout', reason: 'idle' } satisfies SessionMessage)
    await vi.waitFor(() => expect(getSession().status).toBe('anon'))
    expect(isIdleLogout(getSession().reason)).toBe(true)
    expect(readTokens()).toBeNull()
  })
})

describe('配置 idleTimeoutHours', () => {
  it('默认 8；正数（含小数、数字字符串）照用；其他取默认', () => {
    expect(resolveConfig([]).idleTimeoutHours).toBe(8)
    expect(resolveConfig([{ idleTimeoutHours: 2 }]).idleTimeoutHours).toBe(2)
    expect(resolveConfig([{ idleTimeoutHours: 0.5 }]).idleTimeoutHours).toBe(0.5)
    expect(resolveConfig([{ idleTimeoutHours: '4' }]).idleTimeoutHours).toBe(4)
    for (const bad of [0, -1, NaN, Infinity, '', 'x', null, true, {}]) expect(resolveConfig([{ idleTimeoutHours: bad }]).idleTimeoutHours).toBe(8)
  })
})
