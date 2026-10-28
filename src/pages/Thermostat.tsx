import { useState } from 'react'
import { faPowerOff, faLeaf } from '@fortawesome/free-solid-svg-icons'
import { Card, Icon, Toggle, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'
import type { Room } from '../api'

function Tag({ on, label, dim }: { on: boolean; label: string; dim?: boolean }) {
  return <span className={'pill ' + (on ? 'cyan' : 'gray')} style={dim ? { opacity: 0.8 } : undefined}>{!dim && <span className="dot" style={{ width: 5, height: 5, color: on ? 'var(--green-2)' : '#cbd5e1' }} />}{label} {on ? '开' : '关'}</span>
}

function RoomCard({ r, selected, onSelect, onToggle }: { r: Room; selected: boolean; onSelect: () => void; onToggle: (v: boolean) => void }) {
  const off = !r.on
  return (
    <div className={'card room' + (selected ? ' sel' : '') + (off ? ' off' : '')} onClick={onSelect}>
      <div className="room-top">
        <div><div className="room-name">{r.name}</div><div className="room-id num">{r.id} · {r.floor}</div></div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          {off ? <span className="pill gray">已关闭</span> : r.mode === '节能' ? <span className="pill amber"><Icon icon={faLeaf} />节能</span> : <span className="pill gray" style={{ color: 'var(--muted)' }}>标准</span>}
          <Toggle on={r.on} onChange={onToggle} />
        </div>
      </div>
      <div className="room-lbl">室内温度</div>
      <div className="room-mid">
        <div className="room-temp num">{r.temp.toFixed(1)}<small>°C</small></div>
        <div className="room-hd num">湿度 <b>{r.humidity}%</b><br />露点 <b>{r.dew.toFixed(1)}°C</b></div>
      </div>
      <div className="room-sets">
        <div><span>设定温度</span><b className="num">{r.setTemp.toFixed(1)}°C</b></div>
        <div><span>设定湿度</span><b className="num">{r.setHumidity}%</b></div>
        <div><span>风速</span><b>{off ? '--' : r.fan}</b></div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Tag on={!off && r.radiant} label="顶辐射" dim={off} />
        <Tag on={!off && r.floorHeat} label="地冷" dim={off} />
        <Tag on={!off && r.fanCoil} label="风盘" dim={off} />
      </div>
    </div>
  )
}

export default function Thermostat() {
  const { projectId, project, toast, confirm } = useApp()
  const [rooms, setRooms] = useAsync(() => api.getRooms(projectId), [projectId])
  const [sel, setSel] = useState('TP-01')
  if (!rooms) return <div className="page" />
  const on = rooms.filter((r) => r.on)
  const eco = rooms.filter((r) => r.on && r.mode === '节能')
  const avgT = on.reduce((s, r) => s + r.temp, 0) / Math.max(1, on.length)
  const avgH = on.reduce((s, r) => s + r.humidity, 0) / Math.max(1, on.length)
  const avgD = on.reduce((s, r) => s + r.dew, 0) / Math.max(1, on.length)

  const setPower = async (ids: string[], v: boolean) => setRooms(await api.setRoomPower(projectId, ids, v))
  const all = async (v: boolean) => {
    const ok = await confirm({ title: v ? '全部开启' : '全部关闭', body: <>将向 <b>{project.name}</b> 的 {rooms.length} 个温控面板下发「{v ? '开启' : '关闭'}」指令，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    await setPower(rooms.map((r) => r.id), v)
    toast(`已下发：全部${v ? '开启' : '关闭'}（${rooms.length} 个房间）`)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>房间温控面板</h1>
          <div className="sub">{project.name}<span className="sep">·</span>{rooms.length} 个房间温控面板<span className="sep">·</span>末端：顶辐射 / 地冷（暖）/ 风盘</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => all(false)}><Icon icon={faPowerOff} />全部关闭</button>
          <button className="btn primary" onClick={() => all(true)}><Icon icon={faPowerOff} />全部开启</button>
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Card className="kpi"><div className="k-label">温控面板</div><div className="k-val">{rooms.length}</div><div className="k-foot">全部在线</div></Card>
        <Card className="kpi"><div className="k-label">已开启房间</div><div className="k-val green">{on.length}</div><div className="k-foot">{rooms.length - on.length} 间关闭</div></Card>
        <Card className="kpi"><div className="k-label">节能模式</div><div className="k-val" style={{ color: 'var(--amber)' }}>{eco.length}</div><div className="k-foot">{eco.map((r) => r.name).join('、') || '—'}</div></Card>
        <Card className="kpi"><div className="k-label">平均室温 / 湿度</div><div className="k-val">{avgT.toFixed(1)}°<small style={{ fontSize: 17 }}>/ {Math.round(avgH)}%</small></div><div className="k-foot">平均露点 {avgD.toFixed(1)}°C</div></Card>
      </div>
      <div className="grid g2">
        {rooms.map((r) => (
          <RoomCard key={r.id} r={r} selected={sel === r.id} onSelect={() => setSel(r.id)}
            onToggle={async (v) => { await setPower([r.id], v); toast(`${r.name} 已${v ? '开启' : '关闭'}`) }} />
        ))}
      </div>
    </div>
  )
}

