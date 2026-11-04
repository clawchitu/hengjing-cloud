import { useState } from 'react'
import { faSatelliteDish } from '@fortawesome/free-solid-svg-icons'
import { Card, Icon, Pager, Seg, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'

type F = '全部' | '在线' | '离线' | '异常'

export default function Connections() {
  const { projectId, project, toast } = useApp()
  const [rows] = useAsync(() => api.getConnections(projectId), [projectId])
  const [gw] = useAsync(() => api.getGateway(projectId), [projectId])
  const [f, setF] = useState<F>('全部')
  const [page, setPage] = useState(1)
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
        <button className="btn primary" onClick={checkAll}><Icon icon={faSatelliteDish} />立即检测</button>
      </div>
      <div className="grid g4" style={{ marginBottom: 20 }}>
        <Card className="kpi"><div className="k-label">接入设备</div><div className="k-val">{rows.length}</div><div className="k-foot">{new Set(rows.map((r) => r.type)).size} 类设备</div></Card>
        <Card className="kpi"><div className="k-label">在线</div><div className="k-val green">{on}</div><div className="k-foot">在线率 {(on / rows.length * 100).toFixed(1)}%</div></Card>
        <Card className="kpi"><div className="k-label">离线</div><div className="k-val muted">{off}</div><div className="k-foot">{project.online ? (off ? '最长 2h 37m' : '—') : '网关离线'}</div></Card>
        <Card className="kpi"><div className="k-label">通讯异常</div><div className="k-val" style={{ color: 'var(--amber)' }}>{err}</div><div className="k-foot">丢包率 &gt; 10%</div></Card>
      </div>
      <Card pad={false}>
        <div className="card-head card-pad" style={{ marginBottom: 0, paddingBottom: 14, alignItems: 'center' }}><h3 className="card-title">设备连接明细</h3>
          <Seg value={f} options={['全部', '在线', '离线', '异常']} onChange={(v) => { setF(v); setPage(1) }} counts={{ 全部: rows.length, 在线: on, 离线: off, 异常: err }} /></div>
        <table className="table">
          <thead><tr><th>设备名称</th><th>类型</th><th>地址</th><th>连接状态</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.name} className={r.state === '离线' ? 'st-off' : r.state === '通讯异常' ? 'st-err' : ''}>
                <td style={{ fontWeight: 500 }} className="num">{r.name}</td><td>{r.type}</td><td className="num">{r.bus.split(' / ')[1] ?? r.bus}</td>
                <td>{r.state === '在线' ? <span className="pill green"><span className="dot" style={{ width: 8, height: 8 }} />在线</span> : r.state === '离线' ? <span className="pill dark"><span className="dot" style={{ width: 8, height: 8, color: '#334155' }} />离线</span> : <span className="pill amber" style={{ color: '#ea580c', background: '#ffedd5' }}><span className="dot" style={{ width: 8, height: 8 }} />通讯异常</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager total={list.length} page={page} size={SIZE} onPage={setPage} />
      </Card>
    </div>
  )
}
