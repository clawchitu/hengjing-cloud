// @vitest-environment jsdom
// 应用初始化之后：203（统一控制）和温控（201 / 206）两个核对器都已注册；核对器只经 writeLockSetup 注册。
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registered: number[] = []
const configured: unknown[] = []
vi.mock('../api/writeLock', async (orig) => {
  const m = await orig<typeof import('../api/writeLock')>()
  return { ...m, configureWriteLock: ((o: never) => { configured.push(o); return m.configureWriteLock(o) }) as typeof m.configureWriteLock, registerVerifier: ((msg: number, fn: never) => { registered.push(msg); return m.registerVerifier(msg, fn) }) as typeof m.registerVerifier }
})

import * as W from '../api/writeLock'
import { setConfig } from '../api/config'
import { createQueryClient } from '../api/query'
import { __resetSessionViewForTests, mockSignIn } from '../data/session'
import { AppProvider } from './store'
import { OrgGate } from './OrgGate'

beforeEach(() => {
  localStorage.clear(); registered.length = 0
  __resetSessionViewForTests()
  setConfig({ apiBase: '/api', dataSource: 'mock' })
  mockSignIn({ username: 'cosyhome', role: 'dealer' }, true)
})
afterEach(() => { cleanup(); setConfig(null); W.__resetWriteLockForTests() })

describe('写锁核对器注册', () => {
  it('应用初始化之后，203 和温控（201 / 206）核对器都已注册，且各注册一次', async () => {
    render(createElement(QueryClientProvider, { client: createQueryClient() }, createElement(AppProvider, null, createElement(OrgGate, null, createElement('div', null, 'ok')))))
    await waitFor(() => expect([...registered].sort()).toEqual([201, 203, 206]))
    expect(configured).toHaveLength(1) // configureWriteLock 只调一次
  })
})
