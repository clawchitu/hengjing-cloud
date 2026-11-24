// 共用写锁（src/api/writeLock.ts）的核对器注册：所有写锁核对器只在这一个文件里注册，由 OrgGate 调用。
// - 203（统一控制 S12）：核对函数在 features/unified/lock.ts（verifier203），这里随首次渲染同步注册（和原来在 AppProvider 里注册一样不等组织数据），
//   注册后补核对一次恢复的锁（刷新后补核对的触发路径不变：项目列表 / 集成项目列表加载成功时由 setupUnifiedWriteLock 的订阅继续触发）。
// - 201 / 206（温控 S9）：组织数据就绪后注册（注册时会立刻核对恢复的锁，此时可见项目已可查）。
// configureWriteLock 只调一处：resolveProject 由统一控制的 setupUnifiedWriteLock 在 AppProvider 里注入，避免互相覆盖。
import { useEffect, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { registerVerifier } from '../api/writeLock'
import { isMockMode } from '../api/config'
import { mockUnifiedRead } from '../api'
import { useOrgScope } from '../data/org'
import { readUnifiedSnapshot } from '../features/unified/batch'
import { recheckRestoredLocks, verifier203 } from '../features/unified/lock'
import { registerThermostatVerifiers } from '../features/thermostat/lockVerify'

/** 注册 203 核对器（真实接口回读用 readUnifiedSnapshot，演示数据用 mockUnifiedRead） */
export function registerUnifiedVerifier(qc: QueryClient): () => void {
  const off = registerVerifier(203, verifier203(isMockMode() ? (id) => mockUnifiedRead(id) : readUnifiedSnapshot))
  recheckRestoredLocks(qc)
  return off
}

export function useWriteLockSetup() {
  const qc = useQueryClient()
  useState(() => { registerUnifiedVerifier(qc); return null })
  const org = useOrgScope()
  const ready = org.status === 'success'
  useEffect(() => (ready ? registerThermostatVerifiers() : undefined), [ready])
}
