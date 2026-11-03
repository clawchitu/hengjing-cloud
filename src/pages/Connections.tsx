import { useState } from 'react'
import { faSatelliteDish, faCloud, faTowerCell, faEthernet, faNetworkWired, faTemperatureHalf, faLeaf, faSnowflake, faFan, faBolt, faFaucet, faDoorOpen, faCircleXmark } from '@fortawesome/free-solid-svg-icons'
import { Card, Icon, Pager, Seg, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'

type F = '全部' | '在线' | '离线' | '异常'

export default function Connections() {
  const { projectId, project, toast } = useApp()
  const [rows, setRows] = useAsync(() => api.getConnections(projectId), [projectId])
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
  const bus = (prefix: string) => rows.filter((r) => r.bus.startsWith(prefix))
  const cnt = (rs: typeof rows, type: string | string[]) => { const x = rs.filter((r) => ([] as string[]).concat(type).includes(r.type)); return `${x.filter((r) => r.state === '在线').length}/${x.length}` }
  const b1 = bus('RS485-1'), b2 = bus('RS485-2'), b3 = rows.filter((r) => r.bus.startsWith('LAN') || r.bus.startsWith('Zigbee'))
  const onl = (rs: typeof rows) => `${rs.filter((r) => r.state === '在线').length}/${rs.length}`

  const checkAll = () => { toast(project.online ? `检测完成：${on} 台在线，${off} 台离线，${err} 台通讯异常` : `网关 ${gw.id} 离线，无法检测`, !project.online) }

  const busCard = (name: string, ok: string, proto: string, lines: [typeof faFan, string, string][], icon = faEthernet) => ok.endsWith('/0') ? null : (
    <div className="bus">
      <div className="bh"><Icon icon={icon} /><b className="num">{name}</b><span className="num" style={{ fontSize: 11.5, fontWeight: 600, color: ok.split('/')[0] === ok.split('/')[1] ? 'var(--green)' : '#ea580c' }}>{ok}</span></div>
      <div className="bp num">{proto}</div>
      {lines.filter(([, , v]) => !v.endsWith('/0')).map(([ic, n, v]) => <div className="bl" key={n}><span><Icon icon={ic} />{n}</span><b className="num" style={{ color: v.split('/')[0] === v.split('/')[1] ? 'var(--green)' : '#ea580c' }}>{v}</b></div>)}
    </div>
  )

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
      <Card style={{ marginBottom: 20, paddingBottom: 26 }}>
        <h3 className="card-title" style={{ marginBottom: 22 }}>网络拓扑</h3>
        <div className="topo">
          <div className="cloud"><Icon icon={faCloud} /><b>恒境云平台</b><small className="num">mqtt.hengcloud.cn</small></div>
          <div className="arrow" />
          <div className={'gw' + (gw.online ? '' : ' off')}>
            <div className="row" style={{ gap: 10, marginBottom: 6 }}><div className="gi"><Icon icon={faTowerCell} /></div><div><b className="num" style={{ fontSize: 14 }}>网关 {gw.id}</b>{gw.online ? <div className="green" style={{ fontSize: 11.5 }}><span className="dot" style={{ width: 8, height: 8 }} /> 在线</div> : <div className="red" style={{ fontSize: 11.5 }}><Icon icon={faCircleXmark} /> 离线</div>}</div></div>
            <div className="kv"><span>IP</span><b className="num">{gw.ip}</b></div>
            <div className="kv"><span>已运行</span><b className="num">{gw.uptime}</b></div>
            <div className="kv"><span>{gw.online ? '延迟' : '最后在线'}</span><b className="num">{gw.online ? gw.latency : gw.lastOnline?.slice(5, 16)}</b></div>
          </div>
          <div className="buses">
            {busCard('RS485-1', onl(b1), '9600bps · Modbus-RTU', [[faTemperatureHalf, '温控面板', cnt(b1, '温控面板')], [faLeaf, '空气传感器', cnt(b1, '空气传感器')]])}
            {busCard('RS485-2', onl(b2), '19200bps · Modbus-RTU', [[faSnowflake, '热泵主机', cnt(b2, '空调主机')], [faFan, '新风除湿', cnt(b2, '新风除湿')], [faBolt, '电表', cnt(b2, ['单相电表', '三相电表'])]])}
            {busCard('LAN / 无线', onl(b3), 'Modbus-TCP · Zigbee', [[faFaucet, '水系统/阀门', cnt(b3, '水系统')], [faDoorOpen, '门窗传感', cnt(b3, '门窗传感')]], faNetworkWired)}
          </div>
        </div>
      </Card>
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
