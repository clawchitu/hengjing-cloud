// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../../api/config'
import { __resetHttpForTests } from '../../api/http'
import { __resetSessionForTests, signIn } from '../../api/session'
import { clearTokens, writeTokens } from '../../api/tokens'
import { fakeBackend, json } from '../../api/__tests__/helpers'
import { __resetSessionViewForTests, getSessionView, logout, MOCK_AUTH_KEY, mockSignIn, useSession } from '../session'

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); clearTokens()
})
afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

describe('演示数据模式（hjc-auth）', () => {
  beforeEach(() => setConfig({ dataSource: 'mock' }))

  it('启动时读预置的 hjc-auth（e2e 靠它进入页面）', () => {
    localStorage.setItem(MOCK_AUTH_KEY, JSON.stringify({ username: 'hjadmin', role: 'admin' }))
    const v = getSessionView()
    expect(v).toMatchObject({ authed: true, authLoading: false, dealerAccount: false, userKey: 'mock:hjadmin' })
    expect(v.user.name).toBe('王立')
  })

  it('损坏或伪造的 hjc-auth 当作未登录', () => {
    localStorage.setItem(MOCK_AUTH_KEY, JSON.stringify({ username: 'x', role: 'root' }))
    expect(getSessionView().authed).toBe(false)
  })

  it('登录：勾选记住我存 localStorage，否则 sessionStorage；退出清掉；hook 跟着更新', () => {
    const { result } = renderHook(() => useSession())
    expect(result.current.authed).toBe(false)
    act(() => mockSignIn({ username: 'cosyhome', role: 'dealer' }, false))
    expect(sessionStorage.getItem(MOCK_AUTH_KEY)).not.toBeNull()
    expect(localStorage.getItem(MOCK_AUTH_KEY)).toBeNull()
    expect(result.current).toMatchObject({ authed: true, dealerAccount: true, user: { username: 'cosyhome', role: 'dealer' } })
    act(() => mockSignIn({ username: 'hjadmin', role: 'admin' }, true))
    expect(sessionStorage.getItem(MOCK_AUTH_KEY)).toBeNull()
    expect(localStorage.getItem(MOCK_AUTH_KEY)).not.toBeNull()
    act(() => logout())
    expect(result.current.authed).toBe(false)
    expect(localStorage.getItem(MOCK_AUTH_KEY)).toBeNull()
  })

  it('同一状态下视图（含 user）引用稳定，页面里以 user 为依赖的 effect 不会白跑', () => {
    mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
    expect(getSessionView()).toBe(getSessionView())
    expect(getSessionView().user).toBe(getSessionView().user)
  })
})

describe('真实接口模式', () => {
  beforeEach(() => setConfig({ apiBase: '/api', dataSource: 'real' }))

  it('有已存令牌、恢复还没开始时先报 loading，守卫不会提前跳登录页', () => {
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3600_000 }, true)
    expect(getSessionView()).toMatchObject({ authed: false, authLoading: true })
  })

  it('没有令牌 → 未登录', () => {
    expect(getSessionView()).toMatchObject({ authed: false, authLoading: false, userKey: null })
  })

  it('登录后：身份取自 /me（type=1 经销商），userKey 按用户 ID', async () => {
    fakeBackend({
      '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
      '/me': () => json({ user_entity: { id: 'u9', name: '科希家苏州测试', mobile: '13800000000', type: 1 } }),
    })
    await signIn('d', 'pw', true)
    expect(getSessionView()).toMatchObject({ authed: true, dealerAccount: true, userKey: 'user:u9', user: { name: '科希家苏州测试', role: 'dealer', roleLabel: '经销商' } })
  })
})
