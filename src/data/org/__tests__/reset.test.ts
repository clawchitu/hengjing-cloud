// @vitest-environment jsdom
// 账号变化时清掉全部查询缓存（含 S4 不带账号的 ['ctrl', …]），并取消进行中的请求
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../../../api/config'
import { __resetHttpForTests, request } from '../../../api/http'
import { createQueryClient } from '../../../api/query'
import { __resetSessionForTests, getSession, initSession, signIn, signOut } from '../../../api/session'
import { clearTokens } from '../../../api/tokens'
import { fakeBackend, json, text } from '../../../api/__tests__/helpers'
import { __resetSessionViewForTests } from '../../session'
import { useResetOnAccountChange } from '../hooks'

let meId = 'u1'
let unwire = () => {}
function backend() {
  fakeBackend({
    '/auth/login': () => json({ access_token: 'A1', refresh_token: 'R1', expires_in: 7200 }),
    '/me': () => json({ user_entity: { id: meId } }),
    '/auth/invalidate': () => json({}),
    '/auth/refresh': () => json({ code: 16, message: 'invalid refresh_token' }, 401),
    '/ctrl/projects': () => text('token err', 403),
  })
}
function setup() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  renderHook(() => useResetOnAccountChange(), { wrapper })
  const seed = () => {
    client.setQueryData(['ctrl', 200, 'p1', null], { data: ['上一个账号的房间'] })
    client.setQueryData(['org', 'user:' + meId, 'projects', { onlyOnline: false }], [{ id: 'p1' }])
  }
  const cached = () => client.getQueryCache().getAll().length
  return { client, seed, cached }
}

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  localStorage.clear(); sessionStorage.clear(); meId = 'u1'
  __resetHttpForTests(); __resetSessionForTests(); __resetSessionViewForTests(); clearTokens()
  unwire = initSession()
  backend()
})
afterEach(() => { unwire(); vi.unstubAllGlobals(); setConfig(null) })

describe('账号变化清缓存', () => {
  it('主动退出：ctrl 与组织数据都清掉，进行中的请求被取消', async () => {
    await signIn('u', 'pw', true)
    const { client, seed, cached } = setup()
    seed()
    let aborted = false
    void client.prefetchQuery({ queryKey: ['ctrl', 205, 'p1', null], queryFn: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')) })) })
    expect(cached()).toBe(3)
    await act(() => signOut())
    expect(cached()).toBe(0)
    expect(aborted).toBe(true)
  })

  it('续期失败（令牌失效且刷新被拒）：转为未登录并清缓存', async () => {
    await signIn('u', 'pw', true)
    const { seed, cached } = setup()
    seed()
    await act(async () => { await request('/ctrl/projects').catch(() => {}) })
    expect(getSession().status).toBe('anon')
    expect(cached()).toBe(0)
  })

  it('换账号（不经过退出直接登录另一个账号）：清掉上一个账号的缓存', async () => {
    await signIn('u', 'pw', true)
    const { seed, cached } = setup()
    seed()
    meId = 'u2'
    await act(async () => { await signIn('v', 'pw', true) })
    expect(cached()).toBe(0)
  })

  it('同账号退出后重新登录：重新登录后看不到退出前的缓存', async () => {
    await signIn('u', 'pw', true)
    const { client, seed, cached } = setup()
    seed()
    await act(() => signOut())
    await act(async () => { await signIn('u', 'pw', true) })
    expect(cached()).toBe(0)
    expect(client.getQueryData(['ctrl', 200, 'p1', null])).toBeUndefined()
  })

  it('同一账号保持登录（续期等）不清缓存', async () => {
    await signIn('u', 'pw', true)
    const { seed, cached } = setup()
    seed()
    expect(cached()).toBe(2)
  })
})
