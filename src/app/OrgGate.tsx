// 组织数据门控（包在 Layout 外，main.tsx 一层；守卫管登录，这里管组织数据就绪，已与赤兔对齐）：
// - 集成项目或项目列表加载中：整页显示加载态（可退出登录），不会把占位项目当成「离线」，也不挂载页面；
// - 首次加载失败：整页显示错误、「重试」和「退出登录」；
// - 没有可见项目：不拦，首页、集成项目、统一控制、设置照常进；4 个设备页由 Layout 显示空态（见 Layout.tsx）。
// mock 模式数据首屏同步就绪，直接渲染 children，截图不变。
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { defaultText } from '../api/errors'
import { logout } from '../data/session'
import { useOrgScope } from '../data/org'
import { useWriteLockSetup } from './writeLockSetup'

function Panel({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div role="status" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>{title}</h1>
        <p className="muted" style={{ marginBottom: 16 }}>{text}</p>
        <div className="row" style={{ gap: 10, justifyContent: 'center' }}>{children}</div>
      </div>
    </div>
  )
}

export function OrgGate({ children }: { children: ReactNode }) {
  const org = useOrgScope()
  // 温控核对器在组织数据就绪后注册（幂等，注册都在 writeLockSetup）
  useWriteLockSetup()
  if (org.status === 'loading') return (
    <Panel title="正在加载" text="正在获取集成项目和项目列表…">
      <Button onClick={logout}>退出登录</Button>
    </Panel>
  )
  if (org.status === 'error') return (
    <Panel title="加载失败" text={org.error?.message || defaultText('server')}>
      <Button variant="primary" onClick={org.refetch}>重试</Button>
      <Button onClick={logout}>退出登录</Button>
    </Panel>
  )
  return <>{children}</>
}
