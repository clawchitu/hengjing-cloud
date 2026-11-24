import { useState } from 'react'
import { faPowerOff, faLeaf, faFan } from '@fortawesome/free-solid-svg-icons'
import { Chart, Icon, Seg, axis, tooltip, useAsync } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useStats, type Range } from './Sensors'
import { useApp } from '../app/store'
import { useConfirm } from '../app/feedback'
import * as api from '../api'
import { PROGRAMS, hasRooms, type Room } from '../api'

function Tag({ on, label, dim }: { on: boolean; label: string; dim?: boolean }) {
  return <Badge variant={on ? 'cyan' : 'gray'} style={dim ? { opacity: 0.8 } : undefined}>{!dim && <span className="dot" style={{ width: 5, height: 5, color: on ? 'var(--green-2)' : '#cbd5e1' }} />}{label} {on ? '开' : '关'}</Badge>
}

function RoomCard({ r, selected, onSelect, onToggle }: { r: Room; selected: boolean; onSelect: () => void; onToggle: (v: boolean) => void }) {
  const off = !r.on
  return (
    <Card pad={false} className={'room' + (selected ? ' sel' : '') + (off ? ' off' : '')} onClick={onSelect}>
      <div className="room-top">
        <div><div className="room-name">{r.name}</div><div className="room-id num">{r.id} · {r.floor}</div></div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          {off ? <Badge variant="gray">已关闭</Badge> : r.mode === '节能' ? <Badge variant="amber"><Icon icon={faLeaf} />节能</Badge> : <Badge variant="gray" style={{ color: 'var(--muted)' }}>标准</Badge>}
          <Switch checked={r.on} onCheckedChange={onToggle} aria-label={`${r.name} 开关`} />
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
    </Card>
  )
}

export default function Thermostat() {
  const { projectId, project, toast } = useApp()
  const confirm = useConfirm()
  const [rooms, setRooms] = useAsync(() => api.getRooms(projectId), [projectId])
  const [sel, setSel] = useState('TP-01')
  const [range, setRange] = useState<Range>('24小时')
  const statRoom = rooms?.find((r) => r.id === sel) ?? rooms?.[0]
  const stats = useStats(range, () => api.getRoomStats24h(projectId, statRoom?.id ?? ''), (d) => api.getRoomStatsDaily(projectId, statRoom?.id ?? '', d), [projectId, statRoom?.id])
  if (!rooms) return <div className="page" />
  if (!hasRooms(project) || rooms.length === 0) return (
    <div className="page">
      <div className="page-head"><div><h1>房间温控面板</h1><div className="sub">{project.name}<span className="sep">·</span>程序 {PROGRAMS[project.programCode]}（编码 <span className="num">{project.programCode}</span>）</div></div></div>
      <Card className="placeholder">
        <div className="ph-ico"><Icon icon={faFan} /></div>
        <h3>该项目无房间温控面板</h3>
        <p>「{project.name}」为<b>新风单机版</b>项目（程序编码 {project.programCode}），仅接入新风除湿机，不包含房间温控面板。<br />新风机的运行数据与运行设置请前往「新风除湿机」查看。</p>
      </Card>
    </div>
  )
  const on = rooms.filter((r) => r.on)
  const eco = rooms.filter((r) => r.on && r.mode === '节能')
  const avgT = on.reduce((s, r) => s + r.temp, 0) / Math.max(1, on.length)
  const avgH = rooms.reduce((s, r) => s + r.humidity, 0) / rooms.length
  const avgD = rooms.reduce((s, r) => s + r.dew, 0) / rooms.length

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
          <Button onClick={() => all(false)}><Icon icon={faPowerOff} />全部关闭</Button>
          <Button variant="primary" onClick={() => all(true)}><Icon icon={faPowerOff} />全部开启</Button>
        </div>
      </div>
      <div className="hj-grid g4" style={{ marginBottom: 16 }}>
        <Card className="kpi"><div className="k-label">温控面板</div><div className="k-val">{rooms.length}</div><div className="k-foot">全部在线</div></Card>
        <Card className="kpi"><div className="k-label">已开启房间</div><div className="k-val green">{on.length}</div><div className="k-foot">{rooms.length - on.length} 间关闭</div></Card>
        <Card className="kpi"><div className="k-label">节能模式</div><div className="k-val" style={{ color: 'var(--amber)' }}>{eco.length}</div><div className="k-foot">间房间处于节能模式</div></Card>
        <Card className="kpi"><div className="k-label">平均室温 / 湿度</div><div className="k-val">{avgT.toFixed(1)}°<small style={{ fontSize: 17 }}>/ {Math.round(avgH)}%</small></div><div className="k-foot">平均露点 {avgD.toFixed(1)}°C</div></Card>
      </div>
      <div className="hj-grid g2">
        {rooms.map((r) => (
          <RoomCard key={r.id} r={r} selected={sel === r.id} onSelect={() => setSel(r.id)}
            onToggle={async (v) => { await setPower([r.id], v); toast(`${r.name} 已${v ? '开启' : '关闭'}`) }} />
        ))}
      </div>
      <Card style={{ marginTop: 20 }}>
        <CardHeader><div><CardTitle>温度 / 湿度 / 露点 统计</CardTitle><CardDescription>{statRoom?.name} · {range === '24小时' ? '24 小时逐时数据' : `近${range === '7日' ? ' 7 ' : ' 30 '}日日均值`}</CardDescription></div>
          <div className="row" style={{ gap: 12 }}>
            <Select value={statRoom?.id ?? ''} onValueChange={setSel}>
              <SelectTrigger aria-label="统计房间" sizer={rooms.map((r) => `${r.name} · ${r.id}`)} />
              <SelectContent>{rooms.map((r) => <SelectItem key={r.id} value={r.id}>{r.name} · {r.id}</SelectItem>)}</SelectContent>
            </Select>
            <Seg value={range} options={['24小时', '7日', '30日']} onChange={setRange} />
          </div></CardHeader>
        {stats ? <Chart option={roomChart(stats.hours?.map((h) => h.t) ?? stats.days!.map((d) => d.date), stats.hours ? stats.hours.map((h) => [h.temp, h.dew, h.hum]) : stats.days!.map((d) => [d.temp.avg, d.dew.avg, d.hum.avg]), !!stats.hours)} height={280} /> : <div style={{ height: 280 }} />}
      </Card>
    </div>
  )
}

function roomChart(xs: string[], rows: number[][], hourly: boolean) {
  return {
    tooltip,
    legend: { top: 0, left: 10, icon: 'rect', itemWidth: 22, itemHeight: 3, textStyle: { color: '#64748b', fontSize: 11 }, data: ['温度 °C', '露点 °C', '湿度 %'] },
    grid: { left: 36, right: 46, top: 38, bottom: 28 },
    xAxis: { type: 'category' as const, data: xs, boundaryGap: false, axisLabel: { ...axis.label, interval: hourly ? 2 : 'auto' as const }, axisLine: axis.line, axisTick: { show: false } },
    yAxis: [
      { type: 'value' as const, min: 10, max: 30, interval: 5, axisLabel: { ...axis.label, formatter: '{value}°' }, splitLine: axis.split },
      { type: 'value' as const, min: 30, max: 80, interval: 10, axisLabel: { ...axis.label, formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      { name: '温度 °C', type: 'line' as const, data: rows.map((r) => r[0]), smooth: true, showSymbol: false, lineStyle: { width: 2.2, color: '#f28c38' }, itemStyle: { color: '#f28c38' } },
      { name: '露点 °C', type: 'line' as const, data: rows.map((r) => r[1]), smooth: true, showSymbol: false, lineStyle: { width: 2.2, color: '#6366f1' }, itemStyle: { color: '#6366f1' } },
      { name: '湿度 %', type: 'line' as const, yAxisIndex: 1, data: rows.map((r) => r[2]), smooth: true, showSymbol: false, lineStyle: { width: 2.2, color: '#06b6d4' }, itemStyle: { color: '#06b6d4' }, areaStyle: { color: 'rgba(6,182,212,.06)' } },
    ],
  }
}

