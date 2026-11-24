// 房间温控面板（S9）。读：ctrl 200（15 秒刷新）、209 统计；写：201 单房间设置 / 开关、206 全部开关。
// 下发一律经 src/features/thermostat/source.ts → src/api/ctrl.ts 的 writeCtrl()（S4 统一写入口 + 写防护）。
// 每次下发前在真正发起下发的组件里用 useConfirm() 确认（docs/分工.md 第 3 节第 7 条）；确认返回后同步读取最新的项目、
// 房间读数和草稿重新核对，任何不一致都取消本次下发，要求重新确认。下发状态在模块级（features/thermostat/writes.ts），
// 按项目串行，离开页面 / 切项目后仍然有效。
// 交互依据 docs/design/thermostat-edit.md：温度 −/+ 与节能开关只改草稿，同一房间合并成一条 201；风速只读；设定湿度去除；
// 节能模式下温度由系统设定，不能改。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  ALL, buildRoomSet, buildRoomSwitch, canStep, checkLocked, clearResult, describeChanges, describeResult, draftChanges, ecoLabel,
  editBlock, editDraft, fmtTemp, hasDraftChanges, lockOf, reconcileDraft, resolveTempRange, runOp, sameQuery, stepTemp, summarize,
  switchBlock, tempBlock, thermostatSource, useFreshRooms, useRooms, useRoomStats, useWrites, windLabel,
  type ChartData, type EditCtx, type EndMode, type Lock, type RoomDraft, type RoomView, type StatsRange, type TempRange, type WriteResult,
} from '../features/thermostat'

type WriteQuery201 = WriteQuery<201>
const fmt1 = (v: number | null) => (v === null ? '--' : v.toFixed(1))
const sameNum = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005)

/** 把值存进 ref，提交后同步更新（确认返回后读最新值用） */
function useLatest<T>(v: T) {
  const ref = useRef(v)
  useLayoutEffect(() => { ref.current = v })
  return ref
}

/** 组件是否仍挂载（下发状态机的预检期间离开页面就中止） */
function usePresent() {
  const ref = useRef(true)
  useLayoutEffect(() => { ref.current = true; return () => { ref.current = false } }, [])
  return ref
}

function EndTag({ m, dim }: { m: EndMode; dim?: boolean }) {
  // 改动文档：is_selected 选中蓝色、未选中灰色；后面的「开 / 关」取该末端的 switch
  return (
    <Badge variant={m.selected ? 'blue' : 'gray'} style={dim ? { opacity: 0.8 } : undefined} data-selected={m.selected}>
      {!dim && <span className="dot" style={{ width: 5, height: 5, color: m.on ? 'var(--green-2)' : '#cbd5e1' }} />}{m.name} {m.on ? '开' : '关'}
    </Badge>
  )
}

/** 结果条文案。结果未知时按回读状态说明：只有回读成功才说「已重新读取」 */
function resultText(res: WriteResult, r: RoomView | null): string {
  if (res.outcome !== 'unknown') return res.text
  const head = `下发结果未知：${res.text}。`
  if (res.readback === 'pending') return head + '正在重新读取面板当前值…'
  if (res.readback === 'fail') return head + '重新读取面板失败，无法核对，请稍后刷新页面核对后再决定是否重试。'
  if (!r) return head + '已重新读取，请核对后再决定是否重试。'
  return head + `已重新读取面板当前值：房间${r.on ? '开启' : '关闭'}，设定温度 ${fmt1(r.setTemp)}°C，节能模式 ${r.eco === null ? '--' : ecoLabel(r.eco)}。请核对后再决定是否重试。`
}

interface RoomCardProps {
  room: RoomView
  ctx: EditCtx
  range: TempRange
  selected: boolean
  onSelect: () => void
  draft: RoomDraft | null
  /** 编辑期间面板值被外部修改的项 */
  conflict: ('temp' | 'eco')[]
  onEdit: (patch: { temp?: number; eco?: 0 | 1 }) => void
  onDiscard: () => void
  /** 本项目的下发锁（任何阶段，含结果未知待核对）；持锁期间全部禁用 */
  lock: Lock | null
  result: WriteResult | null
  freshRooms: (signal?: AbortSignal) => Promise<RoomView[]>
}

function RoomCard({ room: r, ctx, range, selected, onSelect, draft, conflict, onEdit, onDiscard, lock, result, freshRooms }: RoomCardProps) {
  // 确认与当前项目都在真正发起下发的这个组件里取：卸载、离开、换项目时确认按取消结算
  const confirm = useConfirm()
  const { project } = useCurrentProject()
  const latest = useLatest({ project, room: r, draft, ctx })
  const present = usePresent()

  const off = !r.on
  const block = editBlock(r, ctx)
  const swBlock = switchBlock(r, ctx)
  const tBlock = tempBlock(r, draft)
  const mine = !!lock && lock.target === r.key && lock.phase !== 'unknown-locked'
  const isBusy = lock !== null
  const changes = draftChanges(r, draft)
  const dirty = hasDraftChanges(changes)
  const shownTemp = draft?.temp ?? r.setTemp
  const shownEco = draft?.eco ?? r.eco
  const canEdit = !block && !isBusy

  /** 确认返回后的同步核对失败：不下发，提示重新确认 */
  const abort = (why: string) => showToast(`${r.name}：${why}，本次未下发，请重新核对后再下发`, true)

  /**
   * 确认之后交给下发状态机（features/thermostat/writes.ts）：持项目锁 → 新读一次 200 → 用新读数重新组装并与确认时比对 →
   * 一致才经统一写入口下发 → 写后新读一次 200 回读
   */
  async function submit(p: Project, confirmed: { query: WriteQuery201; draft: RoomDraft | null }, okText: string, kind: 'set' | 'switch', v?: boolean) {
    return runOp({
      projectId: p.id, target: r.key, subject: r.name, okText, toast: showToast,
      present: () => present.current && latest.current.project?.id === p.id,
      preflight: async (signal) => {
        const list = await freshRooms(signal)
        const fresh = list.find((x) => x.key === r.key)
        if (!fresh) return { ok: false, reason: '房间已不在面板列表里' }
        const cur = latest.current.project
        if (!cur || cur.id !== p.id) return { ok: false, reason: '当前项目已变化' }
        const c = { online: cur.online === true, fresh: true }
        const again = kind === 'set' ? buildRoomSet(fresh, confirmed.draft, c, range) : buildRoomSwitch(fresh, v!, c)
        if (!again.ok) return { ok: false, reason: again.reason }
        const changed = !sameQuery(again.query, confirmed.query) || fresh.on !== r.on || fresh.connected !== r.connected
          || (kind === 'set' && (!sameNum(fresh.setTemp, r.setTemp) || fresh.eco !== r.eco))
        if (changed) return { ok: false, reason: '确认后重新读取到的面板状态与确认时不一致' }
        return { ok: true, payload: again.query }
      },
      send: (q) => thermostatSource().setRoom(p, q),
      verify: (signal) => freshRooms(signal),
    })
  }

  async function send() {
    const p0 = project
    if (!p0 || lockOf(p0.id)) return
    const built = buildRoomSet(r, draft, ctx, range)
    if (!built.ok) { showToast(built.reason, true); return }
    const okText = `${r.name} 已下发：${describeResult(changes)}`
    const ok = await confirm({ title: '下发房间设置', body: <>将向 <b>{p0.name}</b>（<span className="num">{p0.code}</span>）的「{r.name}」下发：{describeChanges(changes)}，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    const now = latest.current
    const p = now.project
    if (!p || p.id !== p0.id) return abort('当前项目已变化')
    if (lockOf(p.id)) return abort('有下发正在进行')
    const out = await submit(p, { query: built.query, draft: now.draft }, okText, 'set')
    // 成功：草稿已生效（回读完成后才丢）；确定失败：回退为面板当前值；结果未知 / 中止：保留草稿
    if (out === 'ok' || out === 'fail') onDiscard()
  }

  async function toggle(v: boolean) {
    const p0 = project
    if (!p0 || lockOf(p0.id) || dirty) return
    const built = buildRoomSwitch(r, v, ctx)
    if (!built.ok) { showToast(built.reason, true); return }
    const ok = await confirm({ title: v ? '开启房间' : '关闭房间', body: <>将向 <b>{p0.name}</b>（<span className="num">{p0.code}</span>）的「{r.name}」下发「{v ? '开启' : '关闭'}」指令，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    const now = latest.current
    const p = now.project
    if (!p || p.id !== p0.id) return abort('当前项目已变化')
    if (lockOf(p.id)) return abort('有下发正在进行')
    if (hasDraftChanges(draftChanges(now.room, now.draft))) return abort('房间有未下发的修改')
    await submit(p, { query: built.query, draft: null }, `${r.name} 已${v ? '开启' : '关闭'}`, 'switch', v)
  }

  const step = (dir: 1 | -1) => { if (canEdit && !tBlock && shownTemp !== null) onEdit({ temp: stepTemp(shownTemp, dir, range) }) }
  const tempTitle = block ?? tBlock ?? undefined

  return (
    <Card pad={false} className={'room' + (selected ? ' sel' : '') + (off ? ' off' : '') + (mine ? ' busy' : '')} onClick={onSelect} data-room={r.key}>
      <div className="room-top">
        <div><div className="room-name">{r.name}</div><div className="room-id num">{r.key}{r.mode && ` · ${r.mode}`}</div></div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          {!r.connected ? <Badge variant="red"><Icon icon={faPlugCircleXmark} />面板离线</Badge>
            : off ? <Badge variant="gray">已关闭</Badge>
            : r.eco === 1 ? <Badge variant="amber"><Icon icon={faLeaf} />节能</Badge>
            : <Badge variant="gray" style={{ color: 'var(--muted)' }}>标准</Badge>}
          <Switch checked={r.on} onCheckedChange={(v) => void toggle(v)} disabled={isBusy || !!swBlock || dirty} title={swBlock ?? undefined}
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
            <button type="button" aria-label={`${r.name} 设定温度降低`} title={tempTitle}
              disabled={!canEdit || !!tBlock || shownTemp === null || !canStep(shownTemp, -1, range)} onClick={() => step(-1)}>−</button>
            <div className="v num" aria-label={`${r.name} 设定温度`}>{shownTemp === null ? '--' : fmtTemp(shownTemp)}<small>°C</small></div>
            <button type="button" aria-label={`${r.name} 设定温度升高`} title={tempTitle}
              disabled={!canEdit || !!tBlock || shownTemp === null || !canStep(shownTemp, 1, range)} onClick={() => step(1)}>+</button>
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
          <span>{lock?.phase === 'preflight' ? '正在重新读取面板，核对确认的内容 …'
            : lock?.phase === 'verifying' ? (result?.outcome === 'unknown' ? resultText(result, r) : '已下发，正在重新读取面板核对 …')
            : `正在下发到控制屏${dirty ? `：${describeResult(changes)}` : ''} …`}</span>
          <Button variant="primary" disabled>下发中</Button>
        </div>
      ) : conflict.length ? (
        <div className="te-bar fail" role="alert" onClick={(e) => e.stopPropagation()}>
          <span>面板{conflict.map((c) => (c === 'temp' ? '设定温度' : '节能模式')).join('、')}已在外部变化（现为 {conflict.includes('temp') ? `${fmt1(r.setTemp)}°C` : ''}{conflict.length > 1 ? '，' : ''}{conflict.includes('eco') && r.eco !== null ? ecoLabel(r.eco) : ''}），未下发的修改需要重新核对。</span>
          <Button onClick={onDiscard}>放弃修改</Button>
        </div>
      ) : dirty ? (
        <div className="te-bar pending" onClick={(e) => e.stopPropagation()}>
          <span>待下发：<b className="num">{describeChanges(changes)}</b></span>
          <span className="row">
            <Button onClick={onDiscard} disabled={isBusy}>取消</Button>
            <Button variant="primary" onClick={() => void send()} disabled={isBusy || !!block}>下发</Button>
          </span>
        </div>
      ) : null}
      {result && !mine && (
        <div className={'te-bar ' + (result.outcome === 'ok' ? 'pending' : 'fail')} role={result.outcome === 'ok' ? 'status' : 'alert'} onClick={(e) => e.stopPropagation()}>
          <span>{resultText(result, r)}</span>
          <span className="row">
            <Button onClick={() => project && clearResult(project.id, r.key)}>知道了</Button>
            {result.outcome === 'unknown' && result.readback === 'ok' && dirty && !conflict.length && <Button onClick={() => void send()} disabled={isBusy || !!block}>重试</Button>}
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

const CLEARED_TEXT = { gone: '已不在面板列表里', blocked: '已不能设置（房间关闭、面板或项目离线、读取失败）', applied: '' }

export default function Thermostat() {
  const { project } = useCurrentProject()
  const caps = useCapabilities(project)
  // 全部开关（206）与「放弃草稿」的确认在本组件发起
  const confirm = useConfirm()
  const rooms = useRooms(project, caps.thermostat)
  const freshRooms = useFreshRooms(project)
  const writes = useWrites(project?.id ?? '')
  const [sel, setSel] = useState('')
  const [range, setRange] = useState<StatsRange>('24小时')
  // 草稿带上所属项目：切换项目即作废（演示数据的房间编号在不同项目里重复）
  const [draftState, setDraftState] = useState<{ pid: string; d: RoomDraft | null }>({ pid: '', d: null })
  const pid = project?.id ?? ''
  const rawDraft = draftState.pid === pid ? draftState.d : null
  const setDraft = (u: RoomDraft | null | ((d: RoomDraft | null) => RoomDraft | null)) =>
    setDraftState((st) => {
      const cur = st.pid === pid ? st.d : null
      return { pid, d: typeof u === 'function' ? u(cur) : u }
    })
  const list = rooms.data
  const statRoom = list?.find((r) => r.key === sel) ?? list?.[0]
  const stats = useRoomStats(project, statRoom, range, caps.thermostat)
  // 后端以后在接口里给设定范围，现在回退 16 / 30 / 0.5
  const tempRange = resolveTempRange(null)
  const online = project?.online === true
  // 最近一次读取失败（有旧数据）时不允许下发
  const ctx: EditCtx = { online, fresh: !rooms.isError }
  const real = thermostatSource().kind === 'real'
  const draftRoom = rawDraft ? list?.find((x) => x.key === rawDraft.key) : undefined
  const rec = reconcileDraft(rawDraft, draftRoom, ctx)
  const draft = rec.draft
  const latest = useLatest({ project, online, list })
  const present = usePresent()

  // 草稿生命周期：回读后不能设置 / 已生效的草稿真正清除（不只是不显示），清除原因提示一次
  useEffect(() => {
    if (!rawDraft || !list) return
    const r = reconcileDraft(rawDraft, list.find((x) => x.key === rawDraft.key), { online, fresh: !rooms.isError })
    if (r.draft === rawDraft) return
    // 回读是外部数据源：读到新状态后同步整理草稿（有意在 effect 里更新状态，只在草稿确实变化时）
    setDraftState({ pid, d: r.draft })
    if (r.cleared === 'gone' || r.cleared === 'blocked') showToast(`「${draftRoom?.name ?? rawDraft.key}」${CLEARED_TEXT[r.cleared]}，未下发的修改已清除`, true)
  }, [rawDraft, list, online, rooms.isError, draftRoom?.name, pid])

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
  const lock = writes.lock
  const busy = lock !== null
  const allResult = writes.result(ALL)
  const lockText = !lock ? '' : lock.phase === 'unknown-locked'
    ? (writes.mine ? `上次下发（${lock.subject}）结果未知，为避免重复下发，本项目已暂停下发。` : '本项目上一次下发（不是本次登录发起的）结果未知，已暂停下发。')
      + (lock.checking ? '正在核对 …' : '请点「核对」重新读取面板，读取成功后恢复。')
    : lock.target === ALL || !writes.mine ? (lock.phase === 'preflight' ? '正在重新读取面板，核对确认的内容 …' : lock.phase === 'sending' ? '正在下发到控制屏 …' : '已下发，正在重新读取面板核对 …')
      : ''

  const onEdit = async (key: string, patch: { temp?: number; eco?: 0 | 1 }) => {
    const room = list.find((x) => x.key === key)
    if (!room) return
    if (draft && draft.key !== key) {
      const other = list.find((x) => x.key === draft.key)
      if (other && hasDraftChanges(draftChanges(other, draft))) {
        const ok = await confirm({ title: '放弃未下发的修改', body: <>「{other.name}」还有未下发的修改（{describeChanges(draftChanges(other, draft))}），放弃并改为修改「{room.name}」？</>, okText: '放弃修改' })
        if (!ok) return
      }
      setDraft(editDraft(room, null, patch))
      return
    }
    setDraft(editDraft(room, draft, patch))
  }

  const all = async (v: boolean) => {
    const p0 = project
    if (lockOf(p0.id) || !online) return
    const keys = list.map((r) => r.key).join(',')
    const subject = `全部${v ? '开启' : '关闭'}`
    const okText = `已下发：${subject}（${list.length} 个房间）`
    const ok = await confirm({ title: subject, body: <>将向 <b>{p0.name}</b>（<span className="num">{p0.code}</span>）的 {list.length} 个温控面板下发「{v ? '开启' : '关闭'}」指令，确定继续？</>, okText: '确认下发', danger: !v })
    if (!ok) return
    const now = latest.current
    const p = now.project
    const abort = (why: string) => showToast(`${subject}：${why}，本次未下发，请重新确认`, true)
    if (!p || p.id !== p0.id) return abort('当前项目已变化')
    if (!now.online) return abort('项目已离线')
    if (lockOf(p.id)) return abort('有下发正在进行')
    // 同样走状态机：确认后新读一次房间列表，范围（房间数与房间）变了就取消，要求按新列表重新确认
    await runOp({
      projectId: p.id, target: ALL, subject, okText, toast: showToast,
      present: () => present.current && latest.current.project?.id === p.id,
      preflight: async (signal) => {
        const fresh = await freshRooms(signal)
        const cur = latest.current.project
        if (!cur || cur.id !== p.id || cur.online !== true) return { ok: false, reason: '项目已变化或已离线' }
        if (fresh.map((r) => r.key).join(',') !== keys) return { ok: false, reason: `房间列表已变化（现为 ${fresh.length} 个）` }
        return { ok: true, payload: v }
      },
      send: (on) => thermostatSource().setAll(p, on),
      verify: (signal) => freshRooms(signal),
    })
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
      {lockText && (
        <div className={'te-bar ' + (lock?.phase === 'unknown-locked' ? 'fail' : 'sending')} role={lock?.phase === 'unknown-locked' ? 'alert' : 'status'} style={{ margin: '0 0 16px' }} data-lock={lock?.phase}>
          <span>{lockText}</span>
          {lock?.phase === 'unknown-locked' && <Button disabled={lock.checking} onClick={() => void checkLocked(project.id, (signal) => freshRooms(signal))}>核对</Button>}
        </div>
      )}
      {allResult && lock?.target !== ALL && (
        <div className={'te-bar ' + (allResult.outcome === 'ok' ? 'pending' : 'fail')} role={allResult.outcome === 'ok' ? 'status' : 'alert'} style={{ margin: '0 0 16px' }} data-result="all">
          <span>{resultText(allResult, null)}</span>
          <Button onClick={() => clearResult(project.id, ALL)}>知道了</Button>
        </div>
      )}
      <div className="hj-grid g4" style={{ marginBottom: 16 }}>
        <Card className="kpi"><div className="k-label">温控面板</div><div className="k-val">{sum.total}</div><div className="k-foot">{sum.connected === sum.total ? '全部在线' : `${sum.total - sum.connected} 个面板离线`}</div></Card>
        <Card className="kpi"><div className="k-label">已开启房间</div><div className="k-val green">{sum.on}</div><div className="k-foot">{sum.total - sum.on} 间关闭</div></Card>
        <Card className="kpi"><div className="k-label">节能模式</div><div className="k-val" style={{ color: 'var(--amber)' }}>{sum.eco}</div><div className="k-foot">间房间处于节能模式</div></Card>
        <Card className="kpi"><div className="k-label">平均室温 / 湿度</div><div className="k-val">{sum.avgTemp === null ? '--' : sum.avgTemp.toFixed(1)}°<small style={{ fontSize: 17 }}>/ {sum.avgHumidity === null ? '--' : Math.round(sum.avgHumidity)}%</small></div><div className="k-foot">平均露点 {fmt1(sum.avgDew)}°C</div></Card>
      </div>
      <div className="hj-grid g2">
        {list.map((r) => (
          <RoomCard key={r.key} room={r} ctx={ctx} range={tempRange} selected={statRoom?.key === r.key} onSelect={() => setSel(r.key)}
            draft={draft?.key === r.key ? draft : null} conflict={draft?.key === r.key ? rec.conflict : []}
            onEdit={(patch) => void onEdit(r.key, patch)} onDiscard={() => setDraft((d) => (d?.key === r.key ? null : d))}
            lock={lock} result={writes.result(r.key)} freshRooms={freshRooms} />
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
