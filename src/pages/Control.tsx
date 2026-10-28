import { useState } from 'react'
import { faClock, faLayerGroup, faChevronDown, faChevronUp, faPowerOff, faWandMagicSparkles, faSnowflake, faSun, faDropletSlash, faWind, faRobot, faMinus, faDoorOpen, faTemperatureHalf, faPaperPlane, faTriangleExclamation, faCircleCheck, faSpinner, faCircleXmark, faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Card, Icon, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import { groups, projects } from '../mock/data'
import * as api from '../api'

const MODES = [['制冷', faSnowflake, '#0891b2'], ['制热', faSun, '#f97316'], ['除湿', faDropletSlash, '#10b981'], ['通风', faWind, '#0ea5e9'], ['自动', faRobot, '#8b5cf6'], ['不变', faMinus, '#94a3b8']] as const
const ROOMS = ['客厅', '主卧', '次卧', '书房', '老人房', '客卧']

export default function Control() {
  const { toast, confirm } = useApp()
  const [gid, setGid] = useState('GRP-SH-001')
  const ps = projects.filter((p) => p.groupId === gid)
  const [picked, setPicked] = useState<string[]>(['PRJ-10241', 'PRJ-10242', 'PRJ-10243', 'PRJ-10245'])
  const [expand, setExpand] = useState(false)
  const [power, setPower] = useState<'开启' | '关闭' | '不变'>('开启')
  const [mode, setMode] = useState('制冷')
  const [roomSw, setRoomSw] = useState<'全部开启' | '全部关闭' | '不变'>('全部开启')
  const [scope, setScope] = useState('全部房间')
  const [roomsSel, setRoomsSel] = useState<string[]>([])
  const [temp, setTemp] = useState(26)
  const [keep, setKeep] = useState(false)
  const [last, setLast] = useAsync(() => api.getLastRun(), [])
  const [sending, setSending] = useState(false)

  const online = ps.filter((p) => p.online)
  const shownP = expand ? ps : ps.slice(0, 8)
  const devices = picked.reduce((s, id) => s + (projects.find((p) => p.id === id)?.devices ?? 0), 0)
  const fix = (n: number) => Math.min(30, Math.max(16, +n.toFixed(1)))

  const send = async () => {
    if (!picked.length) return toast('请至少选择一个项目', true)
    const ok = await confirm({
      title: '确认下发统一控制指令',
      body: <>将向 <b>{picked.length}</b> 个项目、共 <b>{devices}</b> 台设备下发指令，并覆盖用户本地设置：
        <div className="kv"><div><span>系统开关</span><b>{power}</b></div><div><span>运行模式</span><b>{mode}</b></div><div><span>房间开关</span><b>{roomSw}{roomSw !== '不变' && scope !== '全部房间' ? `（${roomsSel.join('、') || '未选房间'}）` : ''}</b></div><div><span>温度设定</span><b>{keep ? '不变' : temp.toFixed(1) + '°C'}</b></div></div></>,
      okText: '确认下发', danger: true,
    })
    if (!ok) return
    setSending(true)
    const r = await api.sendUnified({ picked, power, mode, roomSw, temp: keep ? null : temp })
    setSending(false)
    const summary = [power, mode, roomSw === '全部开启' ? '全部房间开启' : roomSw === '全部关闭' ? '全部房间关闭' : '房间不变', keep ? '温度不变' : temp.toFixed(1) + '°C'].join(' / ')
    const rows = picked.map((id, i) => { const p = projects.find((x) => x.id === id)!; const total = p.devices; const okN = i === 2 ? Math.round(total * 0.68) : total; return { name: p.name, id, ok: okN, total, status: okN === total ? '成功' : '执行中', note: okN === total ? '—' : '等待温控面板应答' } })
    setLast({ id: r.id, at: new Date().toTimeString().slice(0, 8), by: '张建国', summary, rows })
    toast(`指令 ${r.id} 已下发至 ${picked.length} 个项目`)
    setTimeout(() => setLast({ id: r.id, at: new Date().toTimeString().slice(0, 8), by: '张建国', summary, rows: rows.map((x) => ({ ...x, ok: x.total, status: '成功', note: '—' })) }), 4000)
  }

  const counts = last ? { s: last.rows.filter((r) => r.status === '成功').length, p: last.rows.filter((r) => r.status === '执行中').length, f: last.rows.filter((r) => r.status === '部分失败').length } : { s: 0, p: 0, f: 0 }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>统一控制</h1><div className="sub">对同一项目组内的多个项目批量设置开关、运行模式、房间开关及温度</div></div>
        <button className="btn" onClick={() => toast('定时任务：工作日 07:00 开启 / 23:00 节能（2 条）')}><Icon icon={faClock} className="faint" />定时任务</button>
      </div>
      <div className="ctrl">
        <Card>
          <div className="step-h"><span className="sn">1</span>选择项目</div>
          <div style={{ position: 'relative', marginBottom: 14 }}>
            <Icon icon={faLayerGroup} style={{ position: 'absolute', left: 14, top: 12, color: 'var(--primary)' }} />
            <select className="select" style={{ width: '100%', height: 40, paddingLeft: 38, fontWeight: 500, color: 'var(--text)' }} value={gid} onChange={(e) => { setGid(e.target.value); setPicked([]) }}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <span className="faint num" style={{ position: 'absolute', right: 34, top: 12, fontSize: 12, pointerEvents: 'none' }}>{gid}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10, fontSize: 13 }}>
            <label className="row" style={{ cursor: 'pointer' }}><input type="checkbox" className="checkbox" checked={picked.length === online.length && online.length > 0} onChange={(e) => setPicked(e.target.checked ? online.map((p) => p.id) : [])} />全选在线项目</label>
            <span className="muted">已选 <b className="num" style={{ color: 'var(--text)' }}>{picked.length}</b> / {ps.length}</span>
          </div>
          {shownP.map((p) => {
            const on = picked.includes(p.id)
            return (
              <div key={p.id} className={'pick' + (on ? ' on' : '') + (!p.online ? ' dis' : '')} onClick={() => p.online && setPicked(on ? picked.filter((x) => x !== p.id) : [...picked, p.id])}>
                <input type="checkbox" className="checkbox" checked={on} disabled={!p.online} readOnly />
                <div><b>{p.name}</b><small className="num">{p.online ? `${p.id} · ${p.version}` : '离线 · 不可下发'}</small></div>
                <span className="dot" />
              </div>
            )
          })}
          {ps.length > 8 && <div className="c muted" style={{ fontSize: 12.5, marginTop: 10, cursor: 'pointer', textAlign: 'center' }} onClick={() => setExpand(!expand)}>{expand ? '收起' : `展开其余 ${ps.length - 8} 个项目`} <Icon icon={expand ? faChevronUp : faChevronDown} size="xs" /></div>}
        </Card>

        <Card>
          <div className="step-h"><span className="sn">2</span>设置控制指令<small>选择「不变」的项不会下发</small></div>
          <div className="sec-h"><span><Icon icon={faPowerOff} className="muted" />系统开关</span></div>
          <div className="opt3">{(['开启', '关闭', '不变'] as const).map((x) => <button key={x} className={'opt-btn' + (power === x ? ' on' : '')} onClick={() => setPower(x)}>{x}</button>)}</div>
          <div className="sec-h"><span><Icon icon={faWandMagicSparkles} className="muted" />运行模式</span></div>
          <div className="modes">{MODES.map(([m, ic, c]) => <button key={m} className={'mode' + (mode === m ? ' on' : '')} onClick={() => setMode(m)}><Icon icon={ic} style={{ color: c }} />{m}</button>)}</div>
          <div className="sec-h"><span><Icon icon={faDoorOpen} className="muted" />房间开关</span>
            <select className="select" style={{ height: 32, fontSize: 12.5 }} value={scope} onChange={(e) => setScope(e.target.value)}><option value="全部房间">房间范围：全部房间</option><option value="指定房间">房间范围：指定房间</option></select></div>
          <div className="opt3">{(['全部开启', '全部关闭', '不变'] as const).map((x) => <button key={x} className={'opt-btn' + (roomSw === x ? ' on' : '')} onClick={() => setRoomSw(x)}>{x}</button>)}</div>
          <div className="chips">{ROOMS.map((r) => <button key={r} className={'chip' + (scope === '指定房间' && roomsSel.includes(r) ? ' on' : '')} onClick={() => { setScope('指定房间'); setRoomsSel(roomsSel.includes(r) ? roomsSel.filter((x) => x !== r) : [...roomsSel, r]) }}>{r}</button>)}</div>
          <div className="sec-h"><span><Icon icon={faTemperatureHalf} className="muted" />房间温度设定</span><label className="row muted" style={{ fontWeight: 400, fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" className="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />保持不变</label></div>
          <div className="temp-box" style={keep ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
            <div className="tv"><button className="round" onClick={() => setTemp(fix(temp - 0.5))}>−</button><b className="num">{temp.toFixed(1)}<small>°C</small></b><button className="round plus" onClick={() => setTemp(fix(temp + 0.5))}>+</button></div>
            <div className="c muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 4 }}>推荐夏季 26°C</div>
            <input type="range" min={16} max={30} step={0.5} value={temp} onChange={(e) => setTemp(+e.target.value)} />
            <div className="ticks num"><span>16°C</span><span>20°C</span><span>25°C</span><span>30°C</span></div>
          </div>
        </Card>

        <div className="preview">
          <div className="step-h"><span className="sn">3</span>指令预览</div>
          <div className="pv-kpi"><div><span>目标项目</span><b className="num">{picked.length}<small>个</small></b></div><div><span>影响设备</span><b className="num">{devices}<small>台</small></b></div></div>
          <div className="pv-row"><span>系统开关</span><b className={power === '不变' ? 'w' : ''}>{power}</b></div>
          <div className="pv-row"><span>运行模式</span><b className={mode === '不变' ? 'w' : ''}>{mode}</b></div>
          <div className="pv-row"><span>房间开关</span><b className={roomSw === '不变' ? 'w' : ''}>{roomSw}{scope === '指定房间' && roomSw !== '不变' ? `（${roomsSel.length}间）` : ''}</b></div>
          <div className="pv-row"><span>温度设定</span><b className={'num ' + (keep ? 'w' : '')}>{keep ? '不变' : temp.toFixed(1) + '°C'}</b></div>
          <div className="pv-row"><span>执行方式</span><b className="w">立即执行</b></div>
          <div className="pv-warn"><Icon icon={faTriangleExclamation} /> 将覆盖所选项目内用户的本地设置，请谨慎操作。</div>
          <button className="btn-send" onClick={send} disabled={sending}><Icon icon={sending ? faSpinner : faPaperPlane} spin={sending} />{sending ? '下发中…' : '确认下发'}</button>
          <button className="btn-save" onClick={() => toast('已保存为场景「夏季制冷 26°C」')}>保存为场景</button>
        </div>
      </div>

      {last && (
        <Card pad={false}>
          <div className="card-head card-pad" style={{ marginBottom: 0, paddingBottom: 14 }}>
            <div><h3 className="card-title">最近一次执行结果</h3><div className="card-sub num">{last.id} · {last.at} · {last.by} · {last.summary}</div></div>
            <div className="row" style={{ gap: 16, fontSize: 13.5 }}>
              <span className="green"><Icon icon={faCircleCheck} /> 成功 <b>{counts.s}</b></span>
              <span className="cyan"><Icon icon={faSpinner} spin={counts.p > 0} /> 执行中 <b>{counts.p}</b></span>
              <span className="red"><Icon icon={faCircleXmark} /> 失败 <b>{counts.f}</b></span>
            </div>
          </div>
          <table className="table">
            <thead><tr><th>项目</th><th>项目ID</th><th>执行进度</th><th className="r">设备 成功/总数</th><th>状态</th><th>说明</th><th className="r">操作</th></tr></thead>
            <tbody>
              {last.rows.map((r) => {
                const pct = Math.round((r.ok / r.total) * 100)
                const c = r.status === '成功' ? 'var(--green-2)' : r.status === '执行中' ? 'var(--primary-2)' : 'var(--red)'
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 500 }}>{r.name}</td><td className="num muted">{r.id}</td>
                    <td style={{ width: 290 }}><div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: pct + '%', background: c, transition: 'width .6s' }} /></div><span className="num" style={{ width: 36, fontSize: 12 }}>{pct}%</span></div></td>
                    <td className="r num" style={{ fontWeight: 600 }}>{r.ok} / {r.total}</td>
                    <td><span className={'pill ' + (r.status === '成功' ? 'green' : r.status === '执行中' ? 'cyan' : 'red')}>{r.status}</span></td>
                    <td className="muted">{r.note}</td>
                    <td className="r">{r.status === '部分失败' ? <button className="link" onClick={() => { setLast({ ...last, rows: last.rows.map((x) => (x.id === r.id ? { ...x, ok: x.total, status: '成功', note: '—' } : x)) }); toast(`${r.name} 重试成功`) }}><Icon icon={faRotateRight} /> 重试</button> : <span className="faint">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
