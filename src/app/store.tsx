import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleXmark, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Button } from '@/components/ui/button'
import * as api from '../api'
import type { Project, Role, Scope, User } from '../api'
import { isMockMode } from '../api/config'
import { can as canRoute, getSession, initSession, restoreSession, signOut, subscribeSession, type SessionInfo, type SessionState } from '../api/session'
import { readTokens } from '../api/tokens'

type Toast = { id: number; text: string; err?: boolean }
type Confirm = { title: string; body: ReactNode; okText?: string; danger?: boolean; resolve: (v: boolean) => void }
type Auth = { username: string; role: Role }

interface Ctx {
  authed: boolean
  /** 真实接口模式：正在用已存的令牌取 /me 恢复登录态，路由守卫等它结束再决定是否跳登录页 */
  authLoading: boolean
  /** 真实接口模式的 /me 结果（只在内存里）；演示数据模式为 null */
  session: SessionInfo | null
  /** permission_paths 判断（只影响显示）。演示数据模式一律 true */
  can: (route: string) => boolean
  user: User
  scope: Scope
  /** 演示数据模式的登录（Worker 校验演示账号）；真实接口模式由登录页调 session.signIn() */
  login: (a: Auth, remember: boolean) => void
  logout: () => void
  projectId: string
  /** make a project the 当前项目 and report the select event to the backend */
  setProjectId: (id: string) => void
  project: Project
  toast: (text: string, err?: boolean) => void
  confirm: (o: Omit<Confirm, 'resolve'>) => Promise<boolean>
  /** bumps whenever a select event was reported (常用项目 refresh) */
  selectTick: number
}

const C = createContext<Ctx>(null as unknown as Ctx)
export const useApp = () => useContext(C)

const KEY = 'hjc-auth'
function readAuth(): Auth | null {
  const raw = localStorage.getItem(KEY) || sessionStorage.getItem(KEY)
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as Auth
    return a && typeof a.username === 'string' && (a.role === 'dealer' || a.role === 'admin') ? a : null
  } catch { return null }
}

/**
 * 真实接口模式下页面用的 User。S6 之前项目、经销商仍是演示数据，所以按身份借用对应演示账号的
 * 数据范围（经销商 → cosyhome，平台 → hjadmin），名字、手机号、身份取自 /me。
 */
function userOf(info: SessionInfo): User {
  const base = api.profile(info.dealer ? 'cosyhome' : 'hjadmin')
  const role: Role = info.dealer ? 'dealer' : 'admin'
  return {
    ...base,
    username: info.user.mobile || info.user.id,
    name: info.user.name || info.user.mobile || base.name,
    org: '恒境云平台',
    role,
    roleLabel: info.dealer ? '经销商' : '管理员',
  }
}

const mock = isMockMode()

export function AppProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth | null>(() => (mock ? readAuth() : null))
  // 有令牌就先进入 loading，避免首屏在恢复完成前被守卫踢到登录页
  const [sess, setSess] = useState<SessionState>(() => (!mock && readTokens() ? { status: 'loading', info: null } : getSession()))
  const [storedPid, setStoredPid] = useState(() => localStorage.getItem('hjc-project') || '')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dlg, setDlg] = useState<Confirm | null>(null)
  const [selectTick, setTick] = useState(0)

  const info = mock ? null : sess.info
  const user = useMemo(() => (info ? userOf(info) : api.profile(auth?.username ?? 'cosyhome')), [auth, info])
  const scope = useMemo(() => api.scopeOf(user), [user])
  // stale / foreign project id (e.g. after switching account) → first visible project
  const project = scope.projects.find((p) => p.id === storedPid) ?? scope.projects[0]

  const toast = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, err }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])
  const confirm = useCallback((o: Omit<Confirm, 'resolve'>) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), [])
  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null) }

  // 真实接口模式：接上会话（过期通知、跨标签页同步），用已存令牌恢复登录态
  const prevStatus = useRef(sess.status)
  useEffect(() => {
    if (mock) return
    localStorage.removeItem(KEY); sessionStorage.removeItem(KEY) // 旧的 hjc-auth（可伪造）废弃
    const unwire = initSession()
    const unsub = subscribeSession(setSess)
    void restoreSession()
    return () => { unsub(); unwire() }
  }, [])
  useEffect(() => {
    // 已登录 → 被动变成未登录（续期失败、令牌失效）时提示一次；主动退出不带 reason
    if (prevStatus.current === 'authed' && sess.status === 'anon' && sess.reason?.kind === 'unauthenticated') toast('登录已过期，请重新登录', true)
    prevStatus.current = sess.status
  }, [sess, toast])

  const setProjectId = useCallback((id: string) => {
    setStoredPid(id)
    localStorage.setItem('hjc-project', id)
    api.reportProjectSelect(user, id).then(() => setTick((t) => t + 1))
  }, [user])

  const value: Ctx = {
    authed: mock ? !!auth : sess.status === 'authed',
    authLoading: !mock && sess.status === 'loading',
    session: info,
    can: (route) => mock || canRoute(route),
    user, scope,
    login: (a, remember) => { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(a)); setAuth(a) },
    logout: () => {
      if (!mock) { void signOut(); return }
      localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); setAuth(null)
    },
    projectId: project.id, setProjectId,
    project,
    toast, confirm, selectTick,
  }

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
