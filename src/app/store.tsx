// 展示层反馈（toast、confirm）的入口留在这里；状态与约定在 app/feedback.ts，界面在 components/ConfirmHost.tsx 与 ui/sonner.tsx，本文件不含弹层 JSX。
// 数据状态已拆到独立模块（S6a）：
//   登录态        src/data/session.ts   useSession() / mockSignIn() / logout() / can()
//   组织数据      src/data/org          useOrgScope() / useDealers() / useIntegratedProjects() / useProjects()
//   当前项目      src/data/org          useCurrentProject()（hjc-project 持久化）
// useApp() 保留为兼容门面，把上面几块拼成拆分前的形状，现有页面不用改；新代码直接用对应的 hook。
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConfirmHost } from '@/components/ConfirmHost'
import { Toaster } from '@/components/ui/sonner'
import { ConfirmControllerContext as Ctl, createConfirmController, routeScope, showToast, useConfirm, type ConfirmOptions, type ExpireReason } from './feedback'
import type { Project, Role, Scope, User } from '../api'
import type { ApiError } from '../api/errors'
import type { SessionInfo } from '../api/session'
import { can, getSessionView, logout, mockSignIn, useSession, useSessionBoot } from '../data/session'
import { useCurrentProject, useOrgScope, useResetOnAccountChange, type LoadStatus, type SetProjectResult } from '../data/org'
import { getStoredProjectId } from '../data/org/current'
import { useQueryClient } from '@tanstack/react-query'
import { registerAllVerifiers } from './writeLockSetup'

type Auth = { username: string; role: Role }

interface Feedback {
  toast: (text: string, err?: boolean) => void
}

interface Ctx extends Feedback {
  /**
   * 确认弹窗，签名同拆分前（(o) => Promise<boolean>）。内部就是 app/feedback 的 useConfirm()：请求绑定到调用 useApp() 的这个组件实例，
   * 与直接用 useConfirm() 同等保护（组件卸载、路由 / 会话 / 当前项目变化时同步失效，按 false 结算）。两个入口都可以用（docs/分工.md 第 3 节第 7 条）
   */
  confirm: (o: ConfirmOptions) => Promise<boolean>
  authed: boolean
  /** 真实接口模式：正在用已存的令牌取 /me 恢复登录态，路由守卫等它结束再决定是否跳登录页 */
  authLoading: boolean
  /** 真实接口模式的 /me 结果（只在内存里）；演示数据模式为 null */
  session: SessionInfo | null
  /** permission_paths 判断（只影响显示）。演示数据模式一律 true */
  can: (route: string) => boolean
  user: User
  scope: Scope
  /** 组织数据（集成项目 + 项目列表）的加载状态；main.tsx 的 OrgGate 在 success 且有项目之前不渲染 Layout */
  orgStatus: LoadStatus
  orgError: ApiError | null
  orgRefetch: () => void
  /** 演示数据模式的登录（Worker 校验演示账号）；真实接口模式由登录页调 session.signIn() */
  login: (a: Auth, remember: boolean) => void
  logout: () => void
  projectId: string
  /** make a project the 当前项目 and report the select event to the backend */
  /** 返回是否成功（见 useCurrentProject）；调用方用 whenProjectSet() 只在成功时跳转 / 提示 */
  setProjectId: (id: string) => SetProjectResult
  /**
   * 当前项目。OrgGate 保证 Layout 及页面渲染时一定有可见项目，这里不会是占位；
   * 只有 Layout 之外（登录页等）才会拿到 id 为 '' 的占位。新代码（S8–S12）用 useCurrentProject() 并判空，写入口前也判空
   */
  project: Project
  /** bumps whenever a select event was reported (常用项目 refresh) */
  selectTick: number
}

const C = createContext<Feedback>(null as unknown as Feedback)

const EXPIRE_TEXT: Record<ExpireReason, string> = {
  route: '路由已变化',
  session: '登录状态已变化',
  'owner-unmounted': '发起它的页面已卸载',
  'project-changed': '当前项目已变化',
}

/** 没有可见项目时的占位，保证旧页面拿到的 project 不为空 */
const NO_PROJECT: Project = Object.freeze({
  id: '', code: '', name: '', groupId: '', city: '', district: '', kind: '', online: false, version: '', devices: 0, programCode: 0,
}) as Project

/** 兼容门面：拆分前 AppProvider 提供的全部字段 */
export function useApp(): Ctx {
  const fb = useContext(C)
  const s = useSession()
  const scope = useOrgScope()
  const cur = useCurrentProject()
  const confirm = useConfirm()
  const project = cur.project ?? NO_PROJECT
  return {
    authed: s.authed,
    authLoading: s.authLoading,
    session: s.session,
    can,
    user: s.user,
    scope: scope.data,
    orgStatus: scope.status,
    orgError: scope.error,
    orgRefetch: scope.refetch,
    login: mockSignIn,
    logout,
    projectId: project.id,
    setProjectId: cur.setProjectId,
    project,
    selectTick: cur.selectTick,
    toast: fb.toast,
    confirm,
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  // 请求所属上下文：路由 + 会话（登录态、账号），见 app/feedback.ts「离开即失效」
  const [ctl] = useState(() => createConfirmController(
    () => {
      const v = getSessionView()
      // project：外部存储里的当前项目 id（setProjectId 先同步写它，React 之后才提交），接受确认时与发起时比较
      return { route: routeScope(), session: v.authed ? v.userKey ?? '' : '-', project: getStoredProjectId() }
    },
    // 失效判为 false 时不静默：留一行原因便于排查，并提示用户（会话变化时登出 / 过期已有各自的提示，不再叠加）
    ({ title, reason, how }) => {
      console.info(`[确认弹窗] 「${title}」已失效（${EXPIRE_TEXT[reason]}），${how === 'clicked' ? '点击确认时' : '已自动关闭，'}按取消处理`)
      if (reason !== 'session') showToast('页面已变化，操作已取消', true)
    },
  ))
  useEffect(() => ctl.trackInput(document), [ctl])
  // Provider 卸载：未结算的确认按 false 结算，不悬空；layout 清理先于子组件（所有者）的清理执行，整棵树卸载时不提示「页面已变化」
  useLayoutEffect(() => { ctl.setActive(true); return () => ctl.setActive(false) }, [ctl])
  useEffect(() => () => ctl.cancel(), [ctl])

  // 真实接口模式：接上会话并恢复登录态；退出或换账号时清掉上一个账号的组织数据缓存
  useSessionBoot()
  useResetOnAccountChange()
  // 写锁（#28）：应用初始化时注入 resolveProject（S6a 组织范围的同步查询）；核对器统一在 writeLockSetup 注册。同一个 QueryClient 只接一次
  const qc = useQueryClient()
  useState(() => { registerAllVerifiers(qc); return null })
  const sess = useSession()
  const prevAuthed = useRef(sess.authed)
  useEffect(() => {
    // 已登录 → 被动变成未登录（续期失败、令牌失效）时提示一次；主动退出不带 reason
    if (prevAuthed.current && !sess.authed && !sess.authLoading && sess.reason?.kind === 'unauthenticated') showToast('登录已过期，请重新登录', true)
    // 登出、会话失效、换账号后不能留着确认弹窗（只关所属会话已过期的请求）
    ctl.cancelStale()
    prevAuthed.current = sess.authed
  }, [sess, ctl])

  // toast 是稳定引用：队列在 Sonner 里；确认弹窗的状态在 controller 里，弹窗开关不让 useApp() 的使用方跟着重渲染
  const value: Feedback = useMemo(() => ({ toast: showToast }), [])

  return (
    <Ctl.Provider value={ctl}>
      <C.Provider value={value}>
        {children}
        <Toaster />
        <ConfirmHost controller={ctl} />
      </C.Provider>
    </Ctl.Provider>
  )
}
