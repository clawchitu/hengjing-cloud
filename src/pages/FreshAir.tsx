import { useEffect, useState, type ReactNode } from 'react'
import { faFan, faDroplet, faTemperatureLow, faPaperPlane, faRotate, faSignal, faFilter, faLock, faGears } from '@fortawesome/free-solid-svg-icons'
import { Card, Icon, Toggle, useAsync, useClock } from '../components/legacy'
import { useApp } from '../app/store'
import * as api from '../api'
import { DEW_MODES, isStandalone, type FreshAir as FA } from '../api'

const statusText = (f: FA) => (f.status === 'run' ? ['运行中', 'green'] : f.status === 'filter' ? ['滤网待更换', 'orange'] : ['已关机', 'faint'])
const dewCapable = (f: FA) => DEW_MODES.includes(f.mode)

function Ring({ pct }: { pct: number }) {
  const r = 52, c = 2 * Math.PI * r
  const color = pct < 15 ? '#f43f5e' : pct < 50 ? '#f59e0b' : '#10b981'
  return (
    <svg width="124" height="124" viewBox="0 0 132 132">
      <circle cx="66" cy="66" r={r} stroke="#e2f5ee" strokeWidth="11" fill="none" />
      <circle cx="66" cy="66" r={r} stroke={color} strokeWidth="11" fill="none" strokeLinecap="round"
        strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 66 66)" style={{ transition: 'stroke-dasharray .6s' }} />
      <text x="66" y="70" textAnchor="middle" fontSize="30" fontWeight="600" fontFamily="Barlow" fill="#0f172a">{pct}%</text>
      <text x="66" y="92" textAnchor="middle" fontSize="11" fill="#94a3b8">剩余</text>
    </svg>
  )
}

export default function FreshAir() {
  const { projectId, project, toast, confirm } = useApp()
  const clock = useClock()
  const [units, setUnits] = useAsync(() => api.getFreshAir(projectId), [projectId])
  const [curRaw, setCur] = useState('FA-01')
  const u = units?.find((x) => x.id === curRaw) ?? units?.[0]
  const hasSettings = isStandalone(project) // only 新风单机版 (程序编码 12) has 运行设置
  const [draft, setDraft] = useState<Pick<FA, 'on' | 'control' | 'dewSet' | 'humSet' | 'fan'> | null>(null)
  useEffect(() => { if (u) setDraft({ on: u.on, control: dewCapable(u) ? u.control : 'hum', dewSet: u.dewSet, humSet: u.humSet, fan: u.fan }) }, [u?.id, projectId, !!u]) // eslint-disable-line

  // live random walk every 3s (only while the project is online)
  useEffect(() => {
    if (!project.online) return
    const t = setInterval(() => {
      setUnits((units ?? []).map((f) => f.on ? {
        ...f,
        supplyTemp: api.walk(f.supplyTemp, 0.15, 16.5, 21),
        supplyHum: api.walk(f.supplyHum, 0.8, 52, 70, 0),
        supplyDew: api.walk(f.supplyDew, 0.1, 9.5, 13),
        returnTemp: api.walk(f.returnTemp, 0.1, 24, 27),
        rpm: Math.round(api.walk(f.rpm, 12, f.rpm - 30, f.rpm + 30, 0)),
      } : f))
    }, 3000)
    return () => clearInterval(t)
  }, [units, setUnits, project.online])

  if (!units || !u || !draft) return <div className="page" />
  const [st] = statusText(u)
  const canDew = dewCapable(u)
  const dewOn = canDew && draft.control === 'dew'

  const send = async () => {
    const body = (
      <>
        即将向 <b>{u.name}</b> 下发以下运行设置：
        <div className="kv">
          <div><span>开关</span><b>{draft.on ? '开启' : '关闭'}</b></div>
          <div><span>控制类型</span><b>{dewOn ? `露点控制 · ${draft.dewSet.toFixed(1)}°C` : `湿度控制 · ${draft.humSet}%RH`}{!canDew && '（固定）'}</b></div>
          <div><span>风速</span><b>{draft.fan}</b></div>
        </div>
      </>
    )
    if (!(await confirm({ title: '确认下发设置', body, okText: '确认下发' }))) return
    const next = await api.applyFreshAir(projectId, u.id, { ...draft, control: dewOn ? 'dew' : 'hum', status: draft.on ? (u.status === 'off' ? 'run' : u.status) : 'off', rpm: draft.on ? ({ 低: 980, 中: 1350, 高: 1720 })[draft.fan] : 0 })
    setUnits(next)
    toast(`${u.name} 设置已下发成功`)
  }
  const step = (k: 'dewSet' | 'humSet', d: number) => setDraft((s) => {
    if (!s) return s
    const v = k === 'dewSet' ? Math.min(16, Math.max(8, +(s.dewSet + d).toFixed(1))) : Math.min(70, Math.max(35, s.humSet + d))
    return { ...s, [k]: v }
  })

  const target = u.control === 'dew' ? ['露点目标', `≤ ${u.dewSet.toFixed(1)} °C`] : ['湿度目标', `${u.humSet} %RH`]
  const tiles: [string, ReactNode, string?][] = [
    ['送风温度', `${u.supplyTemp.toFixed(1)} °C`], ['回风温度', `${u.returnTemp.toFixed(1)} °C`], ['新风温度', `${u.freshTemp.toFixed(1)} °C`], ['送风湿度', `${u.supplyHum} %RH`],
    ['回风湿度', `${u.returnHum} %RH`], ['新风湿度', `${u.freshHum} %RH`], ['送风露点', `${u.supplyDew.toFixed(1)} °C`], [target[0], target[1]],
    ['当前控制类型', u.control === 'dew' ? '露点控制' : '湿度控制'], ['当前风速', u.on ? `${u.fan}速 · ${u.rpm.toLocaleString()} rpm` : '--'], ['新风量', <>{u.airflow} m<sup>3</sup>/h</>],
    ['除湿压缩机', u.compressor ? `运行 · ${u.hz} Hz` : '停止', u.compressor ? 'green' : 'faint'],
  ]
  const filterText = u.filter < 15 ? ['滤网寿命不足，请尽快更换', 'red'] : u.filter < 50 ? [`滤网已使用过半，预计 ${u.filterDays} 天后需更换`, 'orange'] : [`状态良好，预计 ${u.filterDays} 天后需更换`, '']

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>新风除湿机</h1><div className="sub">{project.name}<span className="sep">·</span>{units.length} 台新风除湿一体机{hasSettings && <><span className="sep">·</span>新风单机版</>}</div></div>
        <div className="muted" style={{ fontSize: 12, marginTop: 24 }}><Icon icon={faRotate} /> {project.online ? <>实时刷新 · <span className="num">{clock}</span></> : <>最后更新 · <span className="num">{project.lastOnline}</span></>}</div>
      </div>
      <div className="dev-tabs">
        {units.map((f) => {
          const [t, c] = statusText(f)
          return (
            <div key={f.id} className={'dev-tab' + (f.id === u.id ? ' on' : '')} onClick={() => setCur(f.id)}>
              <div className="di"><Icon icon={faFan} /></div>
              <div><b className="num">{f.name}</b><small className={c}>{t} · {f.floor} · 模式 {f.mode}</small></div>
            </div>
          )
        })}
      </div>

      <div className={'fa-top' + (hasSettings ? '' : ' wide')}>
        <Card>
          <div className="card-head"><h3 className="card-title">实时数据 · <span className="num">{u.name}</span></h3><span className={'pill ' + (u.status === 'off' ? 'gray' : u.status === 'filter' ? 'orange' : 'green')}><span className="dot" />{st}</span></div>
          <div className="fa-banner">
            <div className="fb-filter">
              <Ring pct={u.filter} />
              <div style={{ flex: 1 }}>
                <b className="fb-t"><Icon icon={faFilter} />滤网寿命</b>
                <div className={'fb-s ' + filterText[1]}>{filterText[0].split(/(\d+)/).map((x, i) => (/^\d+$/.test(x) ? <b key={i}>{x}</b> : x))}</div>
                <div className="bar" style={{ height: 8, margin: '12px 0 8px' }}><i style={{ width: u.filter + '%', background: u.filter < 15 ? 'var(--red)' : u.filter < 50 ? 'var(--amber)' : undefined }} /></div>
                <small className="muted num">已运行 {u.filterHours.toLocaleString()} h</small>
              </div>
            </div>
            <div className="fb-mode">
              <small><Icon icon={faGears} /> 运行模式</small>
              <b className="num">模式 {u.mode}</b>
              <span className={'pill ' + (canDew ? 'cyan' : 'gray')}>{canDew ? '支持 露点 / 湿度 控制' : '仅湿度控制'}</span>
            </div>
          </div>
          <div className={'fa-tiles' + (hasSettings ? '' : ' six')}>
            {tiles.map(([l, v, c]) => <div key={l}><span>{l}</span><b className={'num ' + (c ?? '')}>{v}</b></div>)}
          </div>
        </Card>

        {hasSettings && (
          <Card className="set-panel">
            <div className="card-head" style={{ marginBottom: 12 }}><h3 className="card-title">运行设置</h3><span className="row muted" style={{ fontSize: 13 }}>开关 <Toggle on={draft.on} onChange={(v) => setDraft({ ...draft, on: v })} /></span></div>
            <h4>控制类型设置</h4><div className="faint" style={{ fontSize: 11.5 }}>露点设定与湿度设定二选一</div>
            <div className="ctl-type">
              <button className={'opt-btn' + (dewOn ? ' on' : '')} disabled={!canDew} title={canDew ? undefined : '当前模式固定为湿度控制'} onClick={() => canDew && setDraft({ ...draft, control: 'dew' })}><Icon icon={faTemperatureLow} />露点控制</button>
              <button className={'opt-btn' + (!dewOn ? ' on' : '')} disabled={!canDew} onClick={() => canDew && setDraft({ ...draft, control: 'hum' })}><Icon icon={!canDew ? faLock : faDroplet} />湿度控制</button>
            </div>
            {!canDew && <div className="ctl-hint"><Icon icon={faLock} />当前模式（{u.mode}）固定为湿度控制，不可修改</div>}
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
        )}
      </div>

      <Card pad={false}>
        <div className="card-pad" style={{ paddingBottom: 14 }}><h3 className="card-title">设备汇总</h3></div>
        <table className="table">
          <thead><tr><th>设备</th><th>开关</th><th className="r">模式</th><th className="r">温度</th><th className="r">湿度</th><th className="r">露点</th><th style={{ paddingLeft: 40 }}>控制类型</th><th className="r">设定值</th><th>风速</th><th>滤网寿命</th></tr></thead>
          <tbody>
            {units.map((f) => (
              <tr key={f.id} onClick={() => setCur(f.id)} style={{ cursor: 'pointer', color: f.on ? undefined : 'var(--muted)' }}>
                <td style={{ fontWeight: 500, color: 'var(--text)' }}>{f.name}</td>
                <td><span className={'pill ' + (f.on ? 'green' : 'gray')} style={{ color: f.on ? undefined : 'var(--muted)' }}>{f.on ? '开' : '关'}</span></td>
                <td className="r num">{f.mode}</td>
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
