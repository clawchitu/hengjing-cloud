// 温控（S9）接入共用写锁（src/api/writeLock.ts）的应用初始化：注册 201 / 206 的核对器（刷新恢复的锁、写后自动核对用）。
// resolveProject 由统一控制的 setupUnifiedWriteLock 在 AppProvider 里注入（configureWriteLock 只调一处，避免互相覆盖）；
// 这里在组织数据就绪后注册（注册时会立刻核对恢复的锁，此时可见项目已可查）。由 OrgGate 调用一次。
import { useEffect } from 'react'
import { useOrgScope } from '../data/org'
import { registerThermostatVerifiers } from '../features/thermostat/lockVerify'

export function useWriteLockSetup() {
  const org = useOrgScope()
  const ready = org.status === 'success'
  useEffect(() => (ready ? registerThermostatVerifiers() : undefined), [ready])
}
