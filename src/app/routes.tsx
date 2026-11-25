// 路由守卫和登录页路由（从 main.tsx 挪出来，便于测试）。
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useApp } from './store'
import { afterLogin } from './redirect'
import { useSession } from '../data/session'
import Login from '../pages/Login'

/**
 * 最近一个进过受保护页面的账号（S13 走查 P7）：跳登录页时连同原路径一起记下，换了账号登录就不回原路径。
 * 存 localStorage：刷新页面后会话恢复失败再跳登录页时也知道原路径是谁留下的
 */
export const LAST_USER_KEY = 'hjc-last-user'
let lastUser: string | null = null // 存储不可用时的兜底（同一页面内仍有效）
const readLastUser = () => { try { return localStorage.getItem(LAST_USER_KEY) || lastUser } catch { return lastUser } }
const writeLastUser = (u: string) => { lastUser = u; try { if (localStorage.getItem(LAST_USER_KEY) !== u) localStorage.setItem(LAST_USER_KEY, u) } catch { /* 存储不可用：用内存里的 */ } }

/**
 * 路由守卫。未登录 → 登录页（记下原路径和当时的账号，登录后同一账号回去）；真实接口模式下正在用已存令牌恢复登录态时
 * 先不渲染，恢复完再决定。会话过期（续期失败、令牌失效）时 authed 变 false，同样跳回登录页。
 */
export function Guard({ children }: { children: ReactNode }) {
  const { authed, authLoading } = useApp()
  const { userKey } = useSession()
  const loc = useLocation()
  if (authLoading) return null
  if (authed) { if (userKey) writeLastUser(userKey); return <>{children}</> }
  return <Navigate to="/login" state={{ from: loc.pathname + loc.search, fromUser: readLastUser() }} replace />
}

/**
 * 登录页。登录成功（authed 变 true）后由这里统一跳转：回到守卫记下的原路径（换了账号或没有就回首页）。
 * 不在登录页里另调 navigate：react-router 7 把地址变化放在 transition 里，两处跳转会互相覆盖。
 */
export function LoginRoute() {
  const { authed, authLoading } = useApp()
  const { userKey } = useSession()
  const loc = useLocation() as { state?: { from?: unknown; fromUser?: unknown } }
  if (authLoading) return null
  return authed ? <Navigate to={afterLogin(loc.state, userKey)} replace /> : <Login />
}
