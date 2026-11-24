import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleXmark, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Button } from '@/components/ui/button'
import * as api from '../api'
import type { Project, Role, Scope, User } from '../api'

type Toast = { id: number; text: string; err?: boolean }
type Confirm = { title: string; body: ReactNode; okText?: string; danger?: boolean; resolve: (v: boolean) => void }
type Auth = { username: string; role: Role }

interface Ctx {
  authed: boolean
  user: User
  scope: Scope
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth | null>(readAuth)
  const [storedPid, setStoredPid] = useState(() => localStorage.getItem('hjc-project') || '')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dlg, setDlg] = useState<Confirm | null>(null)
  const [selectTick, setTick] = useState(0)

  const user = useMemo(() => api.profile(auth?.username ?? 'cosyhome'), [auth])
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

  const setProjectId = useCallback((id: string) => {
    setStoredPid(id)
    localStorage.setItem('hjc-project', id)
    api.reportProjectSelect(user, id).then(() => setTick((t) => t + 1))
  }, [user])

  const value: Ctx = {
    authed: !!auth,
    user, scope,
    login: (a, remember) => { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(a)); setAuth(a) },
    logout: () => { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); setAuth(null) },
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
