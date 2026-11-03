import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faMagnifyingGlass, faFolderPlus, faPlus, faHouse, faPenToSquare, faSliders, faBuilding, faArrowRight } from '@fortawesome/free-solid-svg-icons'
import { Card, Icon, Pager, Seg } from '../components/ui'
import { useApp } from '../app/store'
import { PROGRAMS } from '../api'

export default function Groups() {
  const nav = useNavigate()
  const { projectId, setProjectId, toast, scope, user } = useApp()
  const isAdmin = user.role === 'admin'
  const [dealerId, setDealerId] = useState(scope.dealers[0]?.id ?? '')
  const groups = scope.groups.filter((g) => g.dealerId === dealerId)
  const projects = scope.projects.filter((p) => groups.some((g) => g.id === p.groupId))
  // default: first 集成项目 of the (selected) dealer
  const [gidRaw, setGid] = useState('')
  const gid = groups.some((g) => g.id === gidRaw) ? gidRaw : groups[0]?.id ?? ''
  const [gq, setGq] = useState('')
  const [pq, setPq] = useState('')
  const [area, setArea] = useState('全部区域')
  const [st, setSt] = useState<'全部' | '在线' | '离线'>('全部')
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [gid, pq, area, st])
  const g = groups.find((x) => x.id === gid)
  if (!g) return <div className="page" />
  const inG = projects.filter((p) => p.groupId === gid)
  const list = inG.filter((p) => (!pq || (p.name + p.id).toLowerCase().includes(pq.toLowerCase())) && (area === '全部区域' || p.district === area) && (st === '全部' || (st === '在线') === p.online))
  const SIZE = 6
  const shown = list.slice((page - 1) * SIZE, page * SIZE)
  const on = inG.filter((p) => p.online).length
  const tc = { cyan: 'cyan', blue: 'blue', purple: 'purple', orange: 'orange' } as const

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>集成项目</h1><div className="sub">{isAdmin && <>{scope.dealers.find((d) => d.id === dealerId)?.name}<span className="sep">·</span></>}共 {groups.length} 个集成项目<span className="sep">·</span>{projects.length} 个项目，点击项目进入运行数据</div></div>
        <div className="actions">
          <button className="btn" onClick={() => toast('新建集成项目：演示环境为只读', true)}><Icon icon={faFolderPlus} className="faint" />新建集成项目</button>
          <button className="btn primary" onClick={() => toast('新建项目：演示环境为只读', true)}><Icon icon={faPlus} />新建项目</button>
        </div>
      </div>
      <div className="groups">
        <div>
          {isAdmin && (
            <div className="dealer-pick">
              <label>经销商</label>
              <select className="select" value={dealerId} onChange={(e) => { setDealerId(e.target.value); setGid('') }}>
                {scope.dealers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <small>{scope.dealers.length} 个经销商 · 先选择经销商，再查看其集成项目</small>
            </div>
          )}
          <div className="card row" style={{ height: 40, padding: '0 14px', marginBottom: 14, color: 'var(--faint)', boxShadow: 'none' }}><Icon icon={faMagnifyingGlass} /><input style={{ border: 0, outline: 0, flex: 1, background: 'transparent' }} placeholder="搜索集成项目名称 / 编码" value={gq} onChange={(e) => setGq(e.target.value)} /></div>
          {groups.filter((x) => !gq || (x.name + x.id).includes(gq)).map((x) => {
            const ps = projects.filter((p) => p.groupId === x.id), o = ps.filter((p) => p.online).length, pct = (o / ps.length) * 100
            return (
              <Card key={x.id} className={'grp-card' + (x.id === gid ? ' on' : '')} pad={false}>
                <div onClick={() => setGid(x.id)}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><span className={'pill ' + tc[x.typeColor]} style={{ fontSize: 12 }}>{x.type}</span><span className="faint num" style={{ fontSize: 11.5 }}>{x.id}</span></div>
                  <h4>{x.name}</h4>
                  <div className="gm"><span><Icon icon={faBuilding} /> {ps.length} 个项目</span><b className={pct === 100 ? 'green' : pct > 80 ? 'green' : 'orange'} style={{ fontWeight: 500 }}>{o} 在线</b></div>
                  <div className="bar" style={{ height: 5 }}><i style={{ width: pct + '%', background: pct < 80 ? '#f59e0b' : undefined }} /></div>
                </div>
              </Card>
            )
          })}
        </div>
        <div>
          <Card style={{ marginBottom: 20, padding: '22px 22px' }}>
            <div className="grp-head">
              <div className="gi"><Icon icon={faHouse} /></div>
              <div style={{ flex: 1 }}><h2>{g.name}</h2><p>{g.desc}</p></div>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn" onClick={() => toast('编辑：演示环境为只读', true)}><Icon icon={faPenToSquare} />编辑</button>
                <button className="btn ghost-primary" onClick={() => nav('/control')}><Icon icon={faSliders} />统一控制</button>
              </div>
            </div>
            <div className="info4">
              <div><span>集成项目编码</span><b className="num">{g.id}</b></div>
              <div><span>应用类型</span><b>{g.type}</b></div>
              <div><span>创建时间</span><b className="num">{g.created}</b></div>
              <div><span>在线率</span><b className="green num">{((on / inG.length) * 100).toFixed(1)}% <small className="faint" style={{ fontWeight: 400, fontSize: 12 }}>({on}/{inG.length})</small></b></div>
            </div>
          </Card>
          <Card pad={false}>
            <div className="card-head card-pad" style={{ marginBottom: 0, paddingBottom: 14, alignItems: 'center' }}>
              <h3 className="card-title">项目列表</h3>
              <div className="row" style={{ gap: 10 }}>
                <div className="row input" style={{ width: 210, color: 'var(--faint)' }}><Icon icon={faMagnifyingGlass} /><input style={{ border: 0, outline: 0, flex: 1, minWidth: 0 }} placeholder="项目名称 / ID" value={pq} onChange={(e) => setPq(e.target.value)} /></div>
                <select className="select" value={area} onChange={(e) => setArea(e.target.value)}><option>全部区域</option>{[...new Set(inG.map((p) => p.district))].map((d) => <option key={d}>{d}</option>)}</select>
                <Seg value={st} options={['全部', '在线', '离线']} onChange={setSt} />
              </div>
            </div>
            <table className="table">
              <thead><tr><th>项目名称</th><th>项目ID</th><th>区域</th><th>是否在线</th><th>版本号</th><th>程序</th><th className="r">操作</th></tr></thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className={p.id === projectId ? 'cur-row' : ''}>
                    <td style={{ fontWeight: 600 }}><span className="bico"><Icon icon={faBuilding} /></span>{p.name}</td>
                    <td className="num">{p.id}</td><td>{p.city} · {p.district}</td>
                    <td><span className={'pill ' + (p.online ? 'green' : 'gray')} style={{ color: p.online ? undefined : 'var(--muted)' }}><span className="dot" style={{ width: 5, height: 5 }} />{p.online ? '在线' : '离线'}</span></td>
                    <td className="num">{p.version}</td>
                    <td><span className={'pill ' + (p.programCode === 12 ? 'purple' : 'gray')} style={{ color: p.programCode === 12 ? undefined : 'var(--muted)' }}>{PROGRAMS[p.programCode]} <span className="num">({p.programCode})</span></span></td>
                    <td className="r"><button className="link" onClick={() => { setProjectId(p.id); toast(p.online ? `已进入「${p.name}」` : `「${p.name}」当前离线，显示最后在线数据`, !p.online); nav('/sensors') }}>查看数据 <Icon icon={faArrowRight} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={list.length} page={page} size={SIZE} onPage={setPage} label={<>共 {list.length} 条，显示 {list.length ? (page - 1) * SIZE + 1 : 0}-{Math.min(page * SIZE, list.length)}</>} />
          </Card>
        </div>
      </div>
    </div>
  )
}
