// 组织数据门控：集成项目和项目列表就绪、且至少有一个可见项目之后才渲染里面的内容（Layout 和各页面）。
// - 加载中：不渲染（和登录态恢复时一样），不会把占位项目当成「离线」显示，也不会挂载设备页；
// - 失败：显示错误和「重试」；
// - 没有可见项目：显示空态（S6b 再细化）。
// mock 模式数据首屏同步就绪，直接渲染 children，截图不变。
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { defaultText } from '../api/errors'
import { logout } from '../data/session'
import { useOrgScope } from '../data/org'

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
  if (org.status === 'loading') return <Panel title="正在加载" text="正在获取集成项目和项目列表…" />
  if (org.status === 'error') return (
    <Panel title="加载失败" text={org.error?.message || defaultText('server')}>
      <Button variant="primary" onClick={org.refetch}>重试</Button>
      <Button onClick={logout}>退出登录</Button>
    </Panel>
  )
  if (org.data.projects.length === 0) return (
    <Panel title="暂无可用项目" text="当前账号下没有集成项目或项目，请联系管理员。">
      <Button variant="primary" onClick={org.refetch}>刷新</Button>
      <Button onClick={logout}>退出登录</Button>
    </Panel>
  )
  return <>{children}</>
}
