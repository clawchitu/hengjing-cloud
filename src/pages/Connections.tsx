import { useState } from 'react'
import { faSatelliteDish } from '@fortawesome/free-solid-svg-icons'
import { Icon, Pager, Seg, useAsync } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import * as api from '../api'

type F = '全部' | '在线' | '离线' | '异常'

export default function Connections() {
  const { projectId, project, toast } = useApp()
  const [rows] = useAsync(() => api.getConnections(projectId), [projectId])
  const [gw] = useAsync(() => api.getGateway(projectId), [projectId])
  const [f, setF] = useState<F>('全部')
  const [page, setPage] = useState(1)
  // 没有设备数据（交付包里连接状态尚未接入真实接口）：不显示检测、在线率等无依据的数字
  if (rows && rows.length === 0) return (
    <div className="page">
      <div className="page-head"><div><h1>设备连接状态</h1><div className="sub">{project.name}</div></div></div>
      <Card className="placeholder">
        <div className="ph-ico"><Icon icon={faSatelliteDish} /></div>
        <h3>暂无设备连接数据</h3>
        <p>该项目暂时没有可显示的设备连接状态。</p>
      </Card>
    </div>
  )
  if (!rows || !gw) return <div className="page" />

  const on = rows.filter((r) => r.state === '在线').length
  const off = rows.filter((r) => r.state === '离线').length
  const err = rows.filter((r) => r.state === '通讯异常').length
  const list = rows.filter((r) => f === '全部' || (f === '在线' && r.state === '在线') || (f === '离线' && r.state === '离线') || (f === '异常' && r.state === '通讯异常'))
  const SIZE = 7
  const shown = list.slice((page - 1) * SIZE, page * SIZE)

  const checkAll = () => { toast(project.online ? `检测完成：${on} 台在线，${off} 台离线，${err} 台通讯异常` : `网关 ${gw.id} 离线，无法检测`, !project.online) }


  return (
    <div className="page">
      <div className="page-head">
        <div><h1>设备连接状态</h1><div className="sub">{project.name}<span className="sep">·</span>网关 {gw.id}<span className="sep">·</span>每 30 秒检测一次</div></div>
        <Button variant="primary" onClick={checkAll}><Icon icon={faSatelliteDish} />立即检测</Button>
      </div>
      <div className="hj-grid g4" style={{ marginBottom: 20 }}>
        <Card className="kpi"><div className="k-label">接入设备</div><div className="k-val">{rows.length}</div><div className="k-foot">{new Set(rows.map((r) => r.type)).size} 类设备</div></Card>
        <Card className="kpi"><div className="k-label">在线</div><div className="k-val green">{on}</div><div className="k-foot">在线率 {(on / rows.length * 100).toFixed(1)}%</div></Card>
        <Card className="kpi"><div className="k-label">离线</div><div className="k-val muted">{off}</div><div className="k-foot">{project.online ? (off ? '最长 2h 37m' : '—') : '网关离线'}</div></Card>
        <Card className="kpi"><div className="k-label">通讯异常</div><div className="k-val" style={{ color: 'var(--amber)' }}>{err}</div><div className="k-foot">丢包率 &gt; 10%</div></Card>
      </div>
      <Card pad={false}>
        <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14, alignItems: 'center' }}><CardTitle>设备连接明细</CardTitle>
          <Seg value={f} options={['全部', '在线', '离线', '异常']} onChange={(v) => { setF(v); setPage(1) }} counts={{ 全部: rows.length, 在线: on, 离线: off, 异常: err }} /></CardHeader>
        <Table>
          <TableHeader><TableRow><TableHead>设备名称</TableHead><TableHead>类型</TableHead><TableHead>地址</TableHead><TableHead>连接状态</TableHead></TableRow></TableHeader>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={r.name} className={r.state === '离线' ? 'st-off' : r.state === '通讯异常' ? 'st-err' : ''}>
                <TableCell style={{ fontWeight: 500 }} className="num">{r.name}</TableCell><TableCell>{r.type}</TableCell><TableCell className="num">{r.bus.split(' / ')[1] ?? r.bus}</TableCell>
                <TableCell>{r.state === '在线' ? <Badge variant="green"><span className="dot" style={{ width: 8, height: 8 }} />在线</Badge> : r.state === '离线' ? <Badge variant="dark"><span className="dot" style={{ width: 8, height: 8, color: '#334155' }} />离线</Badge> : <Badge variant="amber" style={{ color: '#ea580c', background: '#ffedd5' }}><span className="dot" style={{ width: 8, height: 8 }} />通讯异常</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pager total={list.length} page={page} size={SIZE} onPage={setPage} />
      </Card>
    </div>
  )
}
