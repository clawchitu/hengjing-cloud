import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '@fontsource/noto-sans-sc/700.css'
import '@fontsource/barlow/400.css'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow/700.css'
import './styles/tailwind.css'
import './styles/global.css'
import './styles/pages.css'
import { AppProvider, useApp } from './app/store'
import { safeFrom } from './app/redirect'
import { OrgGate } from './app/OrgGate'
import { QueryProvider } from './api/QueryProvider'
import Layout from './components/Layout'
import Login from './pages/Login'
import Home from './pages/Home'
import Groups from './pages/Groups'
import Control from './pages/Control'
import Sensors from './pages/Sensors'
import Thermostat from './pages/Thermostat'
import FreshAir from './pages/FreshAir'
import Connections from './pages/Connections'
import type { ReactNode } from 'react'

/**
 * 路由守卫。未登录 → 登录页（记下原路径，登录后回去）；真实接口模式下正在用已存令牌恢复登录态时
 * 先不渲染，恢复完再决定。会话过期（续期失败、令牌失效）时 authed 变 false，同样跳回登录页。
 */
function Guard({ children }: { children: ReactNode }) {
  const { authed, authLoading } = useApp()
  const loc = useLocation()
  if (authLoading) return null
  return authed ? <>{children}</> : <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />
}

/**
 * 登录页。登录成功（authed 变 true）后由这里统一跳转：回到守卫记下的原路径，没有就回首页。
 * 不在登录页里另调 navigate：react-router 7 把地址变化放在 transition 里，两处跳转会互相覆盖。
 */
function LoginRoute() {
  const { authed, authLoading } = useApp()
  const loc = useLocation() as { state?: { from?: unknown } }
  if (authLoading) return null
  return authed ? <Navigate to={safeFrom(loc.state?.from) ?? '/home'} replace /> : <Login />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route element={<Guard><OrgGate><Layout /></OrgGate></Guard>}>
            <Route path="/home" element={<Home />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/control" element={<Control />} />
            <Route path="/sensors" element={<Sensors />} />
            <Route path="/thermostat" element={<Thermostat />} />
            <Route path="/fresh-air" element={<FreshAir />} />
            <Route path="/connections" element={<Connections />} />
          </Route>
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
    </QueryProvider>
  </StrictMode>,
)
