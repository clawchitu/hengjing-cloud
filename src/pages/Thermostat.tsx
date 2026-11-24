// 房间温控面板（S9）。读：ctrl 200（15 秒刷新）、209 统计；写：201 单房间设置 / 开关、206 全部开关。
// 下发一律经 src/features/thermostat/source.ts → src/api/ctrl.ts 的 writeCtrl()（S4 统一写入口 + 写防护）；
// 每次下发前在真正发起下发的组件里用 useConfirm() 确认（docs/分工.md 第 3 节第 7 条），确认后、调写入口前再判空当前项目。
// 交互依据 docs/design/thermostat-edit.md：温度 −/+ 与节能开关只改草稿，同一房间合并成一条 201；风速只读；设定湿度去除。
import { useLayoutEffect, useRef, useState } from 'react'
import { faPowerOff, faLeaf, faFan, faPlugCircleXmark } from '@fortawesome/free-solid-svg-icons'
import { Chart, Icon, Seg, axis, tooltip } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { showToast, useConfirm } from '../app/feedback'
import { useCapabilities, useCurrentProject, type Project } from '../data/org'
import { isApiError } from '../api/errors'
import type { WriteQuery } from '../api/ctrl'
import { PROGRAMS } from '../data/constants'
import {
  buildRoomSet, buildRoomSwitch, canStep, describeChanges, describeResult, draftChanges, ecoLabel, editBlock, fmtTemp,
  hasDraftChanges, resolveTempRange, stepTemp, summarize, switchBlock, thermostatSource, useRefreshRooms, useRooms,
  useRoomStats, windLabel, type ChartData, type EndMode, type RoomDraft, type RoomView, type StatsRange, type TempRange,
} from '../features/thermostat'

const fmt1 = (v: number | null) => (v === null ? '--' : v.toFixed(1))

function EndTag({ m, dim }: { m: EndMode; dim?: boolean }) {
  // 改动文档：is_selected 选中蓝色、未选中灰色；后面的「开 / 关」取该末端的 switch
  return (
    <Badge variant={m.selected ? 'blue' : 'gray'} style={dim ? { opacity: 0.8 } : undefined} data-selected={m.selected}>
      {!dim && <span className="dot" style={{ width: 5, height: 5, color: m.on ? 'var(--green-2)' : '#cbd5e1' }} />}{m.name} {m.on ? '开' : '关'}
    </Badge>
  )
}

/** 一次下发后卡片里的结果条（失败 / 结果未知） */
type Result = { kind: 'fail' | 'unknown'; text: string }

interface RoomCardProps {
  room: RoomView
  online: boolean
  range: TempRange
  selected: boolean
  onSelect: () => void
  draft: RoomDraft | null
  onEdit: (patch: Omit<RoomDraft, 'key'>) => void
  onDiscard: () => void
  /** 全页同一时间只允许一个下发；sending 为正在下发的房间键（或 'all'） */
  sending: string | null
  setSending: (k: string | null) => void
  refresh: () => Promise<void>
}

function RoomCard({ room: r, online, range, selected, onSelect, draft, onEdit, onDiscard, sending, setSending, refresh }: RoomCardProps) {
  // 确认与当前项目都在真正发起下发的这个组件里取：卸载、离开、换项目时确认按取消结算
  const confirm = useConfirm()
  const { project } = useCurrentProject()
  const latest = useRef<Project | null>(project)
  useLayoutEffect(() => { latest.current = project })
  const [result, setResult] = useState<Result | null>(null)

  const off = !r.on
  const block = editBlock(r, online)
  const swBlock = switchBlock(r, online)
  const mine = sending === r.key
  const busy = sending !== null
  const changes = draftChanges(r, draft)
  const dirty = hasDraftChanges(changes)
  const shownTemp = draft?.temp ?? r.setTemp
  const shownEco = draft?.eco ?? r.eco
  const canEdit = !block && !busy

  /** 经写入口下发一条 201；resolve 即 success=true（面板已生效） */
  async function write(query: WriteQuery<201>, okText: string, fromDraft: boolean) {
    const p = latest.current
    // 写入口前判空（docs/分工.md 第 3 节第 6 条）：确认期间项目没了 / 换了就不下发
    if (!p || !p.id || !project || p.id !== project.id) { showToast('当前项目已变化，未下发', true); return }
    setSending(r.key)
    setResult(null)
    try {
      await thermostatSource().setRoom(p, query)
      showToast(okText)
      if (fromDraft) onDiscard()
    } catch (e) {
      const err = isApiError(e) ? e : null
      const msg = err?.message || (e instanceof Error ? e.message : '') || '下发失败'
      if (err && (err.kind === 'timeout' || err.kind === 'network')) {
        // 结果未知：可能已经到达控制屏。不自动重试；保留草稿供用户核对后手动重试
        setResult({ kind: 'unknown', text: `${msg}。已重新读取面板当前值，请核对后再决定是否重试。` })
      } else {
        // 失败：草稿回退为面板当前值
        setResult({ kind: 'fail', text: err?.kind === 'write_blocked' ? `未下发：${msg}` : `下发失败：${msg}` })
        if (fromDraft) onDiscard()
      }
      showToast(`${r.name} 下发失败：${msg}`, true)
    } finally {
      setSending(null)
      void refresh()
    }
  }

  async function send() {
    if (busy) return
    const built = buildRoomSet(r, draft, online, range)
    if (!built.ok) { showToast(built.reason, true); return }
    const desc = describeChanges(changes)
    const done = describeResult(changes)
    const ok = await confirm({ title: '下发房间设置', body: <>将向 <b>{project?.name}</b> 的「{r.name}」下发：{desc}，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    await write(built.query, `${r.name} 已下发：${done}`, true)
  }

  async function toggle(v: boolean) {
    if (busy || swBlock || dirty) return
    const ok = await confirm({ title: v ? '开启房间' : '关闭房间', body: <>将向 <b>{project?.name}</b> 的「{r.name}」下发「{v ? '开启' : '关闭'}」指令，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    await write(buildRoomSwitch(r, v), `${r.name} 已${v ? '开启' : '关闭'}`, false)
  }

  const step = (dir: 1 | -1) => { if (canEdit && shownTemp !== null) onEdit({ temp: stepTemp(shownTemp, dir, range) }) }

  return (
    <Card pad={false} className={'room' + (selected ? ' sel' : '') + (off ? ' off' : '') + (mine ? ' busy' : '')} onClick={onSelect} data-room={r.key}>
      <div className="room-top">
        <div><div className="room-name">{r.name}</div><div className="room-id num">{r.key}{r.mode && ` · ${r.mode}`}</div></div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          {!r.connected ? <Badge variant="red"><Icon icon={faPlugCircleXmark} />面板离线</Badge>
            : off ? <Badge variant="gray">已关闭</Badge>
            : r.eco === 1 ? <Badge variant="amber"><Icon icon={faLeaf} />节能</Badge>
            : <Badge variant="gray" style={{ color: 'var(--muted)' }}>标准</Badge>}
          <Switch checked={r.on} onCheckedChange={(v) => void toggle(v)} disabled={busy || !!swBlock || dirty} title={swBlock ?? undefined}
            className="disabled:cursor-not-allowed disabled:opacity-50" aria-label={`${r.name} 开关`} />
        </div>
      </div>
      <div className="room-lbl">室内温度</div>
      <div className="room-mid">
        <div className="room-temp num">{fmt1(r.temp)}<small>°C</small></div>
        {/* 65536（无数据）的项隐藏 */}
        <div className="room-hd num">
          {r.humidity !== null && <>湿度 <b>{Math.round(r.humidity)}%</b></>}
          {r.humidity !== null && r.dew !== null && <br />}
          {r.dew !== null && <>露点 <b>{r.dew.toFixed(1)}°C</b></>}
        </div>
      </div>
      <div className="room-sets" onClick={(e) => e.stopPropagation()}>
        <div className={changes.temp ? 'dirty' : undefined}>
          <span>设定温度{changes.temp && <span className="te-old num">原 <s>{fmtTemp(changes.temp[0])}</s></span>}</span>
          <div className="te-line"><div className="te-step">
            <button type="button" aria-label={`${r.name} 设定温度降低`} title={block ?? undefined}
              disabled={!canEdit || shownTemp === null || !canStep(shownTemp, -1, range)} onClick={() => step(-1)}>−</button>
            <div className="v num" aria-label={`${r.name} 设定温度`}>{shownTemp === null ? '--' : fmtTemp(shownTemp)}<small>°C</small></div>
            <button type="button" aria-label={`${r.name} 设定温度升高`} title={block ?? undefined}
              disabled={!canEdit || shownTemp === null || !canStep(shownTemp, 1, range)} onClick={() => step(1)}>+</button>
          </div></div>
        </div>
        <div className={changes.eco ? 'dirty' : undefined}>
          <span>节能模式{changes.eco && <span className="te-old">原 <s>{ecoLabel(changes.eco[0])}</s></span>}</span>
          <div className="te-line">
            <b>{shownEco === null ? '--' : ecoLabel(shownEco)}</b>
            <Switch checked={shownEco === 1} disabled={!canEdit || shownEco === null} title={block ?? undefined}
              className="disabled:cursor-not-allowed disabled:opacity-50"
              onCheckedChange={(v) => onEdit({ eco: v ? 1 : 0 })} aria-label={`${r.name} 节能模式`} />
          </div>
        </div>
        <div><span>风速</span><div className="te-line"><b>{off ? '--' : windLabel(r.windSpeed)}</b></div></div>
      </div>
      <div className="modes-row">
        {r.endModes.map((m, i) => <EndTag key={`${m.type}:${m.name}:${i}`} m={m} dim={off} />)}
      </div>
      {mine ? (
        <div className="te-bar sending" role="status" onClick={(e) => e.stopPropagation()}>
          <span>正在下发到控制屏{dirty ? `：${describeResult(changes)}` : ''} …</span>
          <Button variant="primary" disabled>下发中</Button>
        </div>
      ) : dirty ? (
        <div className="te-bar pending" onClick={(e) => e.stopPropagation()}>
          <span>待下发：<b className="num">{describeChanges(changes)}</b></span>
          <span className="row">
            <Button onClick={onDiscard} disabled={busy}>取消</Button>
            <Button variant="primary" onClick={() => void send()} disabled={busy || !!block}>下发</Button>
          </span>
        </div>
      ) : null}
      {result && !mine && (
        <div className="te-bar fail" role="alert" onClick={(e) => e.stopPropagation()}>
          <span>{result.text}</span>
          <span className="row">
            <Button onClick={() => setResult(null)}>知道了</Button>
            {result.kind === 'unknown' && dirty && <Button onClick={() => void send()} disabled={busy || !!block}>重试</Button>}
          </span>
        </div>
      )}
    </Card>
  )
}

function Empty({ project, title, children }: { project: Project; title: string; children: React.ReactNode }) {
  return (
    <div className="page">
      <div className="page-head"><div><h1>房间温控面板</h1><div className="sub">{project.name}</div></div></div>
      <Card className="placeholder">
        <div className="ph-ico"><Icon icon={faFan} /></div>
        <h3>{title}</h3>
        <p>{children}</p>
      </Card>
    </div>
  )
}

export default function Thermostat() {
  const { project } = useCurrentProject()
  const caps = useCapabilities(project)
  // 全部开关（206）与「放弃草稿」的确认在本组件发起
  const confirm = useConfirm()
  const latest = useRef<Project | null>(project)
  useLayoutEffect(() => { latest.current = project })
  const rooms = useRooms(project, caps.thermostat)
  const refresh = useRefreshRooms(project)
  const [sel, setSel] = useState('')
  const [range, setRange] = useState<StatsRange>('24小时')
  const [rawDraft, setDraft] = useState<RoomDraft | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const list = rooms.data
  const statRoom = list?.find((r) => r.key === sel) ?? list?.[0]
  const stats = useRoomStats(project, statRoom, range, caps.thermostat)
  // 后端以后在接口里给设定范围，现在回退 16 / 30 / 0.5
  const tempRange = resolveTempRange(null)
  const online = project?.online === true
  const real = thermostatSource().kind === 'real'

  // 草稿所在房间已不存在或已不能设置（被关闭、面板离线、项目离线）：草稿作废（按无草稿渲染，也不会下发）
  const draftRoom = rawDraft && list?.find((x) => x.key === rawDraft.key)
  const draft = draftRoom && !editBlock(draftRoom, online) ? rawDraft : null

  if (!project) return <div className="page"><div className="empty-fav" role="status"><b>暂无可用项目</b></div></div>
  if (!caps.thermostat) return (
    <div className="page">
      <div className="page-head"><div><h1>房间温控面板</h1><div className="sub">{project.name}<span className="sep">·</span>程序 {PROGRAMS[project.programCode] ?? project.appName}（编码 <span className="num">{project.programCode}</span>）</div></div></div>
      <Card className="placeholder">
        <div className="ph-ico"><Icon icon={faFan} /></div>
        <h3>该项目无房间温控面板</h3>
        <p>「{project.name}」为<b>新风单机版</b>项目（程序编码 {project.programCode}），仅接入新风除湿机，不包含房间温控面板。<br />新风机的运行数据与运行设置请前往「新风除湿机」查看。</p>
      </Card>
    </div>
  )
  // 真实接口：项目离线不读控制屏（一定是 503），显示空态而不是旧数据
  if (real && !online) return <Empty project={project} title="控制屏未连接">项目离线，无法读取房间温控面板。项目恢复在线后自动刷新。</Empty>
  if (rooms.isError && !list) {
    const e = rooms.error
    if (isApiError(e) && e.kind === 'unavailable') return <Empty project={project} title="控制屏未连接">控制屏当前不在线，无法读取房间温控面板。</Empty>
    return (
      <Empty project={project} title="房间温控数据读取失败">
        {isApiError(e) ? e.message : '读取失败'}<br /><Button style={{ marginTop: 14 }} onClick={() => void rooms.refetch()}>重试</Button>
      </Empty>
    )
  }
  if (!list) return <div className="page" />
  if (list.length === 0) return <Empty project={project} title="未读到房间温控面板">控制屏没有返回房间温控面板数据。</Empty>

  const sum = summarize(list)
  const busy = sending !== null

  const onEdit = async (key: string, patch: Omit<RoomDraft, 'key'>) => {
    if (draft && draft.key !== key) {
      const other = list.find((x) => x.key === draft.key)
      if (other && hasDraftChanges(draftChanges(other, draft))) {
        const ok = await confirm({ title: '放弃未下发的修改', body: <>「{other.name}」还有未下发的修改（{describeChanges(draftChanges(other, draft))}），放弃并改为修改「{list.find((x) => x.key === key)?.name}」？</>, okText: '放弃修改' })
        if (!ok) return
      }
      setDraft({ key, ...patch })
      return
    }
    setDraft({ ...(draft && draft.key === key ? draft : { key }), ...patch })
  }

  const all = async (v: boolean) => {
    if (busy || !online) return
    const ok = await confirm({ title: v ? '全部开启' : '全部关闭', body: <>将向 <b>{project.name}</b> 的 {list.length} 个温控面板下发「{v ? '开启' : '关闭'}」指令，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    // 写入口前判空：确认期间项目没了 / 换了就不下发
    const p = latest.current
    if (!p || !p.id || p.id !== project.id) { showToast('当前项目已变化，未下发', true); return }
    setSending('all')
    try {
      await thermostatSource().setAll(p, v)
      showToast(`已下发：全部${v ? '开启' : '关闭'}（${list.length} 个房间）`)
    } catch (e) {
      showToast(`全部${v ? '开启' : '关闭'}下发失败：${(isApiError(e) || e instanceof Error) ? e.message : '未知错误'}`, true)
    } finally {
      setSending(null)
      void refresh()
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>房间温控面板</h1>
          <div className="sub">{project.name}<span className="sep">·</span>{list.length} 个房间温控面板<span className="sep">·</span>设定温度与节能模式可在卡片内直接修改</div>
        </div>
        <div className="actions">
          <Button onClick={() => void all(false)} disabled={busy || !online}><Icon icon={faPowerOff} />全部关闭</Button>
          <Button variant="primary" onClick={() => void all(true)} disabled={busy || !online}><Icon icon={faPowerOff} />全部开启</Button>
        </div>
      </div>
      <div className="hj-grid g4" style={{ marginBottom: 16 }}>
        <Card className="kpi"><div className="k-label">温控面板</div><div className="k-val">{sum.total}</div><div className="k-foot">{sum.connected === sum.total ? '全部在线' : `${sum.total - sum.connected} 个面板离线`}</div></Card>
        <Card className="kpi"><div className="k-label">已开启房间</div><div className="k-val green">{sum.on}</div><div className="k-foot">{sum.total - sum.on} 间关闭</div></Card>
        <Card className="kpi"><div className="k-label">节能模式</div><div className="k-val" style={{ color: 'var(--amber)' }}>{sum.eco}</div><div className="k-foot">间房间处于节能模式</div></Card>
        <Card className="kpi"><div className="k-label">平均室温 / 湿度</div><div className="k-val">{sum.avgTemp === null ? '--' : sum.avgTemp.toFixed(1)}°<small style={{ fontSize: 17 }}>/ {sum.avgHumidity === null ? '--' : Math.round(sum.avgHumidity)}%</small></div><div className="k-foot">平均露点 {fmt1(sum.avgDew)}°C</div></Card>
      </div>
      <div className="hj-grid g2">
        {list.map((r) => (
          <RoomCard key={r.key} room={r} online={online} range={tempRange} selected={statRoom?.key === r.key} onSelect={() => setSel(r.key)}
            draft={draft?.key === r.key ? draft : null} onEdit={(patch) => void onEdit(r.key, patch)} onDiscard={() => setDraft((d) => (d?.key === r.key ? null : d))}
            sending={sending} setSending={setSending} refresh={refresh} />
        ))}
      </div>
      <Card style={{ marginTop: 20 }}>
        <CardHeader><div><CardTitle>温度 / 湿度 / 露点 统计</CardTitle><CardDescription>{statRoom?.name} · {range === '24小时' ? '24 小时逐时数据' : `近${range === '7日' ? ' 7 ' : ' 30 '}日日均值`}</CardDescription></div>
          <div className="row" style={{ gap: 12 }}>
            <Select value={statRoom?.key ?? ''} onValueChange={setSel}>
              <SelectTrigger aria-label="统计房间" sizer={list.map((r) => `${r.name} · ${r.key}`)} />
              <SelectContent>{list.map((r) => <SelectItem key={r.key} value={r.key}>{r.name} · {r.key}</SelectItem>)}</SelectContent>
            </Select>
            <Seg value={range} options={['24小时', '7日', '30日']} onChange={setRange} />
          </div></CardHeader>
        {stats.data ? <Chart option={roomChart(stats.data)} height={280} /> : <div style={{ height: 280 }} />}
      </Card>
    </div>
  )
}

function roomChart({ xs, rows, hourly }: ChartData) {
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
