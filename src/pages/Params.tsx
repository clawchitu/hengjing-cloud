import { useEffect, useState } from 'react'
import { faDownload, faRotateLeft, faUpload, faTriangleExclamation, faSnowflake, faCircleInfo } from '@fortawesome/free-solid-svg-icons'
import { Card, Icon, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'
import type { Param } from '../api'

const DEVICES = ['热泵主机 HP-01', '热泵主机 HP-02', '新风机 FA-01', '新风机 FA-02']

export default function Params() {
  const { toast, confirm, user } = { ...useApp(), user: '张建国' }
  const [device, setDevice] = useState(DEVICES[0])
  const [tabs, setTabs] = useAsync(() => api.getParams(device), [device])
  const [log, setLog] = useAsync(() => api.getParamLog(device), [device])
  const [tab, setTab] = useState('压缩机参数')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [lastRead, setLastRead] = useState('2025-06-18 15:30:12')
  // demo: reference shows two pending edits
  useEffect(() => { setEdits({ C01: '115', C04: '100' }) }, [device])

  if (!tabs || !log) return <div className="page" />
  const all: Param[] = Object.values(tabs).flat()
  const changed = Object.entries(edits).filter(([code, v]) => all.find((p) => p.code === code)?.current !== v)
  const invalid = changed.filter(([code, v]) => { const p = all.find((x) => x.code === code)!; const n = Number(v); return isNaN(n) || n < p.min || n > p.max })

  const send = async () => {
    if (!changed.length) return toast('没有待下发的修改', true)
    if (invalid.length) return toast(`${invalid.map((x) => x[0]).join('、')} 超出允许范围，请检查`, true)
    const body = (
      <>
        以下 <b>{changed.length}</b> 项工程参数将下发至 <b>{device}</b>，操作将记录到日志：
        <div className="kv">{changed.map(([code, v]) => { const p = all.find((x) => x.code === code)!; return <div key={code}><span>{code} {p.name}</span><b className="num">{p.current} → <span className="orange">{v}</span> {p.unit}</b></div> })}</div>
        <div style={{ marginTop: 10, color: 'var(--amber)', fontSize: 12.5 }}>部分保护类参数需在设备停机状态下下发方可生效。</div>
      </>
    )
    if (!(await confirm({ title: '二次确认：下发工程参数', body, okText: '确认下发' }))) return
    await api.writeParams(device, changed.map(([code, value]) => ({ code, value })))
    const at = new Date(); const ts = `06-18 ${at.toTimeString().slice(0, 5)}`
    setLog([...changed.map(([code, v]) => { const p = all.find((x) => x.code === code)!; return { text: `${code} ${p.name} ${p.current} → ${v}`, who: user, at: ts, result: '下发成功', ok: true } }), ...log])
    setTabs(Object.fromEntries(Object.entries(tabs).map(([k, ps]) => [k, ps.map((p) => (edits[p.code] !== undefined ? { ...p, current: edits[p.code] } : p))])))
    setEdits({})
    toast(`已成功下发 ${changed.length} 项参数`)
  }
  const restore = async () => {
    if (!(await confirm({ title: '恢复默认', body: `将「${tab}」页所有设定值恢复为出厂默认值（需下发后生效）。`, okText: '恢复' }))) return
    setEdits((e) => ({ ...e, ...Object.fromEntries(tabs[tab].map((p) => [p.code, p.def])) }))
    toast('已恢复默认值，请确认后下发')
  }
  const read = () => { setEdits({}); const d = new Date(); setLastRead(`2025-06-18 ${d.toTimeString().slice(0, 8)}`); toast(`已从 ${device} 读取最新参数`) }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>工程参数设置</h1><div className="sub">对设备专业运行参数进行读取与下发</div></div>
        <div className="actions">
          <button className="btn" onClick={read}><Icon icon={faDownload} className="faint" />读取参数</button>
          <button className="btn" onClick={restore}><Icon icon={faRotateLeft} className="faint" />恢复默认</button>
          <button className="btn primary" onClick={send}><Icon icon={faUpload} />下发参数 <span className="cnt num">{changed.length}</span></button>
        </div>
      </div>
      <div className="warn-box">
        <Icon icon={faTriangleExclamation} style={{ color: '#f59e0b', fontSize: 17, marginTop: 2 }} />
        <div><b>工程参数仅限具备「工程师」权限的人员修改</b><p>不当的参数设置可能导致设备保护停机或损坏，下发前将进行二次确认并记录操作日志。</p></div>
      </div>
      <Card pad={false} style={{ marginBottom: 20 }}>
        <div className="ptabs">
          <div style={{ position: 'relative', marginRight: 6 }}>
            <Icon icon={faSnowflake} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--primary-2)', fontSize: 13 }} />
            <select className="select" value={device} onChange={(e) => setDevice(e.target.value)} style={{ width: 200, paddingLeft: 32 }}>{DEVICES.map((d) => <option key={d}>{d}</option>)}</select>
          </div>
          {Object.keys(tabs).map((t) => <button key={t} className={'tab' + (t === tab ? ' on' : '')} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        <table className="table ptable">
          <thead><tr><th>代码</th><th>参数名称</th><th className="r">当前值</th><th style={{ paddingLeft: 40 }}>设定值</th><th>范围</th><th>单位</th><th className="r">默认值</th></tr></thead>
          <tbody>
            {tabs[tab].map((p) => {
              const v = edits[p.code] ?? p.current
              const mod = v !== p.current
              const n = Number(v); const bad = isNaN(n) || n < p.min || n > p.max
              return (
                <tr key={p.code} className={mod ? 'mod' : ''}>
                  <td className="num muted">{p.code}</td><td>{p.name}</td><td className="r num">{p.current}</td>
                  <td style={{ paddingLeft: 40 }}><input className={'num' + (bad ? ' bad' : '')} value={v} onChange={(e) => setEdits({ ...edits, [p.code]: e.target.value })} /></td>
                  <td className="num muted">{p.range}</td><td className="muted">{p.unit}</td><td className="r num">{p.def}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="pager" style={{ fontSize: 12.5 }}>
          <span className="row"><span style={{ width: 13, height: 13, borderRadius: 3, background: '#fef3c7', border: '1px solid #fcd34d', display: 'inline-block' }} />已修改待下发 <b className="orange num">{changed.length}</b> 项{invalid.length > 0 && <span className="red">（{invalid.length} 项超出范围）</span>}</span>
          <span className="faint num">最后读取 {lastRead}</span>
        </div>
      </Card>
      <div className="grid g2" style={{ gap: 20 }}>
        <Card>
          <h3 className="card-title" style={{ marginBottom: 10 }}>设备信息</h3>
          <div className="plist">
            {[['设备型号', 'ASHP-16kW'], ['通讯协议', 'Modbus-RTU'], ['从站地址', '0x01'], ['主控板固件', 'v2.8.4'], ['驱动板固件', 'v1.6.0']].map(([k, v]) => <div className="pr" key={k} style={{ border: 0, padding: '6px 0' }}><span className="muted">{k}</span><b className="num">{v}</b></div>)}
            <div className="pr" style={{ border: 0, padding: '6px 0' }}><span className="muted">当前状态</span><b className="green" style={{ fontWeight: 500 }}>运行中</b></div>
          </div>
          <div style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: 'var(--muted)', marginTop: 10 }}><Icon icon={faCircleInfo} className="cyan" /> 部分保护类参数需在设备停机状态下下发方可生效。</div>
        </Card>
        <Card>
          <div className="card-head" style={{ marginBottom: 12 }}><h3 className="card-title">修改日志</h3><button className="link" style={{ fontSize: 13 }} onClick={() => toast('已显示全部 ' + log.length + ' 条日志')}>全部</button></div>
          <div className="timeline">
            {log.slice(0, 4).map((l, i) => (
              <div className="tl-item" key={i}><span className="tdot" style={{ background: l.ok ? 'var(--green-2)' : 'var(--red)' }} />
                <b className="num">{l.text}</b><small className="num" style={l.ok ? undefined : { color: 'var(--red)' }}>{l.who} · {l.at} · {l.result}</small></div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
