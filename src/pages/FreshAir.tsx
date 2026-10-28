import { useEffect, useState } from 'react'
import { faFan, faTemperatureHalf, faDroplet, faTemperatureLow, faPaperPlane, faRotate, faSignal } from '@fortawesome/free-solid-svg-icons'
import { Card, Chart, Icon, Seg, Toggle, axis, tooltip, useAsync, useClock } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'
import type { FreshAir as FA } from '../api'

const statusText = (f: FA) => (f.status === 'run' ? ['运行中', 'green'] : f.status === 'filter' ? ['滤网待更换', 'orange'] : ['已关机', 'faint'])

function Ring({ pct }: { pct: number }) {
  const r = 52, c = 2 * Math.PI * r
  const color = pct < 15 ? '#f43f5e' : pct < 50 ? '#f59e0b' : '#10b981'
  return (
    <svg width="132" height="132" viewBox="0 0 132 132">
      <circle cx="66" cy="66" r={r} stroke="#eef2f6" strokeWidth="11" fill="none" />
      <circle cx="66" cy="66" r={r} stroke={color} strokeWidth="11" fill="none" strokeLinecap="round"
        strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 66 66)" style={{ transition: 'stroke-dasharray .6s' }} />
      <text x="66" y="68" textAnchor="middle" fontSize="27" fontWeight="700" fontFamily="Barlow" fill="#0f172a">{pct}%</text>
      <text x="66" y="88" textAnchor="middle" fontSize="11" fill="#94a3b8">剩余</text>
    </svg>
  )
}

export default function FreshAir() {
  const { projectId, project, toast, confirm } = useApp()
  const clock = useClock()
  const [units, setUnits] = useAsync(() => api.getFreshAir(projectId), [projectId])
  const [cur, setCur] = useState('FA-01')
  const [range, setRange] = useState<'24小时' | '7天' | '30天'>('24小时')
  const [hist] = useAsync(() => api.freshAirHistory(range === '24小时' ? '24h' : range === '7天' ? '7d' : '30d'), [range])
  const u = units?.find((x) => x.id === cur)
  // editable draft of run settings
  const [draft, setDraft] = useState<Pick<FA, 'on' | 'control' | 'dewSet' | 'humSet' | 'fan'> | null>(null)
  useEffect(() => { if (u) setDraft({ on: u.on, control: u.control, dewSet: u.dewSet, humSet: u.humSet, fan: u.fan }) }, [cur, !!u]) // eslint-disable-line

  // live random walk every 3s
  useEffect(() => {
    const t = setInterval(() => {
      setUnits(
        (units ?? []).map((f) => f.on ? {
          ...f,
          supplyTemp: api.walk(f.supplyTemp, 0.15, 16.5, 21),
          supplyHum: api.walk(f.supplyHum, 0.8, 52, 70, 0),
          supplyDew: api.walk(f.supplyDew, 0.1, 9.5, 13),
          returnTemp: api.walk(f.returnTemp, 0.1, 24, 27),
          rpm: Math.round(api.walk(f.rpm, 12, f.rpm - 30, f.rpm + 30, 0)),
        } : f),
      )
    }, 3000)
    return () => clearInterval(t)
  }, [units, setUnits])

  if (!units || !u || !draft) return <div className="page" />
  const [st, stc] = statusText(u)

  const send = async () => {
    const body = (
      <>
        即将向 <b>{u.name}</b> 下发以下运行设置：
        <div className="kv">
          <div><span>开关</span><b>{draft.on ? '开启' : '关闭'}</b></div>
          <div><span>控制类型</span><b>{draft.control === 'dew' ? `露点控制 · ${draft.dewSet.toFixed(1)}°C` : `湿度控制 · ${draft.humSet}%RH`}</b></div>
          <div><span>风速</span><b>{draft.fan}</b></div>
        </div>
      </>
    )
    if (!(await confirm({ title: '确认下发设置', body, okText: '确认下发' }))) return
    const next = await api.applyFreshAir(u.id, { ...draft, status: draft.on ? (u.status === 'off' ? 'run' : u.status) : 'off', rpm: draft.on ? ({ 低: 980, 中: 1350, 高: 1720 })[draft.fan] : 0 })
    setUnits(next)
    toast(`${u.name} 设置已下发成功`)
  }

  const dewOn = draft.control === 'dew'
  const step = (k: 'dewSet' | 'humSet', d: number) => setDraft((s) => {
    if (!s) return s
    const v = k === 'dewSet' ? Math.min(16, Math.max(8, +(s.dewSet + d).toFixed(1))) : Math.min(70, Math.max(35, s.humSet + d))
    return { ...s, [k]: v }
  })

  const opt = {
    tooltip,
    legend: { top: 0, left: 10, icon: 'rect', itemWidth: 22, itemHeight: 3, textStyle: { color: '#64748b', fontSize: 11 }, data: ['温度 °C', '露点 °C', '湿度 %'] },
    grid: { left: 36, right: 46, top: 38, bottom: 28 },
    xAxis: { type: 'category' as const, data: hist?.labels ?? [], boundaryGap: false, axisLabel: { ...axis.label, interval: range === '24小时' ? 2 : 'auto' as const }, axisLine: axis.line, axisTick: { show: false } },
    yAxis: [
      { type: 'value' as const, min: 5, max: 25, interval: 5, axisLabel: { ...axis.label, formatter: '{value}°' }, splitLine: axis.split },
      { type: 'value' as const, min: 30, max: 80, interval: 10, axisLabel: { ...axis.label, formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      { name: '温度 °C', type: 'line' as const, data: hist?.temp, smooth: true, showSymbol: false, lineStyle: { width: 2.2, color: '#f28c38' }, itemStyle: { color: '#f28c38' } },
      { name: '露点 °C', type: 'line' as const, data: hist?.dew, smooth: true, showSymbol: false, lineStyle: { width: 2.2, color: '#6366f1' }, itemStyle: { color: '#6366f1' } },
      { name: '湿度 %', type: 'line' as const, yAxisIndex: 1, data: hist?.hum, smooth: true, showSymbol: false, lineStyle: { width: 2.2, color: '#06b6d4' }, itemStyle: { color: '#06b6d4' }, areaStyle: { color: 'rgba(6,182,212,.06)' } },
    ],
  }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>新风除湿机</h1><div className="sub">{project.name}<span className="sep">·</span>{units.length} 台新风除湿一体机</div></div>
        <div className="muted" style={{ fontSize: 12, marginTop: 24 }}><Icon icon={faRotate} /> 实时刷新 · <span className="num">{clock}</span></div>
      </div>
      <div className="dev-tabs">
        {units.map((f) => {
          const [t, c] = statusText(f)
          return (
            <div key={f.id} className={'dev-tab' + (f.id === cur ? ' on' : '')} onClick={() => setCur(f.id)}>
              <div className="di"><Icon icon={faFan} /></div>
              <div><b className="num">{f.name}</b><small className={c}>{t} · {f.floor}</small></div>
            </div>
          )
        })}
      </div>

      <div className="fa-top">
        <Card>
          <div className="card-head"><h3 className="card-title">实时数据 · <span className="num">{u.name}</span></h3><span className={'pill ' + (u.status === 'off' ? 'gray' : u.status === 'filter' ? 'orange' : 'green')}><span className="dot" />{st}</span></div>
          <div className="live3">
            <div className="live-c t"><div className="lh"><Icon icon={faTemperatureHalf} style={{ color: '#f97316' }} />送风温度</div><div className="lv num">{u.supplyTemp.toFixed(1)}<small>°C</small></div><div className="lf">回风 {u.returnTemp.toFixed(1)}°C ·<br />新风 {u.freshTemp.toFixed(1)}°C</div></div>
            <div className="live-c h"><div className="lh"><Icon icon={faDroplet} style={{ color: '#06b6d4' }} />送风湿度</div><div className="lv num">{u.supplyHum}<small>%RH</small></div><div className="lf">回风 {u.returnHum}% · 新<br />风 {u.freshHum}%</div></div>
            <div className="live-c d"><div className="lh"><Icon icon={faTemperatureLow} style={{ color: '#6366f1' }} />送风露点</div><div className="lv num">{u.supplyDew.toFixed(1)}<small>°C</small></div><div className="lf">目标 ≤ {u.dewSet.toFixed(1)}°C</div></div>
            <div className="ring-card"><Ring pct={u.filter} /><b>滤网寿命</b><small>已运行 {u.filterHours.toLocaleString()} h / 预计 {u.filterDays} 天</small></div>
          </div>
          <div className="mini4">
            <div><span>当前控制类型</span><b>{u.control === 'dew' ? '露点控制' : '湿度控制'}</b></div>
            <div><span>当前风速</span><b className="num">{u.on ? `${u.fan}速 · ${u.rpm.toLocaleString()} rpm` : '--'}</b></div>
            <div><span>新风量</span><b className="num">{u.airflow} m³/h</b></div>
            <div><span>除湿压缩机</span><b className={u.compressor ? 'green num' : 'faint'}>{u.compressor ? `运行 · ${u.hz} Hz` : '停止'}</b></div>
          </div>
        </Card>

        <Card className="set-panel">
          <div className="card-head" style={{ marginBottom: 12 }}><h3 className="card-title">运行设置</h3><span className="row muted" style={{ fontSize: 13 }}>开关 <Toggle on={draft.on} onChange={(v) => setDraft({ ...draft, on: v })} /></span></div>
          <h4>控制类型设置</h4><div className="faint" style={{ fontSize: 11.5 }}>露点设定与湿度设定二选一</div>
          <div className="ctl-type">
            <button className={'opt-btn' + (dewOn ? ' on' : '')} onClick={() => setDraft({ ...draft, control: 'dew' })}><Icon icon={faTemperatureLow} />露点控制</button>
            <button className={'opt-btn' + (!dewOn ? ' on' : '')} onClick={() => setDraft({ ...draft, control: 'hum' })}><Icon icon={faDroplet} />湿度控制</button>
          </div>
          <div className={'setbox' + (dewOn ? ' on' : ' dis')}>
            <div className="sh"><div><b>露点设定值</b><small>范围 8.0 – 16.0 °C</small></div>{dewOn ? <span className="pill" style={{ background: 'var(--primary-2)', color: '#fff' }}>生效中</span> : <span className="pill gray">未启用</span>}</div>
            <div className="stepper"><button disabled={!dewOn} onClick={() => step('dewSet', -0.5)}>−</button><span className="sv num">{draft.dewSet.toFixed(1)}<small>°C</small></span><button className="plus" disabled={!dewOn} onClick={() => step('dewSet', 0.5)}>+</button></div>
          </div>
          <div className={'setbox' + (!dewOn ? ' on' : ' dis')}>
            <div className="sh"><div><b>湿度设定值</b><small>范围 35 – 70 %RH</small></div>{!dewOn ? <span className="pill" style={{ background: 'var(--primary-2)', color: '#fff' }}>生效中</span> : <span className="pill gray">未启用</span>}</div>
            <div className="stepper"><button disabled={dewOn} onClick={() => step('humSet', -1)}>−</button><span className="sv num">{draft.humSet}<small>%</small></span><button className="plus" disabled={dewOn} onClick={() => step('humSet', 1)}>+</button></div>
          </div>
          <h4 style={{ marginTop: 16 }}>风速设定</h4>
          <div className="fan3">
            {(['低', '中', '高'] as const).map((f) => <button key={f} className={'opt-btn' + (draft.fan === f ? ' on' : '')} onClick={() => setDraft({ ...draft, fan: f })}><Icon icon={faSignal} style={{ fontSize: 11 }} />{f}</button>)}
          </div>
          <button className="btn primary block lg" onClick={send}><Icon icon={faPaperPlane} />下发设置</button>
        </Card>
      </div>

      <Card style={{ marginBottom: 20 }}>
        <div className="card-head"><div><h3 className="card-title">温度 / 湿度 / 露点 统计</h3><div className="card-sub">{u.name} · 送风参数</div></div><Seg value={range} options={['24小时', '7天', '30天']} onChange={setRange} /></div>
        <Chart option={opt} height={280} />
      </Card>

      <Card pad={false}>
        <div className="card-pad" style={{ paddingBottom: 14 }}><h3 className="card-title">设备汇总</h3></div>
        <table className="table">
          <thead><tr><th>设备</th><th>开关</th><th className="r">温度</th><th className="r">湿度</th><th className="r">露点</th><th style={{ paddingLeft: 40 }}>控制类型</th><th className="r">设定值</th><th>风速</th><th>滤网寿命</th></tr></thead>
          <tbody>
            {units.map((f) => (
              <tr key={f.id} onClick={() => setCur(f.id)} style={{ cursor: 'pointer', color: f.on ? undefined : 'var(--muted)' }}>
                <td style={{ fontWeight: 500, color: 'var(--text)' }}>{f.name}</td>
                <td><span className={'pill ' + (f.on ? 'green' : 'gray')} style={{ color: f.on ? undefined : 'var(--muted)' }}>{f.on ? '开' : '关'}</span></td>
                <td className="r num">{f.supplyTemp.toFixed(1)}°C</td><td className="r num">{f.supplyHum}%</td><td className="r num">{f.supplyDew.toFixed(1)}°C</td>
                <td style={{ paddingLeft: 40 }}>{f.control === 'dew' ? '露点' : '湿度'}</td>
                <td className="r num">{f.control === 'dew' ? `${f.dewSet.toFixed(1)}°C` : `${f.humSet}%`}</td>
                <td>{f.on ? f.fan : '--'}</td>
                <td style={{ width: 170 }}><div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: f.filter + '%', background: !f.on ? '#cbd5e1' : f.filter < 15 ? 'var(--red)' : undefined }} /></div><span className={'num ' + (f.filter < 15 ? 'red' : '')} style={{ width: 30, textAlign: 'right', fontSize: 12 }}>{f.filter}%</span></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
