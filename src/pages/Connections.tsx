// 设备连接状态（S11）：ctrl 205 设备汇总，每 30 秒重新读一次。数据与映射见 src/data/connections.ts。
// 按方案 1.2：「类型」列改为型号（205 的 model）；KPI 由前端按 conn_status 统计，「最长离线时长」「丢包率」
// 接口无此字段，去掉；网关 IP / 延迟 / 运行时长无来源，页头不显示控制屏 / DTU 编号（S13 走查 P6）。
// 「立即检测」就是立刻重新读一次 205（只读，与 30 秒轮询同一个请求），不触发任何下发。
import { useState, type ReactNode } from 'react'
import { faLock, faPlugCircleXmark, faSatelliteDish, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { Icon, Pager, Seg } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import { defaultText } from '../api/errors'
import { useCurrentProject } from '../data/org'
import { CONN_STATUS_TEXT, connCounts, filterConn, pct, useDeviceSummary, type ConnFilter, type ConnStatus } from '../data/connections'

// 每页 10 条：一个项目常见 8–10 台设备，一页看完（S13 走查 P9）
const SIZE = 10

function StatusBadge({ s }: { s: ConnStatus }) {
  const dot = (color?: string) => <span className="dot" style={{ width: 8, height: 8, ...(color ? { color } : {}) }} />
  if (s === 'online') return <Badge variant="green">{dot()}在线</Badge>
  if (s === 'offline') return <Badge variant="dark">{dot('#334155')}离线</Badge>
  if (s === 'error') return <Badge variant="amber" style={{ color: '#ea580c', background: '#ffedd5' }}>{dot()}通讯异常</Badge>
  return <Badge variant="gray">{dot()}{CONN_STATUS_TEXT.unknown}</Badge>
}

function Empty({ icon, title, text, children }: { icon: IconDefinition; title: string; text: string; children?: ReactNode }) {
  return (
    <Card className="placeholder" role="status">
      <div className="ph-ico"><Icon icon={icon} /></div>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </Card>
  )
}

export default function Connections() {
  const { toast } = useApp()
  const { project } = useCurrentProject()
  const sum = useDeviceSummary(project)
  const [f, setF] = useState<ConnFilter>('全部')
  const [page, setPage] = useState(1)

  // 没有当前项目（分工.md 第 3 节第 6 条）：空态，不发 ctrl 请求。Layout 一般已先拦下，这里兜底
  if (!project) return (
    <div className="page">
      <div className="page-head"><div><h1>设备连接状态</h1></div></div>
      <Empty icon={faSatelliteDish} title="暂无可用项目" text="当前账号下没有可查看的项目。" />
    </div>
  )

  const rows = sum.rows
  const c = connCounts(rows)
  const offlineScreen = sum.error?.kind === 'unavailable'

  const checkNow = async () => {
    const r = await sum.check()
    // 页面已离开、项目已切换、请求被取消，或不是这次检测发起的请求：不提示
    if (!r) return
    if (r.rows) {
      const n = connCounts(r.rows)
      toast(`检测完成：${n.online} 台在线，${n.offline} 台离线，${n.error} 台通讯异常`)
    // 控制屏未连接是常态，页面已显示空态：只给普通提示，不弹错误（方案 3.3）
    } else if (r.error) toast(r.error.kind === 'unavailable' ? '控制屏未连接，暂时无法检测' : `检测失败：${r.error.message}`, r.error.kind !== 'unavailable')
  }

  const head = (
    <div className="page-head">
      {/* 不显示 control_screen_id / dtu_id（S13 走查 P6：control_screen_id 是型号 id、不是屏号，多个项目共用同一个值） */}
      <div><h1>设备连接状态</h1><div className="sub">{project.name}<span className="sep">·</span>每 30 秒检测一次</div></div>
      {sum.permitted && <Button variant="primary" onClick={checkNow} disabled={sum.fetching} aria-busy={sum.fetching}><Icon icon={faSatelliteDish} />立即检测</Button>}
    </div>
  )

  let body: ReactNode
  if (!sum.permitted) body = <Empty icon={faLock} title="未开通设备连接状态" text="当前账号没有读取设备连接状态的权限，请联系管理员开通。" />
  else if (sum.status === 'loading' || sum.status === 'idle') body = <Empty icon={faSatelliteDish} title="正在读取设备连接状态" text="正在向控制屏读取设备连接状态…" />
  // 控制屏离线（503）：显示空态，不显示上一次的明细（方案 3.3）；轮询仍在，控制屏恢复后自动显示。
  // 503 之后再遇到其他错误：数据层已把旧明细作废（status=error），走下面的「读取失败」
  else if (offlineScreen) body = <Empty icon={faPlugCircleXmark} title="控制屏未连接" text="控制屏当前没有连上平台，暂时读不到设备连接状态；恢复连接后会自动刷新。" />
  else if (sum.status === 'error') body = (
    <Empty icon={faTriangleExclamation} title="读取失败" text={sum.error?.message || defaultText('server')}>
      <Button style={{ marginTop: 16 }} onClick={checkNow} disabled={sum.fetching}>重试</Button>
    </Empty>
  )
  else if (rows.length === 0) body = <Empty icon={faSatelliteDish} title="暂无设备连接数据" text="控制屏没有返回设备连接信息。" />
  else {
    const list = filterConn(rows, f)
    // 轮询后条目变少时页码不越界
    const cur = Math.min(page, Math.max(1, Math.ceil(list.length / SIZE)))
    const shown = list.slice((cur - 1) * SIZE, cur * SIZE)
    body = (
      <>
        {/* 有旧数据时后台刷新失败：继续显示上一次的明细，并提示 */}
        {sum.error && <div role="status" className="muted" style={{ fontSize: 12.5, margin: '-8px 0 12px' }}><Icon icon={faTriangleExclamation} /> 最近一次刷新失败（{sum.error.message}），以下为上一次读取的结果</div>}
        <div className="hj-grid g4" style={{ marginBottom: 20 }}>
          <Card className="kpi"><div className="k-label">接入设备</div><div className="k-val">{c.total}</div><div className="k-foot">{c.models} 种型号</div></Card>
          <Card className="kpi"><div className="k-label">在线</div><div className="k-val green">{c.online}</div><div className="k-foot">在线率 {pct(c.online, c.total)}%</div></Card>
          <Card className="kpi"><div className="k-label">离线</div><div className="k-val muted">{c.offline}</div><div className="k-foot">占比 {pct(c.offline, c.total)}%</div></Card>
          <Card className="kpi"><div className="k-label">通讯异常</div><div className="k-val" style={{ color: 'var(--amber)' }}>{c.error}</div><div className="k-foot">占比 {pct(c.error, c.total)}%</div></Card>
        </div>
        <Card pad={false}>
          <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14, alignItems: 'center' }}><CardTitle>设备连接明细</CardTitle>
            <Seg value={f} options={['全部', '在线', '离线', '异常']} onChange={(v) => { setF(v); setPage(1) }} counts={{ 全部: c.total, 在线: c.online, 离线: c.offline, 异常: c.error }} /></CardHeader>
          <Table>
            <TableHeader><TableRow><TableHead>设备名称</TableHead><TableHead>型号</TableHead><TableHead>地址</TableHead><TableHead>连接状态</TableHead></TableRow></TableHeader>
            <TableBody>
              {/* 筛选后没有设备：表格里给一行空态，不只剩表头（S13 走查 P9） */}
              {shown.length === 0 && <TableRow><TableCell colSpan={4} className="faint" style={{ textAlign: 'center', padding: '22px 0' }}>{f === '全部' ? '暂无设备' : `没有${f === '异常' ? '通讯异常' : f}的设备`}</TableCell></TableRow>}
              {shown.map((r) => (
                <TableRow key={r.key} className={r.status === 'offline' ? 'st-off' : r.status === 'error' ? 'st-err' : ''}>
                  <TableCell style={{ fontWeight: 500 }} className="num">{r.name}</TableCell><TableCell>{r.model}</TableCell><TableCell className="num">{r.address}</TableCell>
                  <TableCell><StatusBadge s={r.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager total={list.length} page={cur} size={SIZE} onPage={setPage} />
        </Card>
      </>
    )
  }

  return <div className="page">{head}{body}</div>
}
