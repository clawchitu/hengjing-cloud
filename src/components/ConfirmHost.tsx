import { useRef, useSyncExternalStore, type MouseEvent } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { focusWithRing, type ConfirmController } from '../app/feedback'

/*
 * 确认弹窗的界面（请求与结算的约定见 app/feedback.ts）。按钮和 Esc 只结算本次渲染出来的请求（按 id）。
 *
 * 焦点（浏览器默认外圈只在 :focus-visible 时出现）。打开时 Radix 默认把焦点给「取消」，关闭时还给触发器，两次都是脚本聚焦，
 * Chromium 会按之前有没有用过键盘决定是否命中 :focus-visible，于是鼠标操作也可能冒出外圈。这里两次都自己聚焦并明确指定外圈
 * （focusWithRing：支持 focus({ focusVisible }) 就用它，不支持就打 data-focus-ring 标记）：
 * | 打开方式                     | 打开后「取消」外圈 | 关闭方式                         | 关闭后触发器外圈 |
 * | 鼠标点触发器                 | 无                 | 鼠标点「取消」/「确认」           | 无               |
 * | 键盘（Enter / 空格）         | 有                 | 鼠标点「取消」/「确认」           | 无               |
 * | 鼠标 / 键盘                  | —                  | 键盘在按钮上按 Enter / 空格       | 有               |
 * | 鼠标 / 键盘                  | —                  | Esc                               | 有               |
 * | 鼠标 / 键盘                  | —                  | 点遮罩                            | 不关闭           |
 * | 鼠标 / 键盘                  | —                  | 离开（路由变化、登出等，按取消）  | 触发器还在就还焦点、无外圈 |
 * - 关闭方式：按钮 click 的 detail > 0 是指针点击，0 是键盘激活；Esc 走 onOpenChange(false)；
 * - 触发器已卸载（如退出登录后跳转）就不聚焦；没有触发器（焦点原本在 body）时焦点留在 body，同旧版。
 */
export function ConfirmHost({ controller }: { controller: ConfirmController }) {
  const { open, req } = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const cancelRef = useRef<HTMLButtonElement>(null)
  if (!req) return null
  const onButton = (v: boolean) => (e: MouseEvent) => controller.settle(req.id, v, e.detail === 0)
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) controller.settle(req.id, false, true) }}>
      <AlertDialogContent
        onOpenAutoFocus={(e) => { e.preventDefault(); if (cancelRef.current) focusWithRing(cancelRef.current, req.keyboard) }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const c = controller.takeClosing()
          if (c?.trigger?.isConnected) focusWithRing(c.trigger, c.keyboard)
        }}
      >
        <AlertDialogTitle><FontAwesomeIcon icon={faTriangleExclamation} style={{ color: req.danger ? 'var(--red)' : 'var(--amber)' }} />{req.title}</AlertDialogTitle>
        <AlertDialogDescription>{req.body}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel asChild><Button ref={cancelRef} onClick={onButton(false)}>取消</Button></AlertDialogCancel>
          <AlertDialogAction asChild><Button variant="primary" onClick={onButton(true)}>{req.okText ?? '确认'}</Button></AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
