import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faMagnifyingGlass, faFolderPlus, faPlus, faHouse, faPenToSquare, faSliders, faBuilding, faArrowRight } from '@fortawesome/free-solid-svg-icons'
import { Icon, Pager, Seg } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import { projectsInGroup, projectsInGroups, useDealerPick, useDealers, useIntegratedProjects, useProjects } from '../data/org'
import { NO_DEALER, dealerPickModel } from './dealerPick'
import { PROGRAMS } from '../api'

export default function Groups() {
  const nav = useNavigate()
  const { projectId, setProjectId, toast, user } = useApp()
  const isAdmin = user.role === 'admin'
  const dealers = useDealers().data
  // 经销商列表异步到达时默认选第一个（派生值，不是只在初始化取一次的 useState 初值）
  const [dealerId, setDealerId] = useDealerPick(dealers)
  const [dq, setDq] = useState('')
  const matchDealer = (d: { id: string; name: string; short: string; region: string }, q: string) => !q.trim() || (d.id + d.name + d.short + d.region).toLowerCase().includes(q.trim().toLowerCase())
  const dealerHits = dealers.filter((d) => matchDealer(d, dq))
  // 平台账号按所选经销商取集成项目（含下级）；经销商账号不选经销商，后端按账号范围返回
  const dealerGroups = useIntegratedProjects({ dealerId: isAdmin ? dealerId : undefined, enabled: !isAdmin || !!dealerId }).data
  const groups = isAdmin && dealerHits.length === 0 ? [] : dealerGroups
  const allProjects = useProjects().data
  const projects = projectsInGroups(groups, allProjects)
  // default: first 集成项目 of the (selected) dealer
  const [gidRaw, setGid] = useState('')
  const gid = groups.some((g) => g.id === gidRaw) ? gidRaw : groups[0]?.id ?? ''
  const [gq, setGq] = useState('')
  const [pq, setPq] = useState('')
  const [area, setArea] = useState('全部区域')
  const [st, setSt] = useState<'全部' | '在线' | '离线'>('全部')
  const [page, setPage] = useState(1)
  // 切换经销商 / 集成项目时区域筛选回到「全部区域」（新集成项目里可能没有原来的区域）；重复点当前组不动筛选
  const pickGroup = (id: string) => { if (id !== gid) { setGid(id); setArea('全部区域') } }
  useEffect(() => setPage(1), [gid, pq, area, st])
  const g = groups.find((x) => x.id === gid)
  const dp = dealerPickModel(dealerHits, dealerId)
  const dealerPick = isAdmin ? (
            <div className="dealer-pick">
              <label>经销商</label>
              <InputGroup className="mb-2 px-2.5"><Icon icon={faMagnifyingGlass} /><InputGroupInput className="min-w-0 text-foreground" placeholder="搜索经销商名称 / 编码 / 区域" value={dq} onChange={(e) => {
                const q = e.target.value; setDq(q)
                const hits = dealers.filter((d) => matchDealer(d, q))
                if (hits.length && !hits.some((d) => d.id === dealerId)) { setDealerId(hits[0].id); pickGroup('') }
              }} /></InputGroup>
              <Select value={dp.value} onValueChange={(v) => { if (v !== NO_DEALER) { setDealerId(v); pickGroup('') } }}>
                <SelectTrigger aria-label="经销商" className="h-[38px] w-full font-medium text-foreground" />
                <SelectContent>{dp.items.map((d) => <SelectItem key={d.value} value={d.value} disabled={d.disabled}>{d.label}</SelectItem>)}</SelectContent>
              </Select>
              <small>{dq ? `匹配 ${dealerHits.length} / ${dealers.length} 个经销商` : `${dealers.length} 个经销商`} · 先选择经销商，再查看其集成项目</small>
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
  const inG = projectsInGroup(g, projects)
  const areas = ['全部区域', ...new Set(inG.map((p) => p.district))]
  // 下拉显示和列表过滤用同一个有效值：不在当前集成项目里的区域一律按「全部区域」
  const areaV = areas.includes(area) ? area : '全部区域'
  const list = inG.filter((p) => (!pq || (p.name + p.code).toLowerCase().includes(pq.toLowerCase())) && (areaV === '全部区域' || p.district === areaV) && (st === '全部' || (st === '在线') === p.online))
  const SIZE = 6
  const shown = list.slice((page - 1) * SIZE, page * SIZE)
  const on = inG.filter((p) => p.online).length

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>集成项目</h1><div className="sub">{isAdmin && <>{dealers.find((d) => d.id === dealerId)?.name}<span className="sep">·</span></>}共 {groups.length} 个集成项目<span className="sep">·</span>{projects.length} 个项目，点击项目进入运行数据</div></div>
        <div className="actions">
          <Button onClick={() => toast('新建集成项目：演示环境为只读', true)}><Icon icon={faFolderPlus} className="faint" />新建集成项目</Button>
          <Button variant="primary" onClick={() => toast('新建项目：演示环境为只读', true)}><Icon icon={faPlus} />新建项目</Button>
        </div>
      </div>
      <div className="groups">
        <div>
          {dealerPick}
          <Card pad={false} className="row" style={{ height: 40, padding: '0 14px', marginBottom: 14, color: 'var(--faint)', boxShadow: 'none' }}><Icon icon={faMagnifyingGlass} /><InputGroupInput placeholder="搜索集成项目名称 / 编码" value={gq} onChange={(e) => setGq(e.target.value)} /></Card>
          {groups.filter((x) => !gq || (x.name + x.code).includes(gq)).map((x) => {
            const ps = projectsInGroup(x, projects), o = ps.filter((p) => p.online).length, pct = (o / ps.length) * 100
            return (
              <Card key={x.id} className={'grp-card' + (x.id === gid ? ' on' : '')} pad={false}>
                <div onClick={() => pickGroup(x.id)}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><Badge variant={x.typeColor} style={{ fontSize: 12 }}>{x.type}</Badge><span className="faint num" style={{ fontSize: 11.5 }}>{x.code}</span></div>
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
              <div><span>集成项目编码</span><b className="num">{g.code}</b></div>
              <div><span>应用类型</span><b>{g.type}</b></div>
              <div><span>创建时间</span><b className="num">{g.created}</b></div>
              <div><span>在线率</span><b className="green num">{((on / inG.length) * 100).toFixed(1)}% <small className="faint" style={{ fontWeight: 400, fontSize: 12 }}>({on}/{inG.length})</small></b></div>
            </div>
          </Card>
          <Card pad={false}>
            <CardHeader pad style={{ marginBottom: 0, paddingBottom: 14, alignItems: 'center' }}>
              <CardTitle>项目列表</CardTitle>
              <div className="row" style={{ gap: 10 }}>
                <InputGroup className="w-[210px]"><Icon icon={faMagnifyingGlass} /><InputGroupInput className="min-w-0" placeholder="项目名称 / ID" value={pq} onChange={(e) => setPq(e.target.value)} /></InputGroup>
                <Select value={areaV} onValueChange={setArea}>
                  <SelectTrigger aria-label="区域" sizer={areas} />
                  <SelectContent>{areas.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                </Select>
                <Seg value={st} options={['全部', '在线', '离线']} onChange={setSt} />
              </div>
            </CardHeader>
            <Table>
              <TableHeader><TableRow><TableHead>项目名称</TableHead><TableHead>项目ID</TableHead><TableHead>区域</TableHead><TableHead>是否在线</TableHead><TableHead>版本号</TableHead><TableHead>程序</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {shown.map((p) => (
                  <TableRow key={p.id} className={p.id === projectId ? 'cur-row' : ''}>
                    <TableCell style={{ fontWeight: 600 }}><span className="bico"><Icon icon={faBuilding} /></span>{p.name}</TableCell>
                    <TableCell className="num">{p.code}</TableCell><TableCell>{p.city} · {p.district}</TableCell>
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
