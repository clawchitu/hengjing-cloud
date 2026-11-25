// 房间温控面板（S9）。读：ctrl 200（15 秒刷新）、209 统计；写：201 单房间设置 / 开关、206 全部开关。
// 下发一律经 src/features/thermostat/source.ts → src/api/ctrl.ts 的 writeCtrl()（S4 统一写入口 + 写防护）。
// 每次下发前在真正发起下发的组件里用 useConfirm() 确认（docs/分工.md 第 3 节第 7 条）；确认返回后同步读取最新的项目、
// 房间读数和草稿重新核对，任何不一致都取消本次下发，要求重新确认。互斥用共用写锁（src/api/writeLock.ts，按控制屏），
// 流程在 features/thermostat/writes.ts，离开页面 / 切项目 / 刷新后锁仍然有效。
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
import { lockKeysOf, lockOf, onForceReread, OTHER_ACCOUNT_TEXT, verify, type FieldResult, type LockInfo } from '../api/writeLock'
import { describeFields, verdictOf } from '../api/writeLockVerify'
import { roomSwitchReported } from '../api/config'
import type { CtrlReply } from '../api/ctrl'
import {
  ALL, allRoomsTarget, roomTargetIssue, buildRoomSet, buildRoomSwitch, canStep, clearResult, describeChanges, describeDraft, describeResult, draftChanges, ecoLabel,
  editBlock, editDraft, endBlock, END_CHANGED_TEXT, END_MIN_TEXT, END_SWITCH_TIP, fmtTemp, sameEnds, shownEnds, toggleEnd, hasDraftChanges, isLocked, knownOff, match201, match206, noteCurrentProject, reconcileDraft, record201, record206,
  resolveTempRange, runOp, sameQuery, stepTemp, summarize, switchBlock, SWITCH_UNREPORTED_NOTE, tempBlock, TEMP_OFF_NOTE, thermostatSource, useRooms, useRoomsRaw, useRoomStats,
  useWrites, useFreshRead, windLabel,
  type ChartData, type FreshRead, type WireEndMode, type EditCtx, type EndMode, type RoomDraft, type RoomView, type Running, type StatsRange, type TempRange, type WriteResult,
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

export const END_TAGS_TIP = '蓝色为参与运行的末端，灰色为不参与，点击切换；开 / 关 由控制屏根据运行情况自动控制，不能修改'
export const END_TAGS_TITLE = '末端（点击选择参与运行的末端）'

interface EndTagProps {
  m: EndMode
  /** 显示的选中状态（草稿优先，没有草稿取读数） */
  selected: boolean
  /** 与读数不同（草稿里改过） */
  dirty: boolean
  /** is_change = false：不能改（已选中的标「不可取消」） */
  locked: boolean
  /** 不能点的原因（面板离线、下发进行中等）；null = 可以点 */
  disabled: string | null
  dim?: boolean
  roomName: string
  onToggle: () => void
}

function EndTag({ m, selected, dirty, locked, disabled, dim, roomName, onToggle }: EndTagProps) {
  // 改动文档：is_selected 选中蓝色、未选中灰色；后面的「开 / 关」取该末端的 switch（只读，由控制屏自动控制）。
  // 名称部分可点：切换「选中」进草稿；is_change = false 的末端点击只给提示（onToggle 里由 toggleEnd 给出原因）
  const inert = !!disabled
  return (
    <button type="button" className={'end-tag' + (dirty ? ' dirty' : '') + (locked ? ' locked' : '')} data-selected={selected} aria-pressed={selected}
      aria-disabled={inert || locked} disabled={inert} aria-label={`${roomName} 末端 ${m.name}`}
      title={disabled ?? (locked ? (selected ? `「${m.name}」不可取消` : `「${m.name}」不允许修改`) : selected ? '点击取消选中' : '点击选中')}
      onClick={(e) => { e.stopPropagation(); onToggle() }}>
      <Badge variant={selected ? 'blue' : 'gray'} style={dim ? { opacity: 0.8 } : undefined} data-selected={selected}>
        {!dim && <span className="dot" style={{ width: 5, height: 5, color: m.on ? 'var(--green-2)' : '#cbd5e1' }} />}{m.name} <span className="end-sw" title={END_SWITCH_TIP} data-end-switch="">{m.on ? '开' : '关'}</span>
        {locked && selected && <span className="end-lock">不可取消</span>}
      </Badge>
    </button>
  )
}

/** 四态文案（docs/分工.md 第 4 节，Fable 版） */
const VERDICT_TEXT: Record<FieldResult, string> = {
  applied: '已生效', unchanged: '指令已下发，设备状态暂未变化', unverifiable: '该项暂无回读，无法确认', unknown: '已下发，结果未知',
}
/** 逐字段的短文案 */
const FIELD_STATE: Record<FieldResult, string> = { applied: '已生效', unchanged: '未生效（设备状态暂未变化）', unverifiable: '暂无回读，无法确认', unknown: '结果未知' }
/** 核对字段名（201 / 206 的写入字段） */
const FIELD_LABEL: Record<string, string> = { temperature: '设定温度', eco: '节能模式', switch: '开关', ends: '末端选择' }

/** 逐字段列表：「设定温度：未生效（设备状态暂未变化）；节能模式：暂无回读，无法确认」（只有一个字段时不列） */
function fieldsText(fields: Readonly<Record<string, FieldResult>> | undefined): string {
  const es = Object.entries(fields ?? {})
  if (es.length < 2) return ''
  return es.map(([k, v]) => `${FIELD_LABEL[k] ?? k}：${FIELD_STATE[v]}`).join('；')
}

/** 房间开关未上报期间，开关类下发判无法核对时补一句（写锁 2 分钟到期才放，避免现场以为点了没反应） */
const switchNote = (r: WriteResult) => (!roomSwitchReported() && r.fields?.switch === 'unverifiable' && !r.ended && !r.settling ? `${SWITCH_UNREPORTED_NOTE}。` : '')
/** 结果条用正常样式（已生效，或已下发正在核对）还是警示样式（失败、未变化、无法核对、结果未知） */
const isGood = (r: WriteResult) => r.outcome === 'ok' && (r.settling === true || (r.verdict === undefined ? r.readback === 'pending' : r.verdict === 'applied'))

/** 结果条文案：确定失败给原因；已下发 / 结果未知按回读核对的四态（整体作标题，混合时附摘要与逐字段） */
function resultText(res: WriteResult): string {
  if (res.outcome === 'fail') return res.text
  if (res.ended === 'expired') {
    const last = res.verdict && res.verdict !== 'applied' ? `${VERDICT_TEXT[res.verdict]}（最近一次核对）` : '已下发，结果未确认'
    return `${last}。写锁有效期已到、仍未核对一致，已恢复下发；请以面板读数为准。`
  }
  if (res.readback === 'waiting') return `下发结果未知：${res.text}。等控制屏结束上一条指令后自动核对 …`
  // 还在自动核对（首次回读不一致 / 读不到、退避还没用完）：不报结论（赤兔 11/25）
  if (res.readback === 'pending' || res.settling) return res.outcome === 'unknown' ? `下发结果未知：${res.text}。正在核对 …` : '已下发，正在核对 …'
  if (res.readback === 'fail') return '已下发，结果未知（回读失败）。可在上方点「核对」再试，或等到期后自动恢复。'
  if (!res.verdict) return res.text
  if (res.verdict === 'applied') return res.text.startsWith('已下发') ? VERDICT_TEXT.applied : res.text
  const sum = describeFields(res.fields ?? {})
  const list = fieldsText(res.fields)
  return `${VERDICT_TEXT[res.verdict]}${sum && list ? `（${sum}）` : ''}。${list ? list + '。' : ''}本项目暂停下发，自动再核对或到期后恢复。`
}

interface RoomCardProps {
  room: RoomView
  ctx: EditCtx
  range: TempRange
  selected: boolean
  onSelect: () => void
  draft: RoomDraft | null
  /** 编辑期间面板值被外部修改的项 */
  conflict: ('temp' | 'eco' | 'ends')[]
  onEdit: (patch: { temp?: number; eco?: 0 | 1; ends?: boolean[] }) => void
  onDiscard: () => void
  /** 这份草稿已交给一次下发、待确认（与写锁是否还在无关）：普通轮询不整理、不清除，直到核对一致、确定失败或用户放弃 */
  pending: boolean
  /** 标记 / 取消「待确认」 */
  onPending: (on: boolean) => void
  /** 本项目（按控制屏）的写锁：任何阶段（含结果未知待核对）都禁用全部下发 */
  lock: LockInfo | null
  /** 本标签正在进行的一次下发（界面阶段） */
  running: Running | null
  result: WriteResult | null
  /** 新读一次 200，同时给出原始读数（写后核对用） */
  freshRead: (signal?: AbortSignal, opts?: { defer?: boolean }) => Promise<FreshRead>
  /** 最近一次读到的原始 200（确认前查目标设备 ID 是否恰好出现一次） */
  raw: Pick<CtrlReply<200>, 'data'> | undefined
}

function RoomCard({ room: r, ctx, range, selected, onSelect, draft, conflict, onEdit, onDiscard, pending, onPending, lock, running, result, freshRead, raw }: RoomCardProps) {
  // 确认与当前项目都在真正发起下发的这个组件里取：卸载、离开、换项目时确认按取消结算
  const confirm = useConfirm()
  const { project } = useCurrentProject()
  const latest = useLatest({ project, room: r, draft, ctx })
  const present = usePresent()

  // 开关未上报（roomSwitchReported = false）时不当作关着：不置灰、不禁用温度和节能，开关处显示「未知」
  const off = knownOff(r)
  const block = editBlock(r, ctx)
  const swBlock = switchBlock(r, ctx)
  const tBlock = tempBlock(r, draft)
  const mine = running?.target === r.key
  const isBusy = lock !== null || running !== null
  const changes = draftChanges(r, draft)
  const dirty = hasDraftChanges(changes)
  const shownTemp = draft?.temp ?? r.setTemp
  const shownEco = draft?.eco ?? r.eco
  const canEdit = !block && !isBusy
  // 末端：房间关着也可以改（endBlock 不看房间开关）；下发进行中不能改
  const endBlk = endBlock(r, ctx)
  const endSel = shownEnds(r, draft)
  const endNames = r.endModes.map((m) => m.name)
  const endsEmpty = !!changes.ends && !changes.ends[1].some(Boolean)
  // 下发按钮的禁用原因：只改末端时按 endBlock（房间关着也能发），否则按 editBlock；末端全不选时禁用
  const sendBlock = (changes.ends && !changes.temp && !changes.eco ? endBlk : block) ?? (endsEmpty ? END_MIN_TEXT : null)
  const clickEnd = (i: number) => {
    if (isBusy) return
    const t = toggleEnd(r, draft, i, ctx)
    if (!t.ok) { showToast(`${r.name}：${t.reason}`, true); return }
    onEdit({ ends: t.ends })
  }

  /** 确认返回后的同步核对失败：不下发，提示重新确认 */
  const abort = (why: string) => showToast(`${r.name}：${why}，本次未下发，请重新核对后再下发`, true)

  /**
   * 确认之后交给下发流程（features/thermostat/writes.ts）：取共用写锁（按控制屏）→ 新读一次 200 → 用新读数重新组装并与
   * 确认时比对 → 一致才认领写锁并经统一写入口下发 → 写后新读一次 200 回读（结果未知时由写锁核对）
   */
  async function submit(p: Project, confirmed: { query: WriteQuery201; draft: RoomDraft | null; ends?: WireEndMode[] }, okText: string, kind: 'set' | 'switch', v?: boolean, onApplied?: () => void) {
    return runOp({
      project: p, target: r.key, subject: r.name, okText, toast: showToast, onApplied, retry: kind === 'set' ? 'set' : v ? 'on' : 'off',
      present: () => present.current && latest.current.project?.id === p.id,
      preflight: async (signal) => {
        const read = await freshRead(signal)
        // 原始 200 里目标设备 ID 必须恰好一次（重复时 find 取到的那条不一定是用户选的房间，末端也不可靠）
        const issue = roomTargetIssue(read.raw, r.equipmentId)
        if (issue) return { ok: false, reason: issue }
        const fresh = read.list.find((x) => x.key === r.key)
        if (!fresh) return { ok: false, reason: '房间已不在面板列表里' }
        // 改了末端：新读到的末端（个数、顺序、名称、类型、is_change、is_selected）必须与确认时的原始读数完全一致（switch 不比）
        if (confirmed.ends && !sameEnds(fresh.wireEndModes, confirmed.ends)) return { ok: false, reason: END_CHANGED_TEXT }
        const cur = latest.current.project
        if (!cur || cur.id !== p.id) return { ok: false, reason: '当前项目已变化' }
        const c = { online: cur.online === true, fresh: true }
        const again = kind === 'set' ? buildRoomSet(fresh, confirmed.draft, c, range) : buildRoomSwitch(fresh, v!, c)
        if (!again.ok) return { ok: false, reason: again.reason }
        const changed = !sameQuery(again.query, confirmed.query) || fresh.switchKnown !== r.switchKnown || (r.switchKnown && fresh.on !== r.on) || fresh.connected !== r.connected
          || (kind === 'set' && (!sameNum(fresh.setTemp, r.setTemp) || fresh.eco !== r.eco))
        if (changed) return { ok: false, reason: '确认后重新读取到的面板状态与确认时不一致' }
        return { ok: true, payload: again.query }
      },
      send: (q, beforeSend) => thermostatSource().setRoom(p, q, beforeSend),
      record: record201,
      read: async (signal) => (await freshRead(signal)).raw,
      readCandidate: async (signal) => { const x = await freshRead(signal, { defer: true }); return { data: x.raw, apply: x.apply, latest: x.latest } },
      matches: match201,
    })
  }

  async function send() {
    const p0 = project
    if (!p0 || isLocked(p0)) return
    const built = buildRoomSet(r, draft, ctx, range)
    if (!built.ok) { showToast(built.reason, true); return }
    const dupe = raw ? roomTargetIssue(raw, r.equipmentId) : null
    if (dupe) { showToast(`${r.name}：${dupe}，本次未下发，请重新核对后再下发`, true); return }
    const okText = `${r.name} 已生效：${describeResult(changes, endNames)}`
    // 确认时的末端原始读数（改了末端才需要）：确认返回后和预检新读各比一次
    const endsAtConfirm = changes.ends ? r.wireEndModes.map((m) => ({ ...m })) : undefined
    const ok = await confirm({ title: '下发房间设置', body: <>将向 <b>{p0.name}</b>的「{r.name}」下发：{describeChanges(changes, endNames)}，确定继续？{changes.temp && <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>{TEMP_OFF_NOTE}。</div>}</>, okText: '确认下发' })
    if (!ok) return
    const now = latest.current
    const p = now.project
    if (!p || p.id !== p0.id) return abort('当前项目已变化')
    if (isLocked(p)) return abort('有下发正在进行')
    if (endsAtConfirm && !sameEnds(now.room.wireEndModes, endsAtConfirm)) return abort(END_CHANGED_TEXT)
    // 下发开始：这份草稿进入「待确认」（与写锁分开维护）。只有写锁认可的核对全部一致（onApplied，含之后的自动再核对）、
    // 确定失败需回滚（fail），或用户点「放弃本次改动」才清；没发出（中止 / 被占）取消待确认、照常整理。
    // 待核对、回读失败、面板离线、目标缺失期间，以及写锁到期放开之后，普通轮询都不整理它（到期只恢复下发资格并强制重读）
    // 重新下发（上次未核对一致）：本次没发出（中止、被占、写防护、503 code 14、认领前断网）就恢复原来的待确认，
    // 不能因为这次没发出就当作上次已了结
    const wasPending = pending
    onPending(true)
    const out = await submit(p, { query: built.query, draft: now.draft, ends: endsAtConfirm }, okText, 'set', undefined, onDiscard)
    // ok（写锁认可的核对一致）/ fail（已发出被明确拒绝，回滚为面板值）才清；没发出（not-sent / 中止 / 被占）保留草稿、恢复原待确认
    if (out === 'ok' || out === 'fail') onDiscard()
    else if (out === 'not-sent' || out === 'aborted' || out === 'busy') onPending(wasPending)
  }

  async function toggle(v: boolean) {
    const p0 = project
    if (!p0 || isLocked(p0) || dirty) return
    const built = buildRoomSwitch(r, v, ctx)
    if (!built.ok) { showToast(built.reason, true); return }
    const dupe = raw ? roomTargetIssue(raw, r.equipmentId) : null
    if (dupe) { showToast(`${r.name}：${dupe}，本次未下发，请重新核对后再下发`, true); return }
    const ok = await confirm({ title: v ? '开启房间' : '关闭房间', body: <>将向 <b>{p0.name}</b>的「{r.name}」下发「{v ? '开启' : '关闭'}」指令，确定继续？</>, okText: '确认下发' })
    if (!ok) return
    const now = latest.current
    const p = now.project
    if (!p || p.id !== p0.id) return abort('当前项目已变化')
    if (isLocked(p)) return abort('有下发正在进行')
    if (hasDraftChanges(draftChanges(now.room, now.draft))) return abort('房间有未下发的修改')
    await submit(p, { query: built.query, draft: null }, `${r.name} 已${v ? '开启' : '关闭'}，已生效`, 'switch', v)
  }

  const step = (dir: 1 | -1) => { if (canEdit && !tBlock && shownTemp !== null) onEdit({ temp: stepTemp(shownTemp, dir, range) }) }
  const tempTitle = block ?? tBlock ?? undefined

  return (
    <Card pad={false} className={'room' + (selected ? ' sel' : '') + (off ? ' off' : '') + (mine ? ' busy' : '')} onClick={onSelect} data-room={r.key}>
      <div className="room-top">
        <div><div className="room-name">{r.name}</div>{r.mode && <div className="room-id">{r.mode}</div>}</div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          {!r.connected ? <Badge variant="red"><Icon icon={faPlugCircleXmark} />面板离线</Badge>
            : off ? <Badge variant="gray">已关闭</Badge>
            : r.eco === 1 ? <Badge variant="amber"><Icon icon={faLeaf} />节能</Badge>
            : <Badge variant="gray" style={{ color: 'var(--muted)' }}>标准</Badge>}
          {r.switchKnown ? (
            <Switch checked={r.on} onCheckedChange={(v) => void toggle(v)} disabled={isBusy || !!swBlock || dirty} title={swBlock ?? undefined}
              className="disabled:cursor-not-allowed disabled:opacity-50" aria-label={`${r.name} 开关`} />
          ) : (
            // 房间开关未上报：读数不可信，显示「未知」，开 / 关各一个按钮（仍然按确认、预检、核对的流程下发）
            <span className="row" style={{ gap: 6 }} data-switch="unknown">
              <span className="muted" style={{ fontSize: 12.5 }} title="控制屏暂未上报房间开关状态">开关未知</span>
              <Button onClick={() => void toggle(true)} disabled={isBusy || !!swBlock || dirty} title={swBlock ?? undefined} aria-label={`${r.name} 开启`}>开</Button>
              <Button onClick={() => void toggle(false)} disabled={isBusy || !!swBlock || dirty} title={swBlock ?? undefined} aria-label={`${r.name} 关闭`}>关</Button>
            </span>
          )}
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
      {/* 末端选择：点标签切换「选中」进草稿（201 end_modes 完整回传，写锁按 is_selected 逐个核对）；开 / 关只读 */}
      <div className={'modes-row' + (changes.ends ? ' dirty' : '')} onClick={(e) => e.stopPropagation()}>
        {r.endModes.length > 0 && <span className="ends-h" title={END_TAGS_TIP}>{END_TAGS_TITLE}</span>}
        {r.endModes.map((m, i) => (
          <EndTag key={`${m.type}:${m.name}:${i}`} m={m} selected={endSel[i] ?? m.selected} dirty={(endSel[i] ?? m.selected) !== m.selected}
            locked={r.wireEndModes[i]?.isChange === false} disabled={endBlk ?? (isBusy ? '有下发正在进行' : null)} dim={off} roomName={r.name} onToggle={() => clickEnd(i)} />
        ))}
        {endsEmpty && <span className="end-warn" role="alert">{END_MIN_TEXT}</span>}
      </div>
      {mine ? (
        <div className="te-bar sending" role="status" onClick={(e) => e.stopPropagation()}>
          <span>{running?.stage === 'preflight' ? '正在重新读取面板，核对确认的内容 …'
            : running?.stage === 'verifying' ? '已下发，正在核对 …'
            : `正在下发到控制屏${dirty ? `：${describeResult(changes, endNames)}` : ''} …`}</span>
          <Button variant="primary" disabled>下发中</Button>
        </div>
      ) : conflict.length ? (
        <div className="te-bar fail" role="alert" onClick={(e) => e.stopPropagation()}>
          <span>面板{conflict.map((c) => (c === 'temp' ? '设定温度' : c === 'eco' ? '节能模式' : '末端')).join('、')}已在外部变化{(conflict.includes('temp') || conflict.includes('eco')) && <>（现为 {[conflict.includes('temp') ? `${fmt1(r.setTemp)}°C` : '', conflict.includes('eco') && r.eco !== null ? ecoLabel(r.eco) : ''].filter(Boolean).join('，')}）</>}，未下发的修改需要重新核对。</span>
          <Button onClick={onDiscard}>放弃修改</Button>
        </div>
      ) : pending && draft ? (
        <div className="te-bar pending" data-pending="" onClick={(e) => e.stopPropagation()}>
          <span>{isBusy ? '已下发，待核对一致：' : '上次下发未核对一致：'}<b className="num">{dirty ? describeChanges(changes, endNames) : describeDraft(draft)}</b>{isBusy ? '' : '。可放弃本次改动，或以面板读数为准重新下发。'}</span>
          <span className="row">
            <Button onClick={onDiscard}>放弃本次改动</Button>
            {!isBusy && dirty && <Button variant="primary" onClick={() => void send()} disabled={!!sendBlock} title={sendBlock ?? undefined}>重新下发</Button>}
          </span>
        </div>
      ) : dirty ? (
        <div className="te-bar pending" onClick={(e) => e.stopPropagation()}>
          <span>待下发：<b className="num">{describeChanges(changes, endNames)}</b>{sendBlock && <span className="faint" data-block="">（{sendBlock}）</span>}</span>
          <span className="row">
            <Button onClick={onDiscard} disabled={isBusy}>取消</Button>
            <Button variant="primary" onClick={() => void send()} disabled={isBusy || !!sendBlock} title={sendBlock ?? undefined}>下发</Button>
          </span>
        </div>
      ) : null}
      {result && !mine && (
        <div className={'te-bar ' + (isGood(result) ? 'pending' : 'fail')} role={isGood(result) ? 'status' : 'alert'} onClick={(e) => e.stopPropagation()}>
          <span>{resultText(result)}{switchNote(result) && <> {switchNote(result)}</>}</span>
          <span className="row">
            {/* 控制屏实时预检（205）没通过、未下发：重新发起同一操作（照常再确认一次） */}
            {result.retry && <Button variant="primary" onClick={() => { const a = result.retry; if (project) clearResult(project.id, r.key); void (a === 'set' ? send() : toggle(a === 'on')) }}>重试</Button>}
            <Button onClick={() => project && clearResult(project.id, r.key)}>知道了</Button>
          </span>
        </div>
      )}
    </Card>
  )
}

const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8)

/**
 * 写锁的提示条与「核对」入口（常驻）。独立于房间列表渲染：空列表、首次读取失败、503 空态时也显示并可操作。
 * 别的账号发起的锁只给 OTHER_ACCOUNT_TEXT，不带 label、项目名、目标值（写锁的 lockOf 已置空）
 */
/**
 * 写锁结果未知 / 待核对时的标题与逐字段：按锁上 lastFields（最近一次核对的逐字段四态）——整体按 verdictOf 作标题，
 * 混合时附计数（「1 项未生效，1 项无法核对」），再逐项列出「设定温度：未生效（…）」。还没核对过（没有 lastFields）时按
 * outcome 说「已下发，结果未知」/「结果未知」。只给同账号看（别的账号的锁 lockOf 不带 lastFields，页面也只用泛化提示）
 */
function lockTitle(lock: LockInfo): { title: string; fields: [string, FieldResult][] } {
  // 还在自动核对（settling，含一致但在提交这一刻被否决）：只显示正在核对，不报结论、不列字段；退避用完或到期后才显示四态
  if (lock.lastVetoed || lock.settling) return { title: lock.outcome === 'unknown' ? '下发结果未知，正在核对…' : '已下发，正在核对…', fields: [] }
  const fields = Object.entries(lock.lastFields ?? {})
  if (!fields.length) return { title: lock.outcome === 'ok' ? '已下发，结果未知' : '结果未知', fields }
  const sum = describeFields(lock.lastFields!)
  const mixed = new Set(fields.map(([, v]) => v)).size > 1 && sum ? `（${sum}）` : ''
  return { title: `${VERDICT_TEXT[verdictOf(fields.map(([, v]) => v))]}${mixed}`, fields }
}

function LockBar({ lock, running }: { lock: LockInfo | null; running: Running | null }) {
  if (!lock) return null
  // 本会话在单个房间上的进行中阶段（含已下发、正在核对）由房间卡显示
  if (running && running.target !== ALL && lock.mine) return null
  const unknown = lock.phase === 'unknown'
  // 逐字段只给本账号的锁（恢复 / 本标签）；别的账号、别的标签页同步来的锁不列
  const t = unknown && lock.owner !== 'other-account' && lock.origin !== 'synced' ? lockTitle(lock) : null
  const subject = lock.label ? `（${lock.label}）` : ''
  const head = !unknown ? (running?.stage === 'preflight' ? '正在重新读取面板，核对确认的内容 …' : running ? '正在下发到控制屏 …'
      : '同一控制屏上有一条下发正在进行，暂不能下发。')
    : lock.owner === 'other-account' ? OTHER_ACCOUNT_TEXT
    : lock.origin === 'synced' ? '另一个标签页的下发结果未知，本项目暂停下发，等那边结束或到期后自动恢复。'
    : `上次下发${subject}：${t!.title}。为避免重复下发，本项目（同一控制屏）已暂停下发。`
  const tail = !unknown ? '' : lock.verifying ? (t && lock.settling ? '' : '正在核对 …')
    : !lock.sendSettled ? '上一条指令尚未结束，结束后会自动核对。'
    : `可点「核对」重新读取面板，一致即恢复；${lock.expiresAt ? `最迟 ${hhmmss(lock.expiresAt)} ` : ''}到期后自动恢复。`
  const check = async () => {
    const r = await verify(lock.key)
    if (r === 'released') showToast('核对一致，已恢复下发')
    // 还在自动核对（退避没用完）：不报结论
    // none = 没发起核对（已有核对在途等），不提示
    else if (r === 'none') return
    else if (lockOf(lock.key)?.settling && r !== 'send-pending' && r !== 'not-visible') showToast('暂未核对一致，稍后自动再核对，仍暂停下发', true)
    else if (r === 'send-pending') showToast('上一条指令尚未结束，暂不能核对', true)
    else if (r === 'mismatch') showToast('指令已下发，设备状态暂未变化，仍暂停下发', true)
    else if (r === 'unverifiable') showToast('该项暂无回读，无法确认，仍暂停下发', true)
    else if (r === 'offline') showToast('控制屏离线，暂时无法核对，可稍后再试', true)
    else if (r === 'not-visible') showToast(OTHER_ACCOUNT_TEXT, true)
    else if (r === 'failed' || r === 'account-changed') showToast('核对读取失败，仍暂停下发，可再次核对', true)
  }
  return (
    <div className={'te-bar ' + (unknown ? 'fail' : 'sending')} role={unknown ? 'alert' : 'status'} style={{ margin: '0 0 16px' }} data-lock={lock.phase}>
      <span>
        {head}{tail}
        {t && t.fields.length > 0 && (
          <ul className="lock-fields" data-lock-fields="">
            {t.fields.map(([k, v]) => <li key={k} data-field={k} data-state={v}>{FIELD_LABEL[k] ?? k}：{FIELD_STATE[v]}</li>)}
          </ul>
        )}
      </span>
      {unknown && lock.origin !== 'synced' && <Button disabled={lock.verifying || !lock.sendSettled} onClick={() => void check()}>核对</Button>}
    </div>
  )
}

function Empty({ project, title, children, lockBar }: { project: Project; title: string; children: React.ReactNode; lockBar?: React.ReactNode }) {
  return (
    <div className="page">
      <div className="page-head"><div><h1>房间温控面板</h1><div className="sub">{project.name}</div></div></div>
      {lockBar}
      <Card className="placeholder">
        <div className="ph-ico"><Icon icon={faFan} /></div>
        <h3>{title}</h3>
        <p>{children}</p>
      </Card>
    </div>
  )
}

const CLEARED_TEXT = { gone: '已不在面板列表里', blocked: '已不能设置（房间关闭、面板或项目离线）', applied: '' }

export default function Thermostat() {
  const { project } = useCurrentProject()
  const caps = useCapabilities(project)
  // 全部开关（206）与「放弃草稿」的确认在本组件发起
  const confirm = useConfirm()
  const writes = useWrites(project)
  // 写锁核对在途期间暂停 15 秒轮询（核对结束恢复）：减少核对读数与轮询读数交错
  const rooms = useRooms(project, caps.thermostat, writes.lock?.verifying === true)
  const rawRooms = useRoomsRaw(project, caps.thermostat)
  const freshRead = useFreshRead(project)
  const [sel, setSel] = useState('')
  const [range, setRange] = useState<StatsRange>('24小时')
  // 草稿带上所属项目：切换项目即作废（演示数据的房间编号在不同项目里重复）
  // pending：这份草稿已交给一次下发、待确认（见 RoomCard 的 send），与写锁分开维护；待确认期间不按普通轮询整理
  const [draftState, setDraftState] = useState<{ pid: string; d: RoomDraft | null; pending?: boolean }>({ pid: '', d: null })
  const pid = project?.id ?? ''
  const rawDraft = draftState.pid === pid ? draftState.d : null
  // 函数形式（放弃 / 核对一致后清除）只作用于本项目的草稿：迟到的回调（另一个项目那次渲染留下的）不动别的项目的草稿
  const setDraft = (u: RoomDraft | null | ((d: RoomDraft | null) => RoomDraft | null)) =>
    setDraftState((st) => {
      if (typeof u === 'function') return st.pid === pid ? { pid, d: u(st.d) } : st
      return { pid, d: u }
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
  const frozen = !!rawDraft && draftState.pending === true
  const markPending = (on: boolean) => setDraftState((st) => (st.pid === pid && st.d ? { ...st, pending: on } : st))
  const rec = frozen ? { draft: rawDraft, conflict: [] as ('temp' | 'eco' | 'ends')[] } : reconcileDraft(rawDraft, draftRoom, ctx)
  const draft = rec.draft
  const latest = useLatest({ project, online, list })
  // 下发状态机判断「是否仍在原项目」用实际解析出的当前项目（回退到第一个项目时不写存储）
  useLayoutEffect(() => { if (project) noteCurrentProject(project.id) }, [project])
  const lock = writes.lock
  const busy = lock !== null || writes.running !== null
  const lockBar = project ? <LockBar lock={lock} running={writes.running} /> : null
  // 写锁到期放开时发「强制重读」：属于本项目（任一锁键相同）就重读设备状态
  const refetchRooms = rooms.refetch
  useEffect(() => {
    if (!project) return
    const mine = new Set(lockKeysOf(project))
    return onForceReread((e) => { if (e.keys.some((k) => mine.has(k))) void refetchRooms() })
  }, [project, refetchRooms])
  const present = usePresent()
  // 写锁放开（核对一致、到期、别的标签页删除，含刷新恢复的锁——恢复锁的核对读数不写回缓存）：重读一次刷新卡片
  const lockKey = writes.lock?.key ?? null
  const prevLock = useRef<string | null>(null)
  useEffect(() => {
    if (prevLock.current && !lockKey) void refetchRooms()
    prevLock.current = lockKey
  }, [lockKey, refetchRooms])

  // 草稿生命周期：回读后不能设置 / 已生效的草稿真正清除（不只是不显示），清除原因提示一次
  useEffect(() => {
    if (!rawDraft || !list || frozen) return
    const r = reconcileDraft(rawDraft, list.find((x) => x.key === rawDraft.key), { online, fresh: !rooms.isError })
    if (r.draft === rawDraft) return
    // 回读是外部数据源：读到新状态后同步整理草稿（有意在 effect 里更新状态，只在草稿确实变化时）
    setDraftState({ pid, d: r.draft })
    if (r.cleared === 'gone' || r.cleared === 'blocked') showToast(`「${draftRoom?.name ?? '该房间'}」${CLEARED_TEXT[r.cleared]}，未下发的修改已清除`, true)
  }, [rawDraft, list, online, rooms.isError, draftRoom?.name, pid, frozen])

  if (!project) return <div className="page"><div className="empty-fav" role="status"><b>暂无可用项目</b></div></div>
  if (!caps.thermostat) return (
    <div className="page">
      <div className="page-head"><div><h1>房间温控面板</h1><div className="sub">{project.name}<span className="sep">·</span>程序 {PROGRAMS[project.programCode] ?? project.appName}</div></div></div>
      <Card className="placeholder">
        <div className="ph-ico"><Icon icon={faFan} /></div>
        <h3>该项目无房间温控面板</h3>
        <p>「{project.name}」为<b>新风单机版</b>项目，仅接入新风除湿机，不包含房间温控面板。<br />新风机的运行数据与运行设置请前往「新风除湿机」查看。</p>
      </Card>
    </div>
  )
  // 真实接口：项目离线不读控制屏（一定是 503），显示空态而不是旧数据
  if (real && !online) return <Empty project={project} lockBar={lockBar} title="控制屏未连接">项目离线，无法读取房间温控面板。项目恢复在线后自动刷新。</Empty>
  if (rooms.isError && !list) {
    const e = rooms.error
    if (isApiError(e) && e.kind === 'unavailable') return <Empty project={project} lockBar={lockBar} title="控制屏未连接">控制屏当前不在线，无法读取房间温控面板。<br /><Button style={{ marginTop: 14 }} onClick={() => void rooms.refetch()}>重试</Button></Empty>
    return (
      <Empty project={project} lockBar={lockBar} title="房间温控数据读取失败">
        {isApiError(e) ? e.message : '读取失败'}<br /><Button style={{ marginTop: 14 }} onClick={() => void rooms.refetch()}>重试</Button>
      </Empty>
    )
  }
  if (!list) return <div className="page">{lockBar}</div>
  if (list.length === 0) return <Empty project={project} lockBar={lockBar} title="未读到房间温控面板">控制屏没有返回房间温控面板数据。</Empty>

  const sum = summarize(list)
  const allResult = writes.result(ALL)

  const onEdit = async (key: string, patch: { temp?: number; eco?: 0 | 1; ends?: boolean[] }) => {
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
    if (isLocked(p0) || !online) return
    const subject = `全部${v ? '开启' : '关闭'}`
    // 206 控制项目全部房间：确认文案的房间数与核对集合都基于最近一次读到的原始 200 完整列表（不是过滤后的页面列表），
    // 确认后预检再新读一次核对；有房间 ID 为 0 / 无效或重复 → 无法逐个核对，不弹确认、不下发
    const target = rawRooms.data ? allRoomsTarget(rawRooms.data) : { ok: false as const, reason: '还没有读到面板数据' }
    if (!target.ok) { showToast(`${subject}：${target.reason}，本次未下发`, true); return }
    const ids = target.roomIds
    const okText = `已生效：${subject}（${ids.length} 个房间）`
    const ok = await confirm({ title: subject, body: <>将向 <b>{p0.name}</b>的 {ids.length} 个温控面板下发「{v ? '开启' : '关闭'}」指令，确定继续？</>, okText: '确认下发', danger: !v })
    if (!ok) return
    const now = latest.current
    const p = now.project
    const abort = (why: string) => showToast(`${subject}：${why}，本次未下发，请重新确认`, true)
    if (!p || p.id !== p0.id) return abort('当前项目已变化')
    if (!now.online) return abort('项目已离线')
    if (isLocked(p)) return abort('有下发正在进行')
    // 同样走状态机：确认后新读一次原始 200，目标集合（完整、有效、与确认时相同）变了就取消，要求按新列表重新确认
    await runOp({
      project: p, target: ALL, subject, okText, toast: showToast, retry: v ? 'on' : 'off',
      present: () => present.current && latest.current.project?.id === p.id,
      preflight: async (signal) => {
        const fresh = allRoomsTarget((await freshRead(signal)).raw)
        const cur = latest.current.project
        if (!cur || cur.id !== p.id || cur.online !== true) return { ok: false, reason: '项目已变化或已离线' }
        if (!fresh.ok) return { ok: false, reason: fresh.reason }
        if (fresh.roomIds.join(',') !== ids.join(',')) return { ok: false, reason: `房间列表已变化（现为 ${fresh.roomIds.length} 个）` }
        // 确认后预检读到的目标房间 id 集合：写锁核对（含刷新恢复）逐个检查，回读缺了的房间按无法核对
        return { ok: true, payload: { on: v, roomIds: fresh.roomIds } }
      },
      send: (q, beforeSend) => thermostatSource().setAll(p, q.on, beforeSend),
      record: record206,
      read: async (signal) => (await freshRead(signal)).raw,
      readCandidate: async (signal) => { const x = await freshRead(signal, { defer: true }); return { data: x.raw, apply: x.apply, latest: x.latest } },
      matches: match206,
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
      {lockBar}
      {allResult && writes.running?.target !== ALL && (
        <div className={'te-bar ' + (isGood(allResult) ? 'pending' : 'fail')} role={isGood(allResult) ? 'status' : 'alert'} style={{ margin: '0 0 16px' }} data-result="all">
          <span>{resultText(allResult)}{switchNote(allResult) && <> {switchNote(allResult)}</>}</span>
          <span className="row">
            {allResult.retry && <Button variant="primary" onClick={() => { const a = allResult.retry; clearResult(project.id, ALL); void all(a === 'on') }}>重试</Button>}
            <Button onClick={() => clearResult(project.id, ALL)}>知道了</Button>
          </span>
        </div>
      )}
      <div className="hj-grid g4" style={{ marginBottom: 16 }}>
        <Card className="kpi"><div className="k-label">温控面板</div><div className="k-val">{sum.total}</div><div className="k-foot">{sum.connected === sum.total ? '全部在线' : `${sum.total - sum.connected} 个面板离线`}</div></Card>
        <Card className="kpi"><div className="k-label">已开启房间</div><div className="k-val green">{sum.on ?? '--'}</div><div className="k-foot">{sum.on === null ? '房间开关未上报' : `${sum.total - sum.on} 间关闭`}</div></Card>
        <Card className="kpi"><div className="k-label">节能模式</div><div className="k-val" style={{ color: 'var(--amber)' }}>{sum.eco}</div><div className="k-foot">间房间处于节能模式</div></Card>
        <Card className="kpi"><div className="k-label">平均室温 / 湿度</div><div className="k-val">{sum.avgTemp === null ? '--' : sum.avgTemp.toFixed(1)}°<small style={{ fontSize: 17 }}>/ {sum.avgHumidity === null ? '--' : Math.round(sum.avgHumidity)}%</small></div><div className="k-foot">平均露点 {fmt1(sum.avgDew)}°C</div></Card>
      </div>
      <div className="hj-grid g2">
        {list.map((r) => (
          <RoomCard key={r.key} room={r} ctx={ctx} range={tempRange} selected={statRoom?.key === r.key} onSelect={() => setSel(r.key)}
            draft={draft?.key === r.key ? draft : null} conflict={draft?.key === r.key ? rec.conflict : []}
            onEdit={(patch) => void onEdit(r.key, patch)} onDiscard={() => setDraft((d) => (d?.key === r.key ? null : d))} pending={frozen && draft?.key === r.key} onPending={markPending}
            lock={lock} running={writes.running} result={writes.result(r.key)} freshRead={freshRead} raw={rawRooms.data} />
        ))}
      </div>
      <Card style={{ marginTop: 20 }}>
        <CardHeader><div><CardTitle>温度 / 湿度 / 露点 统计</CardTitle><CardDescription>{statRoom?.name} · {range === '24小时' ? '24 小时逐时数据' : `近${range === '7日' ? ' 7 ' : ' 30 '}日日均值`}</CardDescription></div>
          <div className="row" style={{ gap: 12 }}>
            <Select value={statRoom?.key ?? ''} onValueChange={setSel}>
              <SelectTrigger aria-label="统计房间" sizer={list.map((r) => r.name)} />
              <SelectContent>{list.map((r) => <SelectItem key={r.key} value={r.key}>{r.name}</SelectItem>)}</SelectContent>
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
