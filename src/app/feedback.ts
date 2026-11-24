// 展示层反馈的状态（不含界面）：轻提示转调 Sonner；确认弹窗的请求队列、结算与焦点约定。
// 界面在 components/ConfirmHost.tsx（AlertDialog）与 components/ui/sonner.tsx（Toaster），由 store.tsx 的 AppProvider 挂载。
import { createContext, createElement, useContext, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
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
export type ConfirmRequest = ConfirmOptions & { id: number; trigger: HTMLElement | null; keyboard: boolean }
/** open：是否有未结算的请求；req：最近一次请求（关闭后保留，Radix 卸载前还会以关闭态渲染一次，内容不能变空） */
export type ConfirmState = { open: boolean; req: ConfirmRequest | null }

const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta']

/*
 * 确认请求的约定（S9 / S10 / S12 的下发都靠 confirm() 的结果）：
 * - 每次 confirm() 一个新身份；同一身份只结算一次；
 * - 打开中再次调用：前一个按 false 结算（不悬空），弹窗换成新内容；
 * - 离开即失效（cancel）：路由变化（含浏览器后退）、登录态变为未登录、AppProvider 卸载时，未结算的请求按 false 结算、弹窗关闭，
 *   已卸载页面的后续代码（下发）不会因为一次迟到的「确认」而执行；
 * - 触发器：发起时的焦点元素。弹窗开着时再次调用（焦点在弹窗里）沿用当前请求的触发器；上一个弹窗刚结算、焦点还留在它的按钮上时
 *   （连续确认）沿用上一个请求的触发器，避免关闭后焦点落到已卸载的按钮、进而落到 body；
 * - 打开方式（决定「取消」上要不要外圈）：发起前最后一次用户输入是按键还是指针按下（document 捕获阶段记录，单按修饰键不算）。
 *   不用触发器的 :focus-visible 判断：键盘聚焦过的按钮再用鼠标点，它仍命中 :focus-visible。还没有任何输入（脚本直接调用）按指针处理。
 */
export function createConfirmController() {
  let seq = 0
  let current: (ConfirmRequest & { resolve: (v: boolean) => void }) | null = null
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
    request(o: ConfirmOptions): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const prev = current
        const el = document.activeElement
        const active = el instanceof HTMLElement && el !== document.body ? el : null
        const inDialog = !!active?.closest('[data-slot="alert-dialog-content"]')
        const trigger = prev ? prev.trigger : inDialog ? lastTrigger : active
        const keyboard = prev ? prev.keyboard : lastInput === 'keyboard'
        const req = { ...o, id: ++seq, trigger, keyboard }
        current = { ...req, resolve }
        prev?.resolve(false)
        emit({ open: true, req })
      })
    },
    /** 界面结算：只认当前请求的身份；keyboard = 这次关闭是不是键盘操作（决定触发器上要不要外圈） */
    settle(id: number, v: boolean, keyboard: boolean) {
      if (current?.id === id) finish(keyboard, v)
    },
    /** 离开即失效：当前未结算的请求按 false 结算并关闭 */
    cancel() {
      if (current) finish(false, false)
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
/** AppProvider 提供；Router 里的桥接（useCancelConfirmOnLeave）通过它结算 */
export const ConfirmControllerContext = createContext<ConfirmController | null>(null)

/**
 * 确认弹窗随“离开”失效：放在 Router 里面的组件调用（Layout）。路由变化（含浏览器后退 / 前进）或调用方卸载时，
 * 未结算的确认按 false 结算并关闭。AppProvider 在 BrowserRouter 外，看不到路由，所以由 Router 里的组件桥接（main.tsx 不改）。
 * 会话过期跳登录页：Guard 把 Layout 换成登录页，Layout 卸载即结算；另外 AppProvider 在登录态变为未登录时也会结算
 */
export function useCancelConfirmOnLeave() {
  const ctl = useContext(ConfirmControllerContext)
  const { key } = useLocation()
  useEffect(() => () => ctl?.cancel(), [ctl, key])
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
