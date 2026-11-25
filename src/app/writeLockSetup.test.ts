// @vitest-environment jsdom
// 应用初始化之后：203（统一控制）、温控（201 / 206）和新风（204）核对器都已注册、各一次，configureWriteLock 只调一次；
// 经过 Guard、StrictMode 双调用、重新挂载之后仍然如此。
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registered: number[] = []
const configured: unknown[] = []
vi.mock('../api/writeLock', async (orig) => {
  const m = await orig<typeof import('../api/writeLock')>()
  return {
    ...m,
    configureWriteLock: ((o: never) => { configured.push(o); return m.configureWriteLock(o) }) as typeof m.configureWriteLock,
    registerVerifier: ((msg: number, fn: never) => { registered.push(msg); return m.registerVerifier(msg, fn) }) as typeof m.registerVerifier,
  }
})

import * as W from '../api/writeLock'
import { setConfig } from '../api/config'
import { createQueryClient } from '../api/query'
import { __resetSessionViewForTests, mockSignIn } from '../data/session'
import { AppProvider, useApp } from './store'
import { OrgGate } from './OrgGate'
import { registerAllVerifiers } from './writeLockSetup'
import { __resetHttpForTests } from '../api/http'
import { __resetSessionForTests, signIn } from '../api/session'
import { clearTokens } from '../api/tokens'
import { fakeBackend, json } from '../api/__tests__/helpers'

function Guard({ children }: { children: React.ReactNode }) {
  const { authed, authLoading } = useApp()
  return authLoading || !authed ? null : createElement('div', null, children)
}
const tree = (qc: ReturnType<typeof createQueryClient>) =>
  createElement(QueryClientProvider, { client: qc }, createElement(AppProvider, null,
    createElement(MemoryRouter, null, createElement(Routes, null,
      createElement(Route, { path: '*', element: createElement(Guard, null, createElement(OrgGate, null, createElement('p', null, 'ok'))) })))))
const sorted = () => [...registered].sort((a, b) => a - b)

beforeEach(() => {
  localStorage.clear(); registered.length = 0; configured.length = 0
  __resetSessionViewForTests()
  setConfig({ apiBase: '/api', dataSource: 'mock' })
  mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
})
afterEach(() => { cleanup(); setConfig(null); W.__resetWriteLockForTests() })

describe('写锁核对器注册', () => {
  it('经过 Guard 之后，203 / 201 / 204 / 206 都已注册，各一次，configureWriteLock 一次', async () => {
    const r = render(tree(createQueryClient()))
    await waitFor(() => expect(r.getByText('ok')).toBeTruthy())
    expect(sorted()).toEqual([201, 203, 204, 206])
    expect(configured).toHaveLength(1)
  })
  it('StrictMode 双调用：仍各一次', async () => {
    const r = render(createElement(StrictMode, null, tree(createQueryClient())))
    await waitFor(() => expect(r.getByText('ok')).toBeTruthy())
    expect(sorted()).toEqual([201, 203, 204, 206])
    expect(configured).toHaveLength(1)
  })
  it('同一个 QueryClient 重新挂载 / 直接再调：不重复注册', async () => {
    const qc = createQueryClient()
    const r = render(tree(qc))
    await waitFor(() => expect(r.getByText('ok')).toBeTruthy())
    r.unmount()
    const r2 = render(tree(qc))
    await waitFor(() => expect(r2.getByText('ok')).toBeTruthy())
    registerAllVerifiers(qc)
    expect(sorted()).toEqual([201, 203, 204, 206])
    expect(configured).toHaveLength(1)
  })
})

describe('204（新风）核对器的注册时机', () => {
  afterEach(() => { vi.unstubAllGlobals(); __resetSessionForTests(); clearTokens() })

  it('组织数据就绪前 204（以及 201 / 206）尚未注册，只有 203；项目列表返回后才注册 204，且只一次', async () => {
    __resetHttpForTests(); __resetSessionForTests(); clearTokens()
    setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    fakeBackend({
      '/auth/login': () => json({ access_token: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refresh_token: 'R1', expires_in: 7200 }),
      '/me': () => json({ user_entity: { id: 'u1', name: '测试' }, permission_paths: [] }),
      '/integrated-projects': () => json({ entities: [] }),
      '/distributors': () => json({ distributor_entities: [] }),
      '/ctrl/projects': async () => { await gate; return json({ project_entities: [] }) },
    })
    await signIn('u', 'pw', true)
    const r = render(tree(createQueryClient()))
    await waitFor(() => expect(r.getByText('正在加载')).toBeTruthy())
    await new Promise((x) => setTimeout(x, 50))
    expect(sorted()).toEqual([203])
    release()
    await waitFor(() => expect(r.getByText('ok')).toBeTruthy())
    await waitFor(() => expect(sorted()).toEqual([201, 203, 204, 206]))
  })
})
