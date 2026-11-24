import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faMagnifyingGlass, faHouse, faSliders, faBuilding, faArrowRight, faSpinner, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Icon, Pager, Seg } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApp } from '../app/store'
import { DealerSelect } from '../components/DealerSelect'
import { projectsInGroup, projectsInGroups, whenProjectSet, useApps, useDealerPick, useDealers, useIntegratedProjects, useProjects, type Group } from '../data/org'
import { defaultText } from '../api/errors'
import { PROGRAMS } from '../api'

/** 真实接口只有行政区划码、没有区县名：空值归到「未知区域」（Radix Select 不允许空字符串选项） */
const UNKNOWN_AREA = '未知区域'
const areaOf = (p: { district: string }) => p.district || UNKNOWN_AREA
const pctOf = (on: number, total: number) => (total ? (on / total) * 100 : 0)

export default function Groups() {
  const nav = useNavigate()
  const { projectId, setProjectId, toast, user } = useApp()
  const isAdmin = user.role === 'admin'
  const dealersQ = useDealers()
  const dealers = dealersQ.data
  // 经销商列表异步到达时默认选第一个（派生值，不是只在初始化取一次的 useState 初值）
  const [dealerId, setDealerId] = useDealerPick(dealers)
  // 平台账号按所选经销商取集成项目（含下级）；经销商账号不选经销商，后端按账号范围返回
  const groupsQ = useIntegratedProjects({ dealerId: isAdmin ? dealerId : undefined, enabled: !isAdmin || !!dealerId })
  const groups = groupsQ.data
  const projectsQ = useProjects()
  const projects = projectsInGroups(groups, projectsQ.data)
  // 集成项目只有 app_id：类型名称用 /apps 查（演示数据直接写在 type 里）
  const apps = useApps().data
  const typeOf = (x: Group) => x.type || (x.appId ? apps[x.appId] ?? '' : '')
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
  // 改动文档「集成项目」两条：移除新建集成项目、新建项目、编辑（这些功能在其他平台实现）；经销商选择合并为可搜索下拉
  const dealerPick = isAdmin ? <DealerSelect dealers={dealersQ} value={dealerId} onChange={(id) => { setDealerId(id); pickGroup('') }} /> : null
  // 后台刷新失败（有旧数据）：提示数据可能已过期（演示数据不会出现）
  const stale = groupsQ.staleError || projectsQ.staleError
  const staleHint = stale && <div role="status" className="orange" style={{ fontSize: 12.5, marginTop: 4 }}>集成项目或项目列表刷新失败，数据可能已过期<Button variant="link" onClick={() => { groupsQ.refetch(); projectsQ.refetch() }}>重试</Button></div>
  if (!g) {
    // 空、加载、失败三态（平台账号先要有经销商）
    const failed = groupsQ.status === 'error' ? groupsQ : projectsQ.status === 'error' ? projectsQ : null
    const loading = isAdmin && !dealerId ? dealersQ.status === 'loading' : groupsQ.status === 'loading'
    const [icon, title, note] = failed
      ? [faTriangleExclamation, '集成项目加载失败', failed.error?.message || defaultText('server')]
      : loading
        ? [faSpinner, isAdmin && !dealerId ? '正在加载经销商…' : '正在加载集成项目…', '请稍候']
        : isAdmin && !dealerId
          ? [faMagnifyingGlass, '暂无可选的经销商', '没有拥有集成项目的经销商']
          : [faMagnifyingGlass, '暂无集成项目', isAdmin ? '该经销商下还没有集成项目，请选择其他经销商' : '当前账号下还没有集成项目']
    return (
      <div className="page">
        <div className="page-head"><div><h1>集成项目</h1><div className="sub">{loading ? '正在加载…' : '暂无集成项目'}</div></div></div>
        <div className="groups"><div>{dealerPick}</div>
          <Card><div className="empty-fav" role={failed ? 'alert' : 'status'}><Icon icon={icon} spin={icon === faSpinner} /><b>{title}</b><small>{note}</small>
            {failed && <Button variant="link" onClick={failed.refetch}>重试</Button>}</div></Card>
        </div>
      </div>
    )
  }
  const inG = projectsInGroup(g, projects)
  const areas = ['全部区域', ...new Set(inG.map(areaOf))]
  // 下拉显示和列表过滤用同一个有效值：不在当前集成项目里的区域一律按「全部区域」
  const areaV = areas.includes(area) ? area : '全部区域'
  const list = inG.filter((p) => (!pq || (p.name + p.code).toLowerCase().includes(pq.toLowerCase())) && (areaV === '全部区域' || areaOf(p) === areaV) && (st === '全部' || (st === '在线') === p.online))
  const SIZE = 6
  const shown = list.slice((page - 1) * SIZE, page * SIZE)
  const on = inG.filter((p) => p.online).length

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>集成项目</h1><div className="sub">{isAdmin && <>{dealers.find((d) => d.id === dealerId)?.name}<span className="sep">·</span></>}共 {groups.length} 个集成项目<span className="sep">·</span>{projects.length} 个项目，点击项目进入运行数据</div>{staleHint}</div>
      </div>
      <div className="groups">
        <div>
          {dealerPick}
          <Card pad={false} className="row" style={{ height: 40, padding: '0 14px', marginBottom: 14, color: 'var(--faint)', boxShadow: 'none' }}><Icon icon={faMagnifyingGlass} /><InputGroupInput placeholder="搜索集成项目名称 / 编码" value={gq} onChange={(e) => setGq(e.target.value)} /></Card>
          {groups.filter((x) => !gq || (x.name + x.code).includes(gq)).map((x) => {
            const ps = projectsInGroup(x, projects), o = ps.filter((p) => p.online).length, pct = pctOf(o, ps.length)
            const type = typeOf(x)
            return (
              <Card key={x.id} className={'grp-card' + (x.id === gid ? ' on' : '')} pad={false}>
                <div onClick={() => pickGroup(x.id)}>
                  {/* 没有应用（平台建的集成项目可能没有 app_id）时不画空的标签，编码仍靠右 */}
                  <div className="row" style={{ justifyContent: 'space-between' }}>{type ? <Badge variant={x.typeColor} style={{ fontSize: 12 }}>{type}</Badge> : <span />}<span className="faint num" style={{ fontSize: 11.5 }}>{x.code}</span></div>
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
                <Button variant="soft" onClick={() => nav('/control')}><Icon icon={faSliders} />统一控制</Button>
              </div>
            </div>
            <div className="info4">
              <div><span>集成项目编码</span><b className="num">{g.code}</b></div>
              <div><span>应用类型</span><b>{typeOf(g) || '—'}</b></div>
              <div><span>创建时间</span><b className="num">{g.created || '—'}</b></div>
              <div><span>在线率</span><b className="green num">{pctOf(on, inG.length).toFixed(1)}% <small className="faint" style={{ fontWeight: 400, fontSize: 12 }}>({on}/{inG.length})</small></b></div>
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
                    <TableCell className="num">{p.code}</TableCell><TableCell>{p.city && p.district ? <>{p.city} · {p.district}</> : p.city || p.district || UNKNOWN_AREA}</TableCell>
                    <TableCell><Badge variant={p.online ? 'green' : 'gray'} style={{ color: p.online ? undefined : 'var(--muted)' }}><span className="dot" style={{ width: 5, height: 5 }} />{p.online ? '在线' : '离线'}</Badge></TableCell>
                    <TableCell className="num">{p.version}</TableCell>
                    <TableCell><Badge variant={p.programCode === 12 ? 'purple' : 'gray'} style={{ color: p.programCode === 12 ? undefined : 'var(--muted)' }}>{p.appName || PROGRAMS[p.programCode] || '未知应用'} <span className="num">({p.programCode})</span></Badge></TableCell>
                    <TableCell className="text-right"><Button variant="link" onClick={() => whenProjectSet(setProjectId(p.id), () => { toast(p.online ? `已进入「${p.name}」` : `「${p.name}」当前离线，显示最后在线数据`, !p.online); nav('/sensors') }, (t) => toast(t, true))}>查看数据 <Icon icon={faArrowRight} /></Button></TableCell>
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
