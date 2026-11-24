// 展示层反馈（toast、confirm 弹窗）留在这里（S3a 会换成 Sonner / AlertDialog）。
// 数据状态已拆到独立模块（S6a）：
//   登录态        src/data/session.ts   useSession() / mockSignIn() / logout() / can()
//   组织数据      src/data/org          useOrgScope() / useDealers() / useIntegratedProjects() / useProjects()
//   当前项目      src/data/org          useCurrentProject()（hjc-project 持久化）
// useApp() 保留为兼容门面，把上面几块拼成拆分前的形状，现有页面不用改；新代码直接用对应的 hook。
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleXmark, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Button } from '@/components/ui/button'
import type { Project, Role, Scope, User } from '../api'
import type { ApiError } from '../api/errors'
import type { SessionInfo } from '../api/session'
import { can, logout, mockSignIn, useSession, useSessionBoot } from '../data/session'
import { useCurrentProject, useOrgScope, useResetOnAccountChange, type LoadStatus, type SetProjectResult } from '../data/org'

type Toast = { id: number; text: string; err?: boolean }
type Confirm = { title: string; body: ReactNode; okText?: string; danger?: boolean; resolve: (v: boolean) => void }
type Auth = { username: string; role: Role }

interface Feedback {
  toast: (text: string, err?: boolean) => void
  confirm: (o: Omit<Confirm, 'resolve'>) => Promise<boolean>
}

interface Ctx extends Feedback {
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
    confirm: fb.confirm,
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dlg, setDlg] = useState<Confirm | null>(null)

  const toast = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, err }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])
  const confirm = useCallback((o: Omit<Confirm, 'resolve'>) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), [])
  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null) }

  // 真实接口模式：接上会话并恢复登录态；退出或换账号时清掉上一个账号的组织数据缓存
  useSessionBoot()
  useResetOnAccountChange()
  const sess = useSession()
  const prevAuthed = useRef(sess.authed)
  useEffect(() => {
    // 已登录 → 被动变成未登录（续期失败、令牌失效）时提示一次；主动退出不带 reason
    if (prevAuthed.current && !sess.authed && !sess.authLoading && sess.reason?.kind === 'unauthenticated') toast('登录已过期，请重新登录', true)
    prevAuthed.current = sess.authed
  }, [sess, toast])

  // 每次渲染给新对象：与拆分前一致，toast / 弹窗变化时 useApp() 的使用方照旧跟着重渲染（S3a 换 Sonner 时再收紧）
  const value: Feedback = { toast, confirm }

  return (
    <C.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast' + (t.err ? ' err' : '')}>
            <FontAwesomeIcon className="ti" icon={t.err ? faCircleXmark : faCircleCheck} />
            {t.text}
          </div>
        ))}
      </div>
      {dlg && (
        <div className="mask" onClick={() => close(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3><FontAwesomeIcon icon={faTriangleExclamation} style={{ color: dlg.danger ? 'var(--red)' : 'var(--amber)' }} />{dlg.title}</h3>
            <div className="body">{dlg.body}</div>
            <div className="foot">
              <Button onClick={() => close(false)}>取消</Button>
              <Button variant="primary" onClick={() => close(true)}>{dlg.okText ?? '确认'}</Button>
            </div>
          </div>
        </div>
      )}
    </C.Provider>
  )
}
