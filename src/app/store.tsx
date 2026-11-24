// 展示层反馈（toast、confirm 弹窗）留在这里：toast 走 Sonner（ui/sonner.tsx），confirm 走 AlertDialog（ui/alert-dialog.tsx）。
// 数据状态已拆到独立模块（S6a）：
//   登录态        src/data/session.ts   useSession() / mockSignIn() / logout() / can()
//   组织数据      src/data/org          useOrgScope() / useDealers() / useIntegratedProjects() / useProjects()
//   当前项目      src/data/org          useCurrentProject()（hjc-project 持久化）
// useApp() 保留为兼容门面，把上面几块拼成拆分前的形状，现有页面不用改；新代码直接用对应的 hook。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleXmark, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { toast as sonner } from 'sonner'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Toaster } from '@/components/ui/sonner'
import type { Project, Role, Scope, User } from '../api'
import type { ApiError } from '../api/errors'
import type { SessionInfo } from '../api/session'
import { can, logout, mockSignIn, useSession, useSessionBoot } from '../data/session'
import { useCurrentProject, useOrgScope, useResetOnAccountChange, type LoadStatus, type SetProjectResult } from '../data/org'

type ConfirmOptions = { title: string; body: ReactNode; okText?: string; danger?: boolean }
/** 一个打开中的确认弹窗：trigger = 调用 confirm() 时的焦点元素（关闭后焦点回到这里），keyboard = 打开它的是不是键盘 */
type Confirm = ConfirmOptions & { resolve: (v: boolean) => void; trigger: HTMLElement | null; keyboard: boolean }
type Auth = { username: string; role: Role }

interface Feedback {
  toast: (text: string, err?: boolean) => void
  confirm: (o: ConfirmOptions) => Promise<boolean>
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

const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta']

/** 轻提示：签名不变（text, err），内部转调 Sonner。成功 / 失败图标与颜色同旧版 .toast .ti */
function showToast(text: string, err?: boolean) {
  const icon = <FontAwesomeIcon className={err ? 'text-destructive' : 'text-green-2'} icon={err ? faCircleXmark : faCircleCheck} />
  // dismissible: false —— 不支持滑动关闭（旧版没有）
  if (err) sonner.error(text, { icon, dismissible: false })
  else sonner.success(text, { icon, dismissible: false })
}

/*
 * 确认弹窗的焦点（浏览器默认外圈只在 :focus-visible 时出现）。
 * 打开：Radix 默认把焦点给「取消」；关闭：焦点回到调用 confirm() 时的焦点元素（触发器）。两次都是脚本聚焦，
 * Chromium 会按之前有没有用过键盘决定是否命中 :focus-visible，于是鼠标操作也可能冒出外圈。这里两次都自己聚焦，
 * 用 focus({ focusVisible }) 明确指定（Chromium 159 支持）：
 * | 打开方式                     | 打开后「取消」外圈 | 关闭方式                         | 关闭后触发器外圈 |
 * | 鼠标点触发器                 | 无                 | 鼠标点「取消」/「确认」           | 无               |
 * | 键盘（Enter / 空格）         | 有                 | 鼠标点「取消」/「确认」           | 无               |
 * | 鼠标 / 键盘                  | —                  | 键盘在按钮上按 Enter / 空格       | 有               |
 * | 鼠标 / 键盘                  | —                  | Esc                               | 有               |
 * | 鼠标 / 键盘                  | —                  | 点遮罩                            | 不关闭           |
 * - 打开方式：看调用 confirm() 之前最后一次用户输入是指针按下还是按键（document 捕获阶段记录，单按修饰键不算）。
 *   不用触发器的 :focus-visible 判断：键盘聚焦过的按钮再用鼠标点，它仍命中 :focus-visible，会被误判成键盘；
 *   还没有任何输入（脚本直接调用）按指针处理；
 * - 关闭方式：按钮 click 的 detail > 0 是指针点击，0 是键盘激活；Esc 走 onOpenChange(false)；
 * - 触发器已卸载（如退出登录后跳转）就不聚焦；没有触发器（焦点原本在 body）时焦点留在 body，同旧版。
 * 并发：弹窗打开时再次调用 confirm()，前一个按「取消」结算（resolve(false)，不会悬空），换成新内容；触发器沿用前一个
 * （此时的焦点在弹窗里，弹窗关掉就不存在了）。同一弹窗只结算一次（连点「确认」不会 resolve 两次）。
 */
export function AppProvider({ children }: { children: ReactNode }) {
  const [dlg, setDlg] = useState<Confirm | null>(null)
  // 弹窗内容：关闭时不清空（Radix 卸载前还会以关闭态渲染一次，内容不能变空）
  const [shown, setShown] = useState<Confirm | null>(null)
  const cur = useRef<Confirm | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const closing = useRef<{ trigger: HTMLElement | null; keyboard: boolean } | null>(null)
  // 最后一次用户输入的方式（见上方焦点状态表）
  const lastInput = useRef<'pointer' | 'keyboard' | null>(null)
  useEffect(() => {
    const onPointer = () => { lastInput.current = 'pointer' }
    const onKey = (e: KeyboardEvent) => { if (!MODIFIER_KEYS.includes(e.key)) lastInput.current = 'keyboard' }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true) }
  }, [])

  const toast = useCallback((text: string, err?: boolean) => showToast(text, err), [])
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    const prev = cur.current
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const next: Confirm = { ...o, resolve, trigger: prev ? prev.trigger : active, keyboard: prev ? prev.keyboard : lastInput.current === 'keyboard' }
    cur.current = next
    prev?.resolve(false)
    setDlg(next)
    setShown(next)
  }), [])
  /** 结算当前弹窗；keyboard = 这次关闭是不是键盘操作（决定触发器上要不要外圈） */
  const settle = (v: boolean, keyboard: boolean) => {
    const d = cur.current
    if (!d) return
    cur.current = null
    closing.current = { trigger: d.trigger, keyboard }
    d.resolve(v)
    setDlg(null)
  }
  const onButton = (v: boolean) => (e: MouseEvent) => settle(v, e.detail === 0)

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

  // toast / confirm 都是稳定引用：toast 的队列在 Sonner 里、弹窗状态只在这里，弹窗开关不再让 useApp() 的使用方跟着重渲染
  const value: Feedback = useMemo(() => ({ toast, confirm }), [toast, confirm])

  return (
    <C.Provider value={value}>
      {children}
      <Toaster />
      <AlertDialog open={!!dlg} onOpenChange={(o) => { if (!o) settle(false, true) }}>
        {shown && (
          <AlertDialogContent
            onOpenAutoFocus={(e) => { e.preventDefault(); cancelRef.current?.focus({ preventScroll: true, focusVisible: shown.keyboard }) }}
            onCloseAutoFocus={(e) => {
              e.preventDefault()
              const c = closing.current
              closing.current = null
              if (c?.trigger?.isConnected) c.trigger.focus({ preventScroll: true, focusVisible: c.keyboard })
            }}
          >
            <AlertDialogTitle><FontAwesomeIcon icon={faTriangleExclamation} style={{ color: shown.danger ? 'var(--red)' : 'var(--amber)' }} />{shown.title}</AlertDialogTitle>
            <AlertDialogDescription>{shown.body}</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel asChild><Button ref={cancelRef} onClick={onButton(false)}>取消</Button></AlertDialogCancel>
              <AlertDialogAction asChild><Button variant="primary" onClick={onButton(true)}>{shown.okText ?? '确认'}</Button></AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </C.Provider>
  )
}
