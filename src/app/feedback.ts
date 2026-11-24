// 展示层反馈的状态（不含界面）：轻提示转调 Sonner；确认弹窗的请求队列、结算与焦点约定。
// 界面在 components/ConfirmHost.tsx（AlertDialog）与 components/ui/sonner.tsx（Toaster），由 store.tsx 的 AppProvider 挂载。
import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useCurrentProject } from '../data/org'
import type { ReactNode } from 'react'
import { toast as sonner } from 'sonner'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleXmark } from '@fortawesome/free-solid-svg-icons'

/** 轻提示：签名同旧版（text, err），成功 / 失败图标与颜色同旧版 .toast .ti；dismissible: false —— 不支持滑动关闭（旧版没有） */
export function showToast(text: string, err?: boolean) {
  const icon = createElement(FontAwesomeIcon, { className: err ? 'text-destructive' : 'text-green-2', icon: err ? faCircleXmark : faCircleCheck })
  if (err) sonner.error(text, { icon, dismissible: false })
  else sonner.success(text, { icon, dismissible: false })
}

export type ConfirmOptions = { title: string; body: ReactNode; okText?: string; danger?: boolean }
/**
 * 一次确认请求。id 是请求的身份：界面上的按钮 / Esc 只结算自己渲染出来的那一次（id 不是当前请求就忽略）。
 * trigger = 发起时的焦点元素（关闭后焦点回到这里），keyboard = 发起它的是不是键盘
 */
/**
 * 请求所属上下文（都要能同步读取）：route = 路由（history key + pathname），session = 登录态与账号，
 * project = 外部存储里的当前项目 id（data/org/current 的 getStoredProjectId；setProjectId 先同步写它，React 之后才提交）
 */
export type ConfirmScope = { route: string; session: string; project?: string }
export type ConfirmRequest = ConfirmOptions & { id: number; trigger: HTMLElement | null; keyboard: boolean; scope: ConfirmScope }
/** 请求失效的原因 */
export type ExpireReason = 'route' | 'session' | 'owner-unmounted' | 'project-changed'
/** 失效时的通知：how = clicked（用户点了「确认」但已失效，按取消处理）/ closed（弹窗被自动关闭） */
export type OnExpired = (info: { title: string; reason: ExpireReason; how: 'clicked' | 'closed' }) => void
/**
 * 确认请求的所有者：发起它的那个组件实例（useConfirm() 里一个实例一份）。alive 在实例卸载时由 layout effect 清理同步置 false
 * （与 DOM 移除在同一个提交里同步执行，中间插不进浏览器事件）；projectId 是该实例当前看到的当前项目，也在提交时同步更新
 */
export type ConfirmOwner = { alive: boolean; projectId: string }
/** open：是否有未结算的请求；req：最近一次请求（关闭后保留，Radix 卸载前还会以关闭态渲染一次，内容不能变空） */
export type ConfirmState = { open: boolean; req: ConfirmRequest | null }

const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta']

/*
 * 确认请求的约定（S9 / S10 / S12 的下发都靠 confirm() 的结果）：
 * - 每次 confirm() 一个新身份；同一身份只结算一次；
 * - 打开中再次调用：前一个按 false 结算（不悬空），弹窗换成新内容；
 * - 离开即失效：每个请求记下发起时的“所属上下文”（scope：当前路由的 history key 与 pathname、登录态与账号）。
 *   ① 接受「确认」的那一刻同步核对 scope：路由或会话已经变了（浏览器后退、登出已发生，而 React 还没来得及渲染 / 跑 effect 清理），
 *      就按 false 结算并关闭 —— 不依赖 effect 时序，已离开页面的后续代码（下发）不会因为一次迟到的「确认」而执行；
 *   ② 路由 / 会话变化后的 effect（Layout 的 useCancelConfirmOnLeave、AppProvider 的会话 effect）调用 cancelStale()，只关闭 scope
 *      已经过期的请求：旧路由的延迟清理不会误取消新路由刚发起的确认；
 *   ③ AppProvider 卸载时 cancel() 无条件按 false 结算（不通知）；
 *   因①②④判为 false 时调用 onExpired（AppProvider 里：console.info 一行原因，并提示「页面已变化，操作已取消」；会话变化时不提示，
 *   登出 / 过期已有各自的提示），避免“点了确认却没反应”；
 *   ④ 所有者（useConfirm()）：发起确认的组件实例卸载（如当前项目变离线，Layout 换成离线分支卸载页面；或当前项目变化，
 *      key={project.id} 的页面重挂）时，在 layout effect 清理里同步按 false 结算并关闭；接受「确认」时还要核对所有者仍存活、
 *      且它当前看到的项目 id 与发起时一致。URL 和账号都不变的“页面已不是那个页面”由这一条兜住；
 *   ⑤ 当前项目：scope 里含外部存储的当前项目 id，接受「确认」时同步比较 —— 项目已切换（setProjectId 已写入存储）、
 *      React 还没提交（所有者的 projectId 还没更新）时点旧确认也是 false。存储值从空（回退到第一个项目）变成同一个项目的 id
 *      也算变化、按取消处理（偏保守；弹窗是模态的，打开期间界面上切不了项目）；
 * - 路由 scope 的边界：React Router 的导航（含同路径只改 query / hash）都会生成新的 history key，因此都会让确认失效（按“历史条目
 *   变化即离开”处理）；脚本直接 history.replaceState 且保留 key 与 pathname（只改 query / hash）时检测不到，本项目没有这种写法；
 * - 触发器：发起时的焦点元素。弹窗开着时再次调用（焦点在弹窗里）沿用当前请求的触发器；连续确认时沿用上一个请求的触发器：
 *   上一个刚结算、焦点还留在它的按钮上，或者中间隔了一次异步、按钮已卸载而焦点还没还给触发器（焦点在 body、还给触发器的那一步还没执行），
 *   都算连续确认，避免关闭后焦点落到 body；
 * - 打开方式（决定「取消」上要不要外圈）：发起前最后一次用户输入是按键还是指针按下（document 捕获阶段记录，单按修饰键不算）。
 *   不用触发器的 :focus-visible 判断：键盘聚焦过的按钮再用鼠标点，它仍命中 :focus-visible。还没有任何输入（脚本直接调用）按指针处理。
 */
export function createConfirmController(getScope: () => ConfirmScope = () => ({ route: '', session: '' }), onExpired: OnExpired = () => {}) {
  let seq = 0
  let current: (ConfirmRequest & { resolve: (v: boolean) => void; owner: ConfirmOwner | null; projectId: string }) | null = null
  /** 当前请求是否仍有效：所属路由 / 会话未变，且所有者（若有）仍存活、看到的项目未变 */
  /** 当前请求失效的原因；仍有效（或没有请求）时为 null */
  const expired = (): ExpireReason | null => {
    if (!current) return null
    const now = getScope()
    if (current.scope.session !== now.session) return 'session'
    if (current.scope.route !== now.route) return 'route'
    if ((current.scope.project ?? '') !== (now.project ?? '')) return 'project-changed'
    if (current.owner && !current.owner.alive) return 'owner-unmounted'
    if (current.owner && current.owner.projectId !== current.projectId) return 'project-changed'
    return null
  }
  let active = true
  const expire = (reason: ExpireReason, how: 'clicked' | 'closed', keyboard: boolean) => {
    const title = current!.title
    finish(keyboard, false)
    if (active) onExpired({ title, reason, how })
  }
  let lastTrigger: HTMLElement | null = null
  let lastInput: 'pointer' | 'keyboard' | null = null
  let closing: { trigger: HTMLElement | null; keyboard: boolean } | null = null
  let state: ConfirmState = { open: false, req: null }
  const listeners = new Set<() => void>()
  const emit = (s: ConfirmState) => { state = s; listeners.forEach((l) => l()) }

  function finish(keyboard: boolean, v: boolean) {
    const d = current!
    current = null
    lastTrigger = d.trigger
    closing = { trigger: d.trigger, keyboard }
    d.resolve(v)
    emit({ open: false, req: state.req })
  }

  return {
    /** owner：发起它的组件实例（useConfirm() 传入；页面只能经 useConfirm() 发起，不带所有者只用于控制器自身的测试） */
    request(o: ConfirmOptions, owner: ConfirmOwner | null = null): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const prev = current
        const el = document.activeElement
        const active = el instanceof HTMLElement && el !== document.body ? el : null
        const inDialog = !!active?.closest('[data-slot="alert-dialog-content"]')
        // closing 不为空 = 上一个弹窗的焦点还没还给触发器
        const chained = inDialog || (!active && closing !== null)
        const trigger = prev ? prev.trigger : chained ? lastTrigger : active
        if (!prev && chained) closing = null // 焦点改由新请求关闭时归还，上一个的归还作废
        const keyboard = prev ? prev.keyboard : lastInput === 'keyboard'
        const req = { ...o, id: ++seq, trigger, keyboard, scope: getScope() }
        current = { ...req, resolve, owner, projectId: owner?.projectId ?? '' }
        prev?.resolve(false)
        emit({ open: true, req })
      })
    },
    /**
     * 界面结算：只认当前请求的身份；接受「确认」时同步核对所属上下文，已过期就按 false 结算。
     * keyboard = 这次关闭是不是键盘操作（决定触发器上要不要外圈）
     */
    settle(id: number, v: boolean, keyboard: boolean) {
      if (current?.id !== id) return
      const reason = v ? expired() : null
      if (reason) expire(reason, 'clicked', keyboard)
      else finish(keyboard, v)
    },
    /** 路由 / 会话变化后：只关闭所属上下文已过期的请求（按 false 结算） */
    cancelStale() {
      const reason = expired()
      if (reason) expire(reason, 'closed', false)
    },
    /** 所有者卸载：它发起的未结算请求按 false 结算（别的实例发起的不动） */
    cancelOwner(owner: ConfirmOwner) {
      if (!current || current.owner !== owner) return
      const title = current.title
      // 原因优先取上下文：会话失效时页面卸载先于会话 effect，这里要记成 session（不提示「页面已变化」，登录过期另有提示）
      const reason = expired() ?? 'owner-unmounted'
      finish(false, false)
      // 通知放到微任务里：StrictMode 开发模式下的“模拟卸载 → 重新挂载”在同一次提交里同步完成，届时所有者已恢复存活，不提示
      queueMicrotask(() => { if (!owner.alive && active) onExpired({ title, reason, how: 'closed' }) })
    },
    /** AppProvider 卸载：当前未结算的请求无条件按 false 结算 */
    cancel() {
      if (current) finish(false, false)
    },
    /**
     * AppProvider 的 layout effect 调用：卸载时（先于子组件的清理执行）置为不活动并静默结算，
     * 随后子组件（所有者）的卸载清理不再提示「页面已变化」；StrictMode 重新执行时恢复
     */
    setActive(v: boolean) {
      active = v
      if (!v && current) finish(false, false)
    },
    /** 取出“刚结算的那次”应该把焦点还给谁（只取一次） */
    takeClosing() {
      const c = closing
      closing = null
      return c
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    getState: () => state,
    /** 记录最后一次用户输入方式；返回清理函数 */
    trackInput(doc: Document) {
      const onPointer = () => { lastInput = 'pointer' }
      const onKey = (e: KeyboardEvent) => { if (!MODIFIER_KEYS.includes(e.key)) lastInput = 'keyboard' }
      doc.addEventListener('pointerdown', onPointer, true)
      doc.addEventListener('keydown', onKey, true)
      return () => { doc.removeEventListener('pointerdown', onPointer, true); doc.removeEventListener('keydown', onKey, true) }
    },
  }
}
export type ConfirmController = ReturnType<typeof createConfirmController>
/**
 * 请求所属上下文的同步读取：当前路由（BrowserRouter 把 key 存在 history.state 里，后退时浏览器先于 React 更新它）+ pathname，
 * 以及会话（是否登录、哪个账号）。由 AppProvider 传给 createConfirmController
 */
export function routeScope() {
  const st = window.history.state as { key?: string } | null
  return `${st?.key ?? 'default'}|${window.location.pathname}`
}

/** AppProvider 提供；Router 里的桥接（useCancelConfirmOnLeave）通过它结算 */
export const ConfirmControllerContext = createContext<ConfirmController | null>(null)

/**
 * 确认弹窗随“离开”失效：放在 Router 里面的组件调用（Layout）。路由变化（含浏览器后退 / 前进、hash 变化）或调用方卸载后，
 * 所属路由已过期的确认按 false 结算并关闭（cancelStale：只看请求自己的 scope，不会取消新路由刚发起的确认）。
 * 这一步只负责关闭弹窗；结果的正确性由 settle() 接受确认时的同步核对保证。AppProvider 在 BrowserRouter 外，看不到路由，所以由 Router 里的组件桥接（main.tsx 不改）。
 * 会话过期跳登录页：Guard 把 Layout 换成登录页，Layout 卸载即结算；另外 AppProvider 在登录态变为未登录时也会结算
 */
export function useCancelConfirmOnLeave() {
  const ctl = useContext(ConfirmControllerContext)
  const { key, pathname } = useLocation()
  useEffect(() => () => ctl?.cancelStale(), [ctl, key, pathname])
}


let focusVisibleSupported: boolean | undefined
/** 浏览器是否支持 focus({ focusVisible })：读到这个选项说明支持（WebIDL 转换字典时一定会读，与元素能否聚焦无关） */
export function supportsFocusVisible() {
  if (focusVisibleSupported === undefined) {
    focusVisibleSupported = false
    try {
      document.createElement('button').focus({ get focusVisible() { focusVisibleSupported = true; return false } })
    } catch { /* 不支持时按 false */ }
  }
  return focusVisibleSupported
}

/**
 * 脚本聚焦并指定是否显示键盘外圈。支持 focusVisible 的浏览器直接用它；不支持时（浏览器会自己猜）在元素上打
 * data-focus-ring="on|off"，由 tailwind.css 里的全局规则强制显示 / 隐藏外圈；失焦清除，off 时按非修饰键也清除（键盘接管）
 */
export function focusWithRing(el: HTMLElement, ring: boolean) {
  if (supportsFocusVisible()) return el.focus({ preventScroll: true, focusVisible: ring })
  el.setAttribute('data-focus-ring', ring ? 'on' : 'off')
  const clear = () => { el.removeAttribute('data-focus-ring'); el.removeEventListener('blur', clear); el.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (!MODIFIER_KEYS.includes(e.key) && el.getAttribute('data-focus-ring') === 'off') clear() }
  el.addEventListener('blur', clear)
  el.addEventListener('keydown', onKey)
  el.focus({ preventScroll: true })
}

/**
 * 页面里发起确认用这个（代替 useApp().confirm，签名相同）：请求绑定到调用它的组件实例。实例卸载时同步失效并关闭弹窗；
 * 接受「确认」时核对实例仍存活、当前项目没变（见 createConfirmController 的「离开即失效」④）
 */
export function useConfirm(): (o: ConfirmOptions) => Promise<boolean> {
  const ctl = useContext(ConfirmControllerContext)
  const { project } = useCurrentProject()
  const projectId = project?.id ?? ''
  const owner = useRef<ConfirmOwner>({ alive: true, projectId })
  // 当前项目变化：同步记下，并关掉这个实例发起、因此过期的请求（页面若按项目重挂，下面的卸载清理也会处理）
  useLayoutEffect(() => { owner.current.projectId = projectId; ctl?.cancelStale() }, [projectId, ctl])
  useLayoutEffect(() => {
    const o = owner.current
    o.alive = true // StrictMode 下会先清理再重新执行
    return () => { o.alive = false; ctl?.cancelOwner(o) }
  }, [ctl])
  return useCallback((o: ConfirmOptions) => ctl!.request(o, owner.current), [ctl])
}
