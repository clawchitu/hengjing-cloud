// 登录态（从 store.tsx 拆出）。两种数据源：
// - mock：演示账号，登录结果存 hjc-auth（localStorage / sessionStorage），e2e 靠预置它进入页面；
// - real：src/api/session.ts 的状态机（/me 只放内存）。
// 用模块级外部存储 + useSyncExternalStore，不需要 Provider；启动副作用（接上过期通知、用已存令牌恢复）
// 由 useSessionBoot() 负责，AppProvider 调一次。
import { useEffect, useSyncExternalStore } from 'react'
import { profile } from '../api'
import { isMockMode } from '../api/config'
import type { ApiError } from '../api/errors'
import { can as canRoute, getSession, initSession, restoreSession, signOut, subscribeSession, type SessionInfo, type SessionState } from '../api/session'
import { hasSessionChannel } from '../api/sessionChannel'
import { purgeLegacyTokens, readTokens } from '../api/tokens'
import type { Role, User } from './org/types'

export type MockAuth = { username: string; role: Role }

export interface SessionView {
  authed: boolean
  /** 真实接口模式：正在用已存的令牌取 /me 恢复登录态，路由守卫等它结束再决定是否跳登录页 */
  authLoading: boolean
  /** 真实接口模式的 /me 结果（只在内存里）；演示数据模式为 null */
  session: SessionInfo | null
  user: User
  /** 经销商账号：真实接口看 /me 的 type=1，演示数据看 role */
  dealerAccount: boolean
  /** 区分账号的键（查询缓存按它隔离）；未登录为 null */
  userKey: string | null
  /** 真实接口模式下最近一次变成未登录的原因（续期失败等） */
  reason?: ApiError
}

// ---------------------------------------------------------------------------
// mock：hjc-auth

export const MOCK_AUTH_KEY = 'hjc-auth'

function readMockAuth(): MockAuth | null {
  const raw = localStorage.getItem(MOCK_AUTH_KEY) || sessionStorage.getItem(MOCK_AUTH_KEY)
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as MockAuth
    return a && typeof a.username === 'string' && (a.role === 'dealer' || a.role === 'admin') ? a : null
  } catch { return null }
}
const clearMockAuth = () => { localStorage.removeItem(MOCK_AUTH_KEY); sessionStorage.removeItem(MOCK_AUTH_KEY) }

let mockAuth: MockAuth | null | undefined // undefined：还没读过存储
const getMockAuth = () => (mockAuth === undefined ? (mockAuth = readMockAuth()) : mockAuth)
const subs = new Set<() => void>()
const emit = () => { for (const fn of subs) fn() }

/** 演示数据模式的登录（Worker 校验演示账号后调用）；真实接口模式由登录页调 api/session 的 signIn() */
export function mockSignIn(a: MockAuth, remember: boolean) {
  clearMockAuth()
  ;(remember ? localStorage : sessionStorage).setItem(MOCK_AUTH_KEY, JSON.stringify(a))
  mockAuth = a
  emit()
}

// ---------------------------------------------------------------------------
// real：首屏在恢复开始前，有令牌（或能向别的标签页要令牌）就先当作 loading，避免守卫在恢复完成前把人踢到登录页

let booted = false
let mayRestore: boolean | undefined
const LOADING: SessionState = { status: 'loading', info: null }
function realState(): SessionState {
  if (!booted) {
    if (mayRestore === undefined) mayRestore = !!readTokens() || hasSessionChannel()
    if (mayRestore && getSession().status === 'anon') return LOADING
  }
  return getSession()
}

/** 真实接口模式下页面用的 User：名字、手机号、身份取自 /me（「机构」无来源，沿用固定文案） */
function userOf(info: SessionInfo): User {
  return {
    username: info.user.mobile || info.user.id,
    name: info.user.name || info.user.mobile || info.user.id,
    org: '恒境云平台',
    role: info.dealer ? 'dealer' : 'admin',
    roleLabel: info.dealer ? '经销商' : '管理员',
  }
}

// ---------------------------------------------------------------------------
// 视图：按底层状态的引用缓存，同一状态下各组件拿到同一个对象（user 引用稳定，页面 effect 不会白跑）

let cacheKey: unknown
let cacheMode: boolean | undefined
let cacheView: SessionView | undefined

export function getSessionView(): SessionView {
  const mock = isMockMode()
  const src = mock ? getMockAuth() : realState()
  if (cacheView && cacheKey === src && cacheMode === mock) return cacheView
  let view: SessionView
  if (mock) {
    const a = src as MockAuth | null
    const user = profile(a?.username ?? '')
    view = { authed: !!a, authLoading: false, session: null, user, dealerAccount: user.role === 'dealer', userKey: a ? 'mock:' + user.username : null }
  } else {
    const s = src as SessionState
    const info = s.status === 'authed' ? s.info : null
    view = {
      authed: s.status === 'authed',
      authLoading: s.status === 'loading',
      session: info,
      user: info ? userOf(info) : profile(''),
      dealerAccount: !!info?.dealer,
      userKey: info ? 'user:' + info.user.id : null,
      reason: s.reason,
    }
  }
  cacheKey = src
  cacheMode = mock
  cacheView = view
  return view
}

function subscribe(fn: () => void) {
  subs.add(fn)
  const off = subscribeSession(() => fn())
  return () => { subs.delete(fn); off() }
}

export const useSession = (): SessionView => useSyncExternalStore(subscribe, getSessionView, getSessionView)

/** permission_paths 判断（只影响显示）。演示数据模式一律 true */
export const can = (route: string) => isMockMode() || canRoute(route)

/** 退出登录：真实接口调 /auth/invalidate 并清令牌；演示数据清 hjc-auth */
export function logout() {
  if (!isMockMode()) { void signOut(); return }
  clearMockAuth()
  mockAuth = null
  emit()
}

/** 真实接口模式：接上会话（过期通知、跨标签页同步），用已存令牌恢复登录态。AppProvider 调一次 */
export function useSessionBoot() {
  useEffect(() => {
    purgeLegacyTokens() // 旧版本存在 localStorage 的令牌一律作废（演示数据模式也清，不留在磁盘上）
    if (isMockMode()) return
    clearMockAuth() // 旧的 hjc-auth（可伪造）废弃
    const unwire = initSession()
    booted = true
    void restoreSession()
    return unwire
  }, [])
}

/** 仅供测试：重置模块内状态 */
export function __resetSessionViewForTests() {
  mockAuth = undefined
  booted = false
  mayRestore = undefined
  cacheView = undefined
  cacheKey = undefined
  cacheMode = undefined
  subs.clear()
}
