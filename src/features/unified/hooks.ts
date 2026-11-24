// 统一控制的 React hooks（只是状态机的薄封装，逻辑都在 machine.ts / rules.ts，便于单测）。
// 当前项目信息先由页面通过参数注入；S6a 合并后改为从项目数据 hooks 取。
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { consoleLogger } from './log'
import { createUnifiedController, defaultSender, type UnifiedController, type UnifiedDeps, type UnifiedState } from './machine'
import { resolveTempRange, tempAvailability, type TempAvailability, type UnifiedContext } from './rules'
import type { TempRange } from './constants'

export interface UseUnifiedControlOptions<S> extends Omit<UnifiedDeps<S>, 'getContext'> {
  /** 当前项目（注入）；确认时读的是最新一次渲染传入的值 */
  context: UnifiedContext | null | undefined
}

export interface UnifiedControl<S> extends Pick<UnifiedController<S>, 'request' | 'cancel' | 'confirm' | 'reset'> {
  state: UnifiedState<S>
  /** 温度设定是否可用（按 app_code） */
  temp: TempAvailability
  tempRange: TempRange
  /** 项目在线（只有 online===true 才算） */
  online: boolean
  busy: boolean
}

/** 控制器 + 更新依赖的入口。依赖存在闭包里，每次渲染后由 effect 换成最新值 */
export function bindUnifiedControl<S>(initial: UseUnifiedControlOptions<S>) {
  let cur = initial
  const ctl = createUnifiedController<S>({
    getContext: () => cur.context,
    readBack: (id) => cur.readBack(id),
    verify: (q, b, a) => cur.verify?.(q, b, a) ?? [],
    send: (id, q) => (cur.send ?? defaultSender)(id, q),
    log: (e) => (cur.log ?? consoleLogger)(e),
  })
  return { ctl, update: (o: UseUnifiedControlOptions<S>) => { cur = o } }
}

export function useUnifiedControl<S>(opts: UseUnifiedControlOptions<S>): UnifiedControl<S> {
  // 控制器整个组件生命周期只建一次；依赖每次渲染后更新，确认时读到的是最新一次渲染传入的项目。
  // 不在卸载时 dispose：StrictMode 会先卸再装同一个实例；卸载后 useSyncExternalStore 已退订，状态更新无害。
  const [{ ctl, update }] = useState(() => bindUnifiedControl(opts))
  // layout effect 在提交后、浏览器响应下一次点击之前就跑完，确认时读到的是已提交的最新项目
  useLayoutEffect(() => { update(opts) })

  const state = useSyncExternalStore(ctl.subscribe, ctl.getState, ctl.getState)
  const ctx = opts.context
  return {
    state,
    temp: tempAvailability(ctx?.appCode),
    tempRange: resolveTempRange(ctx?.tempRange),
    online: ctx?.online === true,
    busy: state.status === 'sending',
    request: ctl.request,
    cancel: ctl.cancel,
    confirm: ctl.confirm,
    reset: ctl.reset,
  }
}
