// 共用写锁（src/api/writeLock.ts）的应用初始化：先 configureWriteLock 注入「当前账号可见项目」的同步查询（S6a 组织范围），
// 组织数据就绪后再注册各页的核对器（注册时会立刻核对刷新恢复的锁，所以必须在注入之后）。由 OrgGate 调用一次。
// 统一控制（S12）、新风（S10）接入时在这里加各自的 register*Verifiers。
import { useEffect, useLayoutEffect, useRef } from 'react'
import { configureWriteLock } from '../api/writeLock'
import { useOrgScope } from '../data/org'
import { registerThermostatVerifiers } from '../features/thermostat/lockVerify'

export function useWriteLockSetup() {
  const org = useOrgScope()
  const projects = useRef(org.data.projects)
  useLayoutEffect(() => { projects.current = org.data.projects })
  useLayoutEffect(() => {
    configureWriteLock({ resolveProject: (id) => projects.current.find((p) => p.id === id) ?? null })
    return () => configureWriteLock({ resolveProject: null })
  }, [])
  const ready = org.status === 'success'
  useEffect(() => (ready ? registerThermostatVerifiers() : undefined), [ready])
}
