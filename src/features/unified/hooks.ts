// 统一控制的 React hooks（只是状态机的薄封装，逻辑都在 machine.ts / rules.ts，便于单测）。
// 当前项目信息先由页面通过参数注入；S6a 合并后改为从项目数据 hooks 取。
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createUnifiedBatch, defaultBatchSender, readUnifiedSnapshot, type BatchDeps, type BatchState, type UnifiedBatch } from './batch'
import { consoleLogger } from './log'
import { createUnifiedController, defaultSender, type UnifiedController, type UnifiedDeps, type UnifiedState } from './machine'
import { resolveTempRange, tempAvailability, type TempAvailability, type UnifiedContext } from './rules'
import type { TempRange } from './constants'

export interface UseUnifiedControlOptions<S> extends Omit<UnifiedDeps<S>, 'getContext'> {
  /** 当前项目（注入）；确认时和发送前读的是最新一次提交的值 */
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

/**
 * 控制器 + 更新依赖的入口。依赖存在闭包里，每次提交后换成最新值；
 * 项目 code 变了就 abort()（终止还没发出的流程）。unmount() 供卸载时调用
 */
export function bindUnifiedControl<S>(initial: UseUnifiedControlOptions<S>) {
  let cur = initial
  const ctl = createUnifiedController<S>({
    getContext: () => cur.context,
    readBack: (id, signal) => cur.readBack(id, signal),
    toEcho: (s) => cur.toEcho(s),
    send: (id, q) => (cur.send ?? defaultSender)(id, q),
    log: (e) => (cur.log ?? consoleLogger)(e),
  })
  return {
    ctl,
    update(o: UseUnifiedControlOptions<S>) {
      const prevCode = cur.context?.projectCode
      const prevId = cur.context?.projectId
      cur = o
      if (o.context?.projectCode !== prevCode || o.context?.projectId !== prevId) ctl.abort()
    },
    unmount() { ctl.abort() },
  }
}

export function useUnifiedControl<S>(opts: UseUnifiedControlOptions<S>): UnifiedControl<S> {
  // 控制器整个组件生命周期只建一次。layout effect 在提交后、浏览器响应下一次点击之前就跑完。
  // 卸载时在 layout effect 的清理里同步 abort()（卸载提交时就执行，不等被动 effect）。
  // StrictMode 先卸再装时 abort 只作废进行中的流程，控制器本身仍可用
  const [{ ctl, update, unmount }] = useState(() => bindUnifiedControl(opts))
  useLayoutEffect(() => { update(opts) })
  useLayoutEffect(() => unmount, [unmount])

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

/**
 * 统一控制页面用的批量控制器（S12b）：多个项目逐个走上面的单项目状态机。
 * 控制器整个组件生命周期只建一次；getProjects 每次提交后换成最新值；卸载时在 layout effect 清理里同步 abort()
 */
export function useUnifiedBatch(deps: BatchDeps): UnifiedBatchControl {
  const ref = useRef(deps)
  useLayoutEffect(() => { ref.current = deps })
  const [batch] = useState(() => createUnifiedBatch({
    ...deps,
    getProjects: () => ref.current.getProjects(),
    readBack: (id, s) => (ref.current.readBack ?? readUnifiedSnapshot)(id, s),
    send: (p, q, o) => (ref.current.send ?? defaultBatchSender)(p, q, o),
  }))
  useLayoutEffect(() => () => batch.abort(), [batch])
  const state = useSyncExternalStore(batch.subscribe, batch.getState, batch.getState)
  return { batch, state }
}
export interface UnifiedBatchControl { batch: UnifiedBatch; state: BatchState }
