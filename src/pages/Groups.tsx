import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faMagnifyingGlass, faFolderPlus, faPlus, faHouse, faPenToSquare, faSliders, faBuilding, faArrowRight } from '@fortawesome/free-solid-svg-icons'
import { Icon, Pager, Seg } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import { PROGRAMS } from '../api'

export default function Groups() {
  const nav = useNavigate()
  const { projectId, setProjectId, toast, scope, user } = useApp()
  const isAdmin = user.role === 'admin'
  const [dealerId, setDealerId] = useState(scope.dealers[0]?.id ?? '')
  const [dq, setDq] = useState('')
  const matchDealer = (d: { id: string; name: string; short: string; region: string }, q: string) => !q.trim() || (d.id + d.name + d.short + d.region).toLowerCase().includes(q.trim().toLowerCase())
  const dealerHits = scope.dealers.filter((d) => matchDealer(d, dq))
  // a dealer account's scope contains only its own dealer, so this never exposes other dealers' groups
  const groups = isAdmin && dealerHits.length === 0 ? [] : scope.groups.filter((g) => g.dealerId === dealerId)
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
  const dealerPick = isAdmin ? (
            <div className="dealer-pick">
              <label>经销商</label>
              <div className="dp-search"><Icon icon={faMagnifyingGlass} /><input placeholder="搜索经销商名称 / 编码 / 区域" value={dq} onChange={(e) => {
                const q = e.target.value; setDq(q)
                const hits = scope.dealers.filter((d) => matchDealer(d, q))
                if (hits.length && !hits.some((d) => d.id === dealerId)) { setDealerId(hits[0].id); setGid('') }
              }} /></div>
              <select className="select" value={dealerId} onChange={(e) => { setDealerId(e.target.value); setGid('') }}>
                {dealerHits.length ? dealerHits.map((d) => <option key={d.id} value={d.id}>{d.name}</option>) : <option value={dealerId} disabled>未找到匹配的经销商</option>}
              </select>
              <small>{dq ? `匹配 ${dealerHits.length} / ${scope.dealers.length} 个经销商` : `${scope.dealers.length} 个经销商`} · 先选择经销商，再查看其集成项目</small>
            </div>
  ) : null
  if (!g) return (
    <div className="page">
      <div className="page-head"><div><h1>集成项目</h1><div className="sub">{isAdmin && dq ? '未找到匹配的经销商' : '暂无集成项目'}</div></div></div>
      <div className="groups"><div>{dealerPick}</div>
        <Card><div className="empty-fav"><Icon icon={faMagnifyingGlass} /><b>{isAdmin && dq ? `没有与「${dq}」匹配的经销商` : '暂无集成项目'}</b><small>请修改搜索条件，或清空搜索查看全部经销商</small></div></Card>
      </div>
    </div>
  )
  const inG = projects.filter((p) => p.groupId === gid)
  const list = inG.filter((p) => (!pq || (p.name + p.id).toLowerCase().includes(pq.toLowerCase())) && (area === '全部区域' || p.district === area) && (st === '全部' || (st === '在线') === p.online))
  const SIZE = 6
  const shown = list.slice((page - 1) * SIZE, page * SIZE)
  const on = inG.filter((p) => p.online).length

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>集成项目</h1><div className="sub">{isAdmin && <>{scope.dealers.find((d) => d.id === dealerId)?.name}<span className="sep">·</span></>}共 {groups.length} 个集成项目<span className="sep">·</span>{projects.length} 个项目，点击项目进入运行数据</div></div>
        <div className="actions">
          <Button onClick={() => toast('新建集成项目：演示环境为只读', true)}><Icon icon={faFolderPlus} className="faint" />新建集成项目</Button>
          <Button variant="primary" onClick={() => toast('新建项目：演示环境为只读', true)}><Icon icon={faPlus} />新建项目</Button>
        </div>
      </div>
      <div className="groups">
        <div>
          {dealerPick}
          <Card pad={false} className="row" style={{ height: 40, padding: '0 14px', marginBottom: 14, color: 'var(--faint)', boxShadow: 'none' }}><Icon icon={faMagnifyingGlass} /><input style={{ border: 0, outline: 0, flex: 1, background: 'transparent' }} placeholder="搜索集成项目名称 / 编码" value={gq} onChange={(e) => setGq(e.target.value)} /></Card>
          {groups.filter((x) => !gq || (x.name + x.id).includes(gq)).map((x) => {
            const ps = projects.filter((p) => p.groupId === x.id), o = ps.filter((p) => p.online).length, pct = (o / ps.length) * 100
            return (
              <Card key={x.id} className={'grp-card' + (x.id === gid ? ' on' : '')} pad={false}>
                <div onClick={() => setGid(x.id)}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><Badge variant={x.typeColor} style={{ fontSize: 12 }}>{x.type}</Badge><span className="faint num" style={{ fontSize: 11.5 }}>{x.id}</span></div>
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
                <Button onClick={() => toast('编辑：演示环境为只读', true)}><Icon icon={faPenToSquare} />编辑</Button>
                <Button variant="soft" onClick={() => nav('/control')}><Icon icon={faSliders} />统一控制</Button>
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
            <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14, alignItems: 'center' }}>
              <CardTitle>项目列表</CardTitle>
              <div className="row" style={{ gap: 10 }}>
                <div className="row input" style={{ width: 210, color: 'var(--faint)' }}><Icon icon={faMagnifyingGlass} /><input style={{ border: 0, outline: 0, flex: 1, minWidth: 0 }} placeholder="项目名称 / ID" value={pq} onChange={(e) => setPq(e.target.value)} /></div>
                <select className="select" value={area} onChange={(e) => setArea(e.target.value)}><option>全部区域</option>{[...new Set(inG.map((p) => p.district))].map((d) => <option key={d}>{d}</option>)}</select>
                <Seg value={st} options={['全部', '在线', '离线']} onChange={setSt} />
              </div>
            </CardHeader>
            <Table>
              <TableHeader><TableRow><TableHead>项目名称</TableHead><TableHead>项目ID</TableHead><TableHead>区域</TableHead><TableHead>是否在线</TableHead><TableHead>版本号</TableHead><TableHead>程序</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {shown.map((p) => (
                  <TableRow key={p.id} className={p.id === projectId ? 'cur-row' : ''}>
                    <TableCell style={{ fontWeight: 600 }}><span className="bico"><Icon icon={faBuilding} /></span>{p.name}</TableCell>
                    <TableCell className="num">{p.id}</TableCell><TableCell>{p.city} · {p.district}</TableCell>
                    <TableCell><Badge variant={p.online ? 'green' : 'gray'} style={{ color: p.online ? undefined : 'var(--muted)' }}><span className="dot" style={{ width: 5, height: 5 }} />{p.online ? '在线' : '离线'}</Badge></TableCell>
                    <TableCell className="num">{p.version}</TableCell>
                    <TableCell><Badge variant={p.programCode === 12 ? 'purple' : 'gray'} style={{ color: p.programCode === 12 ? undefined : 'var(--muted)' }}>{PROGRAMS[p.programCode]} <span className="num">({p.programCode})</span></Badge></TableCell>
                    <TableCell className="text-right"><Button variant="link" onClick={() => { setProjectId(p.id); toast(p.online ? `已进入「${p.name}」` : `「${p.name}」当前离线，显示最后在线数据`, !p.online); nav('/sensors') }}>查看数据 <Icon icon={faArrowRight} /></Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager total={list.length} page={page} size={SIZE} onPage={setPage} label={<>共 {list.length} 条，显示 {list.length ? (page - 1) * SIZE + 1 : 0}-{Math.min(page * SIZE, list.length)}</>} />
          </Card>
        </div>
      </div>
    </div>
  )
}
