import { useState } from 'react'
import { faMagnifyingGlass, faCircleInfo, faLayerGroup, faChevronDown, faChevronUp, faPowerOff, faWandMagicSparkles, faSnowflake, faSun, faDropletSlash, faWind, faRobot, faMinus, faDoorOpen, faTemperatureHalf, faPaperPlane, faTriangleExclamation, faCircleCheck, faSpinner, faCircleXmark, faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Icon, useAsync } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import { projectsInGroup, useDealerPick } from '../data/org'
import * as api from '../api'
import { hasRooms } from '../api'

const MODES = [['制冷', faSnowflake, '#0891b2'], ['制热', faSun, '#f97316'], ['除湿', faDropletSlash, '#10b981'], ['通风', faWind, '#0ea5e9'], ['自动', faRobot, '#8b5cf6'], ['不变', faMinus, '#94a3b8']] as const

export default function Control() {
  const { toast, confirm, scope, user } = useApp()
  const isAdmin = user.role === 'admin'
  const { projects } = scope
  // S6a：经销商默认值随列表异步到达（派生值）；经销商账号没有选择器，直接用账号范围内的全部集成项目
  const [dealerId, setDealerId] = useDealerPick(scope.dealers)
  const groups = isAdmin ? scope.groups.filter((g) => g.dealerId === dealerId) : scope.groups
  const [gidRaw, setGid] = useState('')
  const gid = groups.some((g) => g.id === gidRaw) ? gidRaw : groups[0]?.id ?? ''
  const [pq, setPq] = useState('')
  // 按 Group.projectIds 判断归属：一个项目可能属于多个集成项目
  const inGroup = projectsInGroup(groups.find((g) => g.id === gid), projects)
  const ps = inGroup.filter((p) => !pq.trim() || (p.name + p.id).toLowerCase().includes(pq.trim().toLowerCase()))
  const [picked, setPicked] = useState<string[]>(() => ['PRJ-10241', 'PRJ-10242', 'PRJ-10243', 'PRJ-10245'].filter((id) => inGroup.some((p) => p.id === id)))
  const [expand, setExpand] = useState(false)
  const [power, setPower] = useState<'开启' | '关闭' | '不变'>('开启')
  const [mode, setMode] = useState('制冷')
  const [roomSw, setRoomSw] = useState<'全部开启' | '全部关闭' | '不变'>('全部开启')
  const [temp, setTemp] = useState(26)
  const [keep, setKeep] = useState(false)
  const [last, setLast] = useAsync(() => api.getLastRun(), [])
  const [sending, setSending] = useState(false)

  const online = inGroup.filter((p) => p.online)
  const pickedP = picked.map((id) => projects.find((p) => p.id === id)!).filter(Boolean)
  const noRoomP = pickedP.filter((p) => !hasRooms(p))
  // layout follows project capability: rooms section only when at least one picked project has room settings
  const withRooms = pickedP.length === 0 ? inGroup.some(hasRooms) : noRoomP.length < pickedP.length
  const shownP = expand ? ps : ps.slice(0, 7)
  const devices = picked.reduce((s, id) => s + (projects.find((p) => p.id === id)?.devices ?? 0), 0)
  const fix = (n: number) => Math.min(30, Math.max(16, +n.toFixed(1)))

  const send = async () => {
    if (!picked.length) return toast('请至少选择一个项目', true)
    const ok = await confirm({
      title: '确认下发统一控制指令',
      body: <>将向 <b>{picked.length}</b> 个项目、共 <b>{devices}</b> 台设备下发指令，并覆盖用户本地设置：
        <div className="kv"><div><span>系统开关</span><b>{power}</b></div><div><span>运行模式</span><b>{mode}</b></div>{withRooms && <><div><span>房间开关</span><b>{roomSw}</b></div><div><span>温度设定</span><b>{keep ? '不变' : temp.toFixed(1) + '°C'}</b></div></>}</div>
        {withRooms && noRoomP.length > 0 && <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>其中 {noRoomP.length} 个新风单机版项目无房间设置，仅下发系统开关与运行模式。</div>}</>,
      okText: '确认下发', danger: true,
    })
    if (!ok) return
    setSending(true)
    const r = await api.sendUnified({ targets: picked.map((id) => ({ projectId: id, power, mode, ...(withRooms && !noRoomP.some((p) => p.id === id) ? { roomSw, temp: keep ? null : temp } : {}) })) })
    setSending(false)
    const summary = [power, mode, ...(withRooms ? [roomSw === '全部开启' ? '全部房间开启' : roomSw === '全部关闭' ? '全部房间关闭' : '房间不变', keep ? '温度不变' : temp.toFixed(1) + '°C'] : [])].join(' / ')
    const rows = picked.map((id, i) => { const p = projects.find((x) => x.id === id)!; const total = p.devices; const okN = i === 2 ? Math.round(total * 0.68) : total; return { name: p.name, id, ok: okN, total, status: okN === total ? '成功' : '执行中', note: okN === total ? '—' : '等待温控面板应答' } })
    setLast({ id: r.id, at: new Date().toTimeString().slice(0, 8), by: user.name, summary, rows })
    toast(`指令 ${r.id} 已下发至 ${picked.length} 个项目`)
    setTimeout(() => setLast({ id: r.id, at: new Date().toTimeString().slice(0, 8), by: user.name, summary, rows: rows.map((x) => ({ ...x, ok: x.total, status: '成功', note: '—' })) }), 4000)
  }

  const counts = last ? { s: last.rows.filter((r) => r.status === '成功').length, p: last.rows.filter((r) => r.status === '执行中').length, f: last.rows.filter((r) => r.status === '部分失败').length } : { s: 0, p: 0, f: 0 }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>统一控制</h1><div className="sub">对同一项目组内的多个项目批量设置开关、运行模式、房间开关及温度</div></div>
      </div>
      <div className="ctrl">
        <Card>
          <div className="step-h"><span className="sn">1</span>选择项目</div>
          {isAdmin && (
            <Select value={dealerId} onValueChange={(v) => { setDealerId(v); setGid(''); setPicked([]) }}>
              <SelectTrigger aria-label="经销商" className="mb-2.5 h-10 w-full text-foreground" />
              <SelectContent>{scope.dealers.map((d) => <SelectItem key={d.id} value={d.id}>经销商：{d.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <Icon icon={faLayerGroup} style={{ position: 'absolute', left: 14, top: 12, color: 'var(--primary)' }} />
            <Select value={gid} onValueChange={(v) => { setGid(v); setPicked([]) }}>
              <SelectTrigger aria-label="集成项目" className="h-10 w-full pl-[38px] font-medium text-foreground" />
              <SelectContent>{groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent>
            </Select>
            <span className="faint num" style={{ position: 'absolute', right: 34, top: 12, fontSize: 12, pointerEvents: 'none' }}>{gid}</span>
          </div>
          <InputGroup className="mb-[14px] h-10"><Icon icon={faMagnifyingGlass} /><InputGroupInput className="min-w-0" placeholder="按项目名称检索" value={pq} onChange={(e) => setPq(e.target.value)} /></InputGroup>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10, fontSize: 13 }}>
            <label className="row" style={{ cursor: 'pointer' }}><Checkbox checked={picked.length === online.length && online.length > 0} onCheckedChange={(v) => setPicked(v === true ? online.map((p) => p.id) : [])} />全选在线项目</label>
            <span className="muted">已选 <b className="num" style={{ color: 'var(--text)' }}>{picked.length}</b> / {inGroup.length}</span>
          </div>
          {shownP.map((p) => {
            const on = picked.includes(p.id)
            return (
              <div key={p.id} className={'pick' + (on ? ' on' : '') + (!p.online ? ' dis' : '')} onClick={() => p.online && setPicked(on ? picked.filter((x) => x !== p.id) : [...picked, p.id])}>
                <Checkbox checked={on} disabled={!p.online} aria-label={p.name} />
                <div><b>{p.name}</b><small className="num">{p.online ? `${p.id} · ${p.version}${hasRooms(p) ? '' : ' · 新风单机版'}` : '离线 · 不可下发'}</small></div>
                <span className="dot" />
              </div>
            )
          })}
          {ps.length === 0 && <div className="faint" style={{ textAlign: 'center', padding: 20, fontSize: 13 }}>没有匹配的项目</div>}
          {ps.length > 7 && <div className="c muted" style={{ fontSize: 12.5, marginTop: 10, cursor: 'pointer', textAlign: 'center' }} onClick={() => setExpand(!expand)}>{expand ? '收起' : `展开其余 ${ps.length - 7} 个项目`} <Icon icon={expand ? faChevronUp : faChevronDown} size="xs" /></div>}
        </Card>

        <Card>
          <div className="step-h"><span className="sn">2</span>设置控制指令<small>选择「不变」的项不会下发</small></div>
          <div className="sec-h"><span><Icon icon={faPowerOff} className="muted" />系统开关</span></div>
          <div className="opt3">{(['开启', '关闭', '不变'] as const).map((x) => <button key={x} className={'opt-btn' + (power === x ? ' on' : '')} onClick={() => setPower(x)}>{x}</button>)}</div>
          <div className="sec-h"><span><Icon icon={faWandMagicSparkles} className="muted" />运行模式</span></div>
          <div className="modes">{MODES.map(([m, ic, c]) => <button key={m} className={'mode' + (mode === m ? ' on' : '')} onClick={() => setMode(m)}><Icon icon={ic} style={{ color: c }} />{m}</button>)}</div>
          {withRooms ? (
            <>
              <div className="sec-h"><span><Icon icon={faDoorOpen} className="muted" />房间开关</span></div>
              <div className="opt3">{(['全部开启', '全部关闭', '不变'] as const).map((x) => <button key={x} className={'opt-btn' + (roomSw === x ? ' on' : '')} onClick={() => setRoomSw(x)}>{x}</button>)}</div>
              <div className="sec-h"><span><Icon icon={faTemperatureHalf} className="muted" />房间温度设定</span><label className="row muted" style={{ fontWeight: 400, fontSize: 12.5, cursor: 'pointer' }}><Checkbox checked={keep} onCheckedChange={(v) => setKeep(v === true)} />保持不变</label></div>
              <div className="temp-box" style={keep ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
                <div className="tv"><button className="round" onClick={() => setTemp(fix(temp - 0.5))}>−</button><b className="num">{temp.toFixed(1)}<small>°C</small></b><button className="round plus" onClick={() => setTemp(fix(temp + 0.5))}>+</button></div>
                <div className="c muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 4 }}>推荐夏季 26°C</div>
                <input type="range" min={16} max={30} step={0.5} value={temp} onChange={(e) => setTemp(+e.target.value)} />
                <div className="ticks num"><span>16°C</span><span>20°C</span><span>25°C</span><span>30°C</span></div>
              </div>
              {noRoomP.length > 0 && <div className="cap-note"><Icon icon={faCircleInfo} />已选项目中有 {noRoomP.length} 个新风单机版项目（{noRoomP.map((p) => p.name).join('、')}）无房间设置，对其仅下发系统开关与运行模式。</div>}
            </>
          ) : (
            <div className="cap-note big"><Icon icon={faCircleInfo} /><div><b>所选项目无房间设置</b><span>新风单机版项目仅支持「系统开关」与「运行模式」，房间开关与房间温度设定不可用。</span></div></div>
          )}
        </Card>

        <div className="preview">
          <div className="step-h"><span className="sn">3</span>指令预览</div>
          <div className="pv-kpi"><div><span>目标项目</span><b className="num">{picked.length}<small>个</small></b></div><div><span>影响设备</span><b className="num">{devices}<small>台</small></b></div></div>
          <div className="pv-row"><span>系统开关</span><b className={power === '不变' ? 'w' : ''}>{power}</b></div>
          <div className="pv-row"><span>运行模式</span><b className={mode === '不变' ? 'w' : ''}>{mode}</b></div>
          {withRooms ? <>
            <div className="pv-row"><span>房间开关</span><b className={roomSw === '不变' ? 'w' : ''}>{roomSw}</b></div>
            <div className="pv-row"><span>温度设定</span><b className={'num ' + (keep ? 'w' : '')}>{keep ? '不变' : temp.toFixed(1) + '°C'}</b></div>
          </> : <div className="pv-row"><span>房间设置</span><b className="w">无（新风单机版）</b></div>}
          <div className="pv-row"><span>执行方式</span><b className="w">立即执行</b></div>
          <div className="pv-warn"><Icon icon={faTriangleExclamation} /> 将覆盖所选项目内用户的本地设置，请谨慎操作。</div>
          <button className="btn-send" onClick={send} disabled={sending}><Icon icon={sending ? faSpinner : faPaperPlane} spin={sending} />{sending ? '下发中…' : '确认下发'}</button>
        </div>
      </div>

      {last && (
        <Card pad={false}>
          <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14 }}>
            <div><CardTitle>最近一次执行结果</CardTitle><CardDescription className="num">{last.id} · {last.at} · {last.by} · {last.summary}</CardDescription></div>
            <div className="row" style={{ gap: 16, fontSize: 13.5 }}>
              <span className="green"><Icon icon={faCircleCheck} /> 成功 <b>{counts.s}</b></span>
              <span className="cyan"><Icon icon={faSpinner} spin={counts.p > 0} /> 执行中 <b>{counts.p}</b></span>
              <span className="red"><Icon icon={faCircleXmark} /> 失败 <b>{counts.f}</b></span>
            </div>
          </CardHeader>
          <Table>
            <TableHeader><TableRow><TableHead>项目</TableHead><TableHead>项目ID</TableHead><TableHead>执行进度</TableHead><TableHead className="text-right">设备 成功/总数</TableHead><TableHead>状态</TableHead><TableHead>说明</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {last.rows.map((r) => {
                const pct = Math.round((r.ok / r.total) * 100)
                const c = r.status === '成功' ? 'var(--green-2)' : r.status === '执行中' ? 'var(--primary-2)' : 'var(--red)'
                return (
                  <TableRow key={r.id}>
                    <TableCell style={{ fontWeight: 500 }}>{r.name}</TableCell><TableCell className="num muted">{r.id}</TableCell>
                    <TableCell style={{ width: 290 }}><div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: pct + '%', background: c, transition: 'width .6s' }} /></div><span className="num" style={{ width: 36, fontSize: 12 }}>{pct}%</span></div></TableCell>
                    <TableCell className="num text-right" style={{ fontWeight: 600 }}>{r.ok} / {r.total}</TableCell>
                    <TableCell><Badge variant={r.status === '成功' ? 'green' : r.status === '执行中' ? 'cyan' : 'red'}>{r.status}</Badge></TableCell>
                    <TableCell className="muted">{r.note}</TableCell>
                    <TableCell className="text-right">{r.status === '部分失败' ? <Button variant="link" onClick={() => { setLast({ ...last, rows: last.rows.map((x) => (x.id === r.id ? { ...x, ok: x.total, status: '成功', note: '—' } : x)) }); toast(`${r.name} 重试成功`) }}><Icon icon={faRotateRight} /> 重试</Button> : <span className="faint">—</span>}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
