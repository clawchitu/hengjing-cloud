import { useEffect, useState } from 'react'
import { faCircleExclamation, faTriangleExclamation, faCircleInfo, faBell, faGear, faCheckDouble, faMagnifyingGlass, faCalendar, faTemperatureArrowUp, faUserGear, faCheck, faPlugCircleXmark, faDroplet, faWrench, faWifi } from '@fortawesome/free-solid-svg-icons'
import { Card, Chart, Icon, Pager, Seg, axis, tooltip, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'
import type { Alarm } from '../api'

const LV = [
  ['紧急', '#f43f5e', faCircleExclamation], ['重要', '#f97316', faTriangleExclamation], ['一般', '#f59e0b', faCircleInfo], ['提示', '#38bdf8', faBell],
] as const
const TYPE_COLORS: Record<string, string> = { 通讯故障: '#6366f1', 环境超限: '#06b6d4', 设备故障: '#f43f5e', 结露风险: '#f97316', 维护提醒: '#fbbf24', 其他: '#cbd5e1' }
const TYPE_ICON: Record<string, typeof faWifi> = { 设备故障: faTemperatureArrowUp, 通讯故障: faPlugCircleXmark, 结露风险: faDroplet, 维护提醒: faWrench, 网络波动: faWifi }

export default function Alarms({ center }: { center?: boolean }) {
  const { projectId, project, toast, confirm, refreshAlarms } = useApp()
  const [alarms, setAlarms] = useAsync(() => api.getAlarms(projectId), [projectId])
  const [stats] = useAsync(() => api.getAlarmStats(projectId), [projectId])
  const [st, setSt] = useState<'全部' | '未处理' | '已确认' | '已恢复'>('全部')
  const [lvl, setLvl] = useState('全部级别')
  const [dtype, setDtype] = useState('全部设备类型')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [checked, setChecked] = useState<string[]>([])
  const [sel, setSel] = useState('ALM-20250618-0091')
  const [note, setNote] = useState('')
  const [history, setHistory] = useState<Record<string, { t: string; who: string; at: string }[]>>({})
  useEffect(() => { setPage(1) }, [st, lvl, dtype, q])
  if (!alarms || !stats) return <div className="page" />

  const todayA = alarms.filter((a) => a.time.startsWith('06-18'))
  const unproc = todayA.filter((a) => a.status === '未处理').length
  const list = alarms.filter((a) => (st === '全部' || a.status === st) && (lvl === '全部级别' || a.level === lvl) && (dtype === '全部设备类型' || a.deviceType === dtype) && (!q || (a.desc + a.device + a.id).toLowerCase().includes(q.toLowerCase())))
  const SIZE = 8
  const shown = list.slice((page - 1) * SIZE, page * SIZE)
  const cur = alarms.find((a) => a.id === sel) ?? alarms[0]
  const now = () => new Date().toTimeString().slice(0, 8)

  const ack = async (ids: string[], msg?: string) => {
    const next = await api.ackAlarms(ids, note)
    setAlarms(next); refreshAlarms()
    setHistory((h) => { const c = { ...h }; ids.forEach((id) => { c[id] = [...(c[id] ?? []), { t: '已确认报警' + (note ? `：${note}` : ''), who: '张建国', at: now() }] }); return c })
    setChecked([]); setNote('')
    toast(msg ?? `已确认 ${ids.length} 条报警`)
  }
  const batch = async () => {
    const ids = (checked.length ? checked : alarms.filter((a) => a.status === '未处理').map((a) => a.id)).filter((id) => alarms.find((a) => a.id === id)?.status === '未处理')
    if (!ids.length) return toast('没有可确认的未处理报警', true)
    if (await confirm({ title: '批量确认', body: <>将确认 <b>{ids.length}</b> 条未处理报警，确认后状态变为「已确认」。</>, okText: '确认' })) ack(ids)
  }
  const dispatch = async () => {
    if (!(await confirm({ title: '派单维修', body: <>将「{cur.desc}」派单给 <b>李工（华东运维中心）</b>，并通过短信 / 企业微信通知。</>, okText: '派单' }))) return
    setHistory((h) => ({ ...h, [cur.id]: [...(h[cur.id] ?? []), { t: '已派单维修 · 李工', who: '张建国', at: now() }] }))
    toast('已派单给 李工，工单 WO-20250618-027')
  }

  const trend = {
    tooltip: { ...tooltip, axisPointer: { type: 'shadow' as const } },
    legend: { top: 0, left: 40, itemWidth: 12, itemHeight: 12, itemGap: 24, textStyle: { color: '#475569', fontSize: 11 }, data: ['提示', '一般', '重要', '紧急'] },
    grid: { left: 32, right: 16, top: 46, bottom: 24 },
    xAxis: { type: 'category' as const, data: stats.trend.days, axisLabel: axis.label, axisLine: { lineStyle: { color: '#94a3b8' } }, axisTick: { show: false } },
    yAxis: { type: 'value' as const, interval: 2, max: 8, axisLabel: axis.label, splitLine: { show: false } },
    series: (['紧急', '重要', '一般', '提示'] as const).map((k) => ({ name: k, type: 'bar' as const, stack: 's', barWidth: '50%', data: stats.trend[k], itemStyle: { color: { 紧急: '#f43f5e', 重要: '#f97316', 一般: '#fbbf24', 提示: '#38bdf8' }[k] } })),
  }
  const total = stats.types.reduce((s, x) => s + x.value, 0)
  const donut = {
    tooltip: { trigger: 'item' as const },
    legend: { orient: 'vertical' as const, right: 0, top: 'middle', itemWidth: 10, itemHeight: 10, itemGap: 10, textStyle: { color: '#475569', fontSize: 11 }, data: ['通讯故障', '环境超限', '设备故障', '结露风险', '维护提醒', '其他'] },
    title: { text: `${total}`, subtext: '近7天', left: '35%', top: '38%', textAlign: 'center' as const, textStyle: { fontSize: 16, fontWeight: 700, fontFamily: 'Barlow' }, subtextStyle: { fontSize: 13, color: '#0f172a' }, itemGap: 4 },
    series: [{ type: 'pie' as const, radius: ['40%', '82%'], center: ['36%', '50%'], label: { show: false }, itemStyle: { borderColor: '#fff', borderWidth: 2 }, data: stats.types.map((t) => ({ ...t, itemStyle: { color: TYPE_COLORS[t.name] } })) }],
  }
  const lvCount = (l: string) => todayA.filter((a) => a.level === l)
  const hist = [
    { t: '报警触发', at: cur.time.slice(6), who: '', c: 'var(--red)' },
    ...(cur.status !== '已恢复' || cur.level !== '提示' ? [{ t: '短信 / 企业微信通知已发送', at: cur.time.slice(6, 12) + String(Math.min(59, +cur.time.slice(12) + 2)).padStart(2, '0'), who: '张建国、李工 · ', c: '#94a3b8' }] : []),
    ...(history[cur.id] ?? []).map((h) => ({ t: h.t, at: h.at, who: h.who + ' · ', c: 'var(--primary-2)' })),
    ...(cur.status === '已恢复' ? [{ t: '报警已自动恢复', at: '', who: '系统', c: 'var(--green-2)' }] : []),
  ]

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{center ? '报警中心' : '报警信息'}</h1><div className="sub">{project.name}<span className="sep">·</span>今日报警 <b className="num">{todayA.length}</b> 条，未处理 <b className="red num">{unproc}</b> 条</div></div>
        <div className="actions">
          <button className="btn" onClick={() => toast('报警规则：共 24 条，已启用 22 条')}><Icon icon={faGear} className="faint" />报警规则</button>
          <button className="btn primary" onClick={batch}><Icon icon={faCheckDouble} />批量确认{checked.length ? ` (${checked.length})` : ''}</button>
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 20 }}>
        {LV.map(([l, c, ic]) => {
          const xs = lvCount(l), u = xs.filter((a) => a.status === '未处理').length
          return (
            <Card key={l} className="kpi lvl-card" style={{ borderLeftColor: c, cursor: 'pointer' }}>
              <div onClick={() => { setLvl(l); setSt('全部') }}>
                <div className="k-label">{l}<Icon icon={ic} style={{ color: c, fontSize: 15 }} /></div>
                <div className="k-val">{xs.length}</div>
                <div className="k-foot" style={{ color: u ? c : undefined }}>{u ? `未处理 ${u}` : '已全部处理'}</div>
              </div>
            </Card>
          )
        })}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 20, marginBottom: 20 }}>
        <Card><h3 className="card-title" style={{ marginBottom: 8 }}>近 7 天报警趋势</h3><Chart option={trend} height={230} /></Card>
        <Card><h3 className="card-title" style={{ marginBottom: 8 }}>报警类型分布</h3><Chart option={donut} height={230} /></Card>
      </div>
      <Card pad={false} style={{ marginBottom: 20 }}>
        <div className="filters">
          <div className="search-in"><Icon icon={faMagnifyingGlass} /><input placeholder="报警描述 / 设备" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select className="select" value={lvl} onChange={(e) => setLvl(e.target.value)}><option>全部级别</option>{LV.map(([l]) => <option key={l}>{l}</option>)}</select>
          <select className="select" value={dtype} onChange={(e) => setDtype(e.target.value)}><option>全部设备类型</option>{[...new Set(alarms.map((a) => a.deviceType))].map((t) => <option key={t}>{t}</option>)}</select>
          <span className="btn" style={{ cursor: 'default' }}><Icon icon={faCalendar} className="faint" /><span className="num">2025-06-12 ~ 06-18</span></span>
          <div style={{ marginLeft: 'auto' }}><Seg value={st} options={['全部', '未处理', '已确认', '已恢复']} onChange={setSt} /></div>
        </div>
        <table className="table alarm-table">
          <thead><tr><th style={{ width: 40 }}><input type="checkbox" className="checkbox" checked={shown.length > 0 && shown.every((a) => checked.includes(a.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...shown.map((a) => a.id)])] : checked.filter((id) => !shown.some((a) => a.id === id)))} /></th><th>级别</th><th>报警时间</th><th>设备</th><th>报警类型</th><th>描述</th><th>状态</th><th className="r">操作</th></tr></thead>
          <tbody>
            {shown.map((a: Alarm) => (
              <tr key={a.id} className={a.id === sel ? 'sel' : ''} onClick={() => setSel(a.id)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" className="checkbox" checked={checked.includes(a.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, a.id] : checked.filter((x) => x !== a.id))} /></td>
                <td><span className={'lvl ' + a.level}>{a.level}</span></td>
                <td className="num">{a.time}</td><td className="num">{a.device}</td><td>{a.type}</td><td>{a.desc}</td>
                <td><span className="row" style={{ gap: 5, fontSize: 12.5, color: a.status === '未处理' ? 'var(--red-2)' : a.status === '已确认' ? '#d97706' : 'var(--green)' }}><span className="dot" style={{ width: 9, height: 9 }} />{a.status}</span></td>
                <td className="r" onClick={(e) => e.stopPropagation()}>{a.status === '未处理' ? <button className="link" onClick={() => ack([a.id], `${a.id} 已确认`)}>确认</button> : <button className="link" style={{ color: 'var(--faint)', fontWeight: 400 }} onClick={() => setSel(a.id)}>详情</button>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="c faint" style={{ padding: 40 }}>暂无符合条件的报警</td></tr>}
          </tbody>
        </table>
        <Pager total={list.length} page={page} size={SIZE} onPage={setPage} />
      </Card>
      <Card pad={false} className="detail">
        <div>
          <div className="dh">
            <div className="dico"><Icon icon={TYPE_ICON[cur.type] ?? faBell} /></div>
            <div>
              <div className="row"><span className={'lvl ' + cur.level}>{cur.level}</span><span className="faint num" style={{ fontSize: 12 }}>{cur.id}</span></div>
              <h3>{cur.desc}</h3><div className="muted num" style={{ fontSize: 12 }}>{cur.device} · {cur.type}</div>
            </div>
          </div>
          <div className="vals"><div className="hot"><span>当前值</span><b className="num">{cur.current}</b></div><div><span>报警阈值</span><b className="num">{cur.threshold}</b></div></div>
          <b style={{ fontSize: 13.5 }}>处理建议</b>
          <ul className="tips">{cur.tips?.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
        <div>
          <b style={{ fontSize: 13.5, display: 'block', marginBottom: 14 }}>处理记录</b>
          <div className="timeline">
            {hist.map((h, i) => <div className="tl-item" key={i}><span className="tdot" style={{ background: h.c }} /><b style={{ fontWeight: 500 }}>{h.t}</b><small className="num">{h.who}{h.at}</small></div>)}
            {cur.status === '未处理' && <div className="tl-item"><span className="tdot" style={{ background: '#fff', border: '2px solid #cbd5e1' }} /><span className="faint">等待确认…</span></div>}
          </div>
        </div>
        <div>
          <b style={{ fontSize: 13.5 }}>处理说明</b>
          <textarea className="note" placeholder="填写处理说明（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="grid g2" style={{ gap: 10 }}>
            <button className="btn lg" onClick={dispatch}><Icon icon={faUserGear} />派单维修</button>
            <button className="btn primary lg" style={{ boxShadow: 'none' }} disabled={cur.status !== '未处理'} onClick={() => ack([cur.id], '报警已确认')}><Icon icon={faCheck} />{cur.status === '未处理' ? '确认报警' : cur.status}</button>
          </div>
        </div>
      </Card>
    </div>
  )
}
