// 共用写锁（src/api/writeLock.ts）的初始化：所有写锁核对器只在这一个文件里注册。
// registerAllVerifiers 由 AppProvider 在原来调 setupUnifiedWriteLock 的位置调用（渲染期、按 QueryClient 只做一次，时机不比原来晚）：
// 1. configureWriteLock({ resolveProject })（经 setupUnifiedWriteLock，只调一次）；
// 2. 注册 203（统一控制 S12）核对器；201 / 206（温控 S9）仍在 OrgGate 的组织数据就绪后注册（时机同原来，见 registerThermostatVerifiersOnce），核对函数留在各自的 features 里；
// 204（新风 S10c）的核对器同样只在本文件注册，和 201 / 206 同一个位置（OrgGate 在组织数据就绪后调，见 registerFreshAirVerifiersOnce）。
// 3. 注册后补核对恢复的锁（项目列表 / 集成项目列表加载成功时的触发路径由 setupUnifiedWriteLock 的订阅保留）。
import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useOrgScope } from '../data/org'
import { registerVerifier } from '../api/writeLock'
import { isMockMode } from '../api/config'
import { mockUnifiedRead } from '../api'
import { readUnifiedSnapshot } from '../features/unified/batch'
import { recheckRestoredLocks, setupUnifiedWriteLock, verifier203 } from '../features/unified/lock'
import { verifier201, verifier206 } from '../features/thermostat/lockVerify'
import { verifier204 } from '../features/freshAir/lockVerify'

const registered = new WeakSet<QueryClient>()

/** 同一个 QueryClient 只注册一次（StrictMode 双调用、重新挂载都不重复） */
export function registerAllVerifiers(qc: QueryClient): void {
  if (registered.has(qc)) return
  registered.add(qc)
  setupUnifiedWriteLock(qc)
  registerVerifier(203, verifier203(isMockMode() ? (id) => mockUnifiedRead(id) : readUnifiedSnapshot))
  recheckRestoredLocks(qc)
}

const thermostatRegistered = new WeakSet<QueryClient>()

/**
 * 温控 201 / 206：和原来一样由 OrgGate 在组织数据就绪后（effect 里，晚于页面首次读取）调用；按 QueryClient 幂等。
 * 注册时立刻核对恢复的锁，此时可见项目已可查，核对完放锁后页面能收到强制重读。
 */
export function registerThermostatVerifiersOnce(qc: QueryClient): void {
  if (thermostatRegistered.has(qc)) return
  thermostatRegistered.add(qc)
  registerVerifier(201, verifier201)
  registerVerifier(206, verifier206)
}

const freshAirRegistered = new WeakSet<QueryClient>()

/**
 * 新风 204：照 201 / 206 的方式，由 OrgGate 在组织数据就绪后调用；按 QueryClient 幂等，注册后不随就绪状态注销。
 * 刷新恢复的 204 锁由它核对（新读 202 + 210，只比对改了的字段）
 */
export function registerFreshAirVerifiersOnce(qc: QueryClient): void {
  if (freshAirRegistered.has(qc)) return
  freshAirRegistered.add(qc)
  registerVerifier(204, verifier204)
}

/** OrgGate 调用：组织数据就绪后注册温控（201 / 206）与新风（204）核对器 */
export function useWriteLockSetup(): void {
  const qc = useQueryClient()
  const ready = useOrgScope().status === 'success'
  useEffect(() => { if (ready) { registerThermostatVerifiersOnce(qc); registerFreshAirVerifiersOnce(qc) } }, [qc, ready])
}

