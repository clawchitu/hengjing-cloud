// @vitest-environment jsdom
// 路由守卫 + 登录跳转（S13 走查 P7）：换账号登录不回上一个账号的页面；同一账号重新登录回原页面；刷新后也成立。
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setConfig } from '../api/config'
import { createQueryClient } from '../api/query'
import { __resetSessionForTests } from '../api/session'
import { clearTokens } from '../api/tokens'
import { __resetSessionViewForTests, logout, mockSignIn } from '../data/session'
import { __resetCurrentForTests } from '../data/org/current'
import { AppProvider } from './store'
import { Guard, LAST_USER_KEY, LoginRoute } from './routes'

const page = (name: string) => createElement('div', null, name + '页内容')
function mount(path: string) {
  const client = createQueryClient()
  return render(createElement(QueryClientProvider, { client }, createElement(AppProvider, null,
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null,
      createElement(Route, { path: '/login', element: createElement(LoginRoute) }),
      createElement(Route, { path: '/home', element: createElement(Guard, null, page('首页')) }),
      createElement(Route, { path: '/thermostat', element: createElement(Guard, null, page('温控')) }),
    )))))
}
const A = { username: 'hjadmin', role: 'admin' as const }
const B = { username: 'cosyhome', role: 'dealer' as const }

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  setConfig({ dataSource: 'mock' })
  localStorage.clear(); sessionStorage.clear()
  __resetSessionForTests(); __resetSessionViewForTests(); __resetCurrentForTests(); clearTokens()
})
afterEach(() => { cleanup(); setConfig(null) })

describe('登录后跳转（S13 走查 P7）', () => {
  it('A 停在 /thermostat 退出，B 登录 → 首页，不回 A 的页面', async () => {
    mockSignIn(A, true)
    mount('/thermostat')
    expect(await screen.findByText('温控页内容')).toBeTruthy()
    act(() => { logout() })
    expect(await screen.findByText('欢迎登录')).toBeTruthy()
    act(() => { mockSignIn(B, true) })
    expect(await screen.findByText('首页页内容')).toBeTruthy()
  })

  it('同一账号重新登录 → 回原页面', async () => {
    mockSignIn(A, true)
    mount('/thermostat')
    await screen.findByText('温控页内容')
    act(() => { logout() })
    await screen.findByText('欢迎登录')
    act(() => { mockSignIn(A, true) })
    expect(await screen.findByText('温控页内容')).toBeTruthy()
  })

  it('刷新后（内存里没有上一个账号）会话没恢复，跳登录页；B 登录仍回首页，A 登录回原页面', async () => {
    mockSignIn(A, true)
    const first = mount('/thermostat')
    await screen.findByText('温控页内容')
    expect(localStorage.getItem(LAST_USER_KEY)).toBe('mock:hjadmin')
    first.unmount()
    act(() => { logout() })
    // 模拟刷新：重新挂载，未登录状态打开 /thermostat
    mount('/thermostat')
    await screen.findByText('欢迎登录')
    act(() => { mockSignIn(B, true) })
    expect(await screen.findByText('首页页内容')).toBeTruthy()
    cleanup()
    act(() => { logout() })
    localStorage.setItem(LAST_USER_KEY, 'mock:hjadmin')
    mount('/thermostat')
    await screen.findByText('欢迎登录')
    act(() => { mockSignIn(A, true) })
    expect(await screen.findByText('温控页内容')).toBeTruthy()
  })
})
