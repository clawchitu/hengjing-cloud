import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleXmark, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { projects } from '../mock/data'
import * as api from '../api'

type Toast = { id: number; text: string; err?: boolean }
type Confirm = { title: string; body: ReactNode; okText?: string; danger?: boolean; resolve: (v: boolean) => void }

interface Ctx {
  authed: boolean
  login: (u: string, remember: boolean) => void
  logout: () => void
  projectId: string
  setProjectId: (id: string) => void
  project: (typeof projects)[number]
  toast: (text: string, err?: boolean) => void
  confirm: (o: Omit<Confirm, 'resolve'>) => Promise<boolean>
  alarmBadge: number
  currentUnprocessed: number
  refreshAlarms: () => void
}

const C = createContext<Ctx>(null as unknown as Ctx)
export const useApp = () => useContext(C)

const KEY = 'hjc-auth'
export function AppProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(() => !!(localStorage.getItem(KEY) || sessionStorage.getItem(KEY)))
  const [projectId, setProjectId] = useState(() => localStorage.getItem('hjc-project') || 'PRJ-10241')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dlg, setDlg] = useState<Confirm | null>(null)
  const [alarmBadge, setBadge] = useState(api.unprocessedAll())
  const [currentUnprocessed, setCur] = useState(api.unprocessedCurrent())

  useEffect(() => { localStorage.setItem('hjc-project', projectId) }, [projectId])

  const toast = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, err }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])
  const confirm = useCallback((o: Omit<Confirm, 'resolve'>) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), [])
  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null) }

  const value: Ctx = {
    authed,
    login: (u, remember) => { (remember ? localStorage : sessionStorage).setItem(KEY, u); setAuthed(true) },
    logout: () => { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); setAuthed(false) },
    projectId, setProjectId,
    project: projects.find((p) => p.id === projectId) ?? projects[0],
    toast, confirm,
    alarmBadge, currentUnprocessed,
    refreshAlarms: () => { setBadge(api.unprocessedAll()); setCur(api.unprocessedCurrent()) },
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
              <button className="btn" onClick={() => close(false)}>取消</button>
              <button className="btn primary" onClick={() => close(true)}>{dlg.okText ?? '确认'}</button>
            </div>
          </div>
        </div>
      )}
    </C.Provider>
  )
}
