// 新风运行设置下发（204）：只组 OpSpec，流程直接用 src/features/thermostat/writes.ts 的 runOp（与 S9 同一个状态机，
// 共用写锁按控制屏加，和 201、203、206 互斥）。各环节（docs/plan-s10-s7.md S10c 的对照表、docs/HANDOFF.md 第 1 节）：
//   确认      页面（FreshAir.tsx 的设置面板，真正发起下发的组件）里 useConfirm()；确认后同步复核项目、锁、草稿
//   加锁      runOp 里 acquire(project)：用户点了确认之后才加；target `fa:<设备 id>` 只是结果条的标签，锁仍按控制屏
//   预检      新读 202 + 210（useFreshPair）：202 原始回包里目标设备 id 恰好一次、设备在线；210 的 id 相符；用这份新读的 210 调
//             build204 重新组装，与确认时的 Query 相同，且整份 210 读数（含没改的项、can_change、名称）与确认时相同，否则不发
//   发送前    record204 → checkSentRecord（runOp 里，不过就放锁并提示原因）
//   beforeSend sameSession() && sameProject() && present() && claim(token)，claim 在链末（runOp）
//   登记      拿到 Promise 立刻 markSent（runOp）
//   结果分类  classify → outcomeOf（runOp）
//   核对      requireVerify：新读 202 + 210（defer，候选读数写锁认可后才写缓存），match204 只比对改了的字段；一致时 commit 第一行
//             同步检查读数仍是最新（latest），不是就否决（runOp）
//   成功提示、清草稿  只在 commit 里（runOp 的 okText / onApplied）
// 前提：runOp 的进行中状态按项目 id 存；app 12 没有温控面板，同一项目不会同时有温控和新风下发，写锁本身也按屏互斥。
import { getConfig } from '@/api/config'
import type { WriteQuery } from '@/api/ctrl'
import type { WriteProject } from '@/api/guard'
import type { LockTarget } from '@/api/writeLock'
import type { FieldResult } from '@/api/writeLock'
import { describeFields } from '@/api/writeLockVerify'
import { can } from '@/data/session'
import { runOp, type RunResult, type WriteResult } from '@/features/thermostat/writes'
import { build204, sameQuery, sameSettings, TEXT_WRITE_FORBIDDEN, TEXT_WRITE_OFF, type FaDraft } from './edit'
import { FRESH_ROUTES, type FreshPair } from './hooks'
import { match204, reading210, record204, unitCount, type Verify204Read } from './lockVerify'
import type { SettingsView } from './model'
import { freshAirSource } from './source'

/** 结果条的标签（runOp 的 target）：不参与加锁 */
export const faTarget = (deviceId: number) => `fa:${deviceId}`
export const NOUN = '新风设置'

/** 确认时的内容：组装好的 Query、组装所用的 210 读数、草稿 */
export interface Confirmed { query: WriteQuery<204>; view: SettingsView; draft: FaDraft }

export type ReadPair = (signal: AbortSignal, opts?: { defer?: boolean }) => Promise<FreshPair>

export interface FreshAirOp {
  project: LockTarget & WriteProject
  deviceId: number
  /** 提示里的主语（设备名） */
  subject: string
  okText: string
  confirmed: Confirmed
  /** 新读 202 + 210（绑定这台设备） */
  read: ReadPair
  /** 现在的当前项目（确认后、预检时复核） */
  currentProject: () => { id: string; online?: boolean | null } | null
  /** 面板现在还能不能下发（freshAirWrite、204 权限）：null = 能 */
  writable: () => string | null
  present: () => boolean
  toast: (text: string, err?: boolean) => void
  onApplied?: () => void
}

/**
 * 面板只读的原因（与设备、读数无关的两条）：features.freshAirWrite = 'off'、账号没有 204 权限（permission_paths）；可以下发为 null。
 * 只管界面；写防护照常生效
 */
export function writableReason(): string | null {
  if (getConfig().features.freshAirWrite === 'off') return TEXT_WRITE_OFF
  if (!can(FRESH_ROUTES.write)) return TEXT_WRITE_FORBIDDEN
  return null
}

/** 预检里 202 的检查：目标设备 id 恰好出现一次且在线；不满足返回原因 */
export function unitIssue(pair: Pick<FreshPair, 'units'>, deviceId: number): string | null {
  const n = unitCount(pair.units, deviceId)
  if (n === 0) return '设备已不在新风设备列表里'
  if (n > 1) return '新风设备列表里这台设备的编号重复，无法确定下发对象'
  const u = (pair.units.data ?? []).find((x) => x.id === deviceId)!
  if (u.isConnected !== true) return '设备未连接'
  return null
}

const toVerify = (p: FreshPair): Verify204Read => ({ units: p.units, settings: reading210(p.settings) })

/** 执行一次 204 下发（见文件头） */
export function runFreshAirSet(o: FreshAirOp): Promise<RunResult> {
  const p = o.project
  return runOp<WriteQuery<204>, Verify204Read>({
    project: p, target: faTarget(o.deviceId), subject: o.subject, noun: NOUN, okText: o.okText, toast: o.toast, onApplied: o.onApplied,
    present: o.present,
    preflight: async (signal) => {
      const r = await o.read(signal)
      const issue = unitIssue(r, o.deviceId)
      if (issue) return { ok: false, reason: issue }
      const s = r.settings
      if (!s || s.kind !== 'ok') return { ok: false, reason: '没有读到这台新风设备的运行设置' }
      const cur = o.currentProject()
      if (!cur || cur.id !== p.id || cur.online !== true) return { ok: false, reason: '当前项目已变化或已离线' }
      const w = o.writable()
      if (w) return { ok: false, reason: w }
      const again = build204(s.view, s.raw, o.confirmed.draft, { online: true, fresh: true, connected: true, writable: null })
      if (!again.ok) return { ok: false, reason: again.reason }
      if (!sameQuery(again.query, o.confirmed.query) || !sameSettings(s.view, o.confirmed.view)) return { ok: false, reason: '确认后重新读取到的新风设置与确认时不一致' }
      return { ok: true, payload: again.query }
    },
    send: (q, beforeSend) => freshAirSource().setRunning(p, q, beforeSend),
    record: record204,
    read: async (signal) => toVerify(await o.read(signal)),
    readCandidate: async (signal) => { const x = await o.read(signal, { defer: true }); return { data: toVerify(x), apply: x.apply, latest: x.latest } },
    matches: (q, data) => match204(record204(q), data),
  })
}

// ---------------------------------------------------------------------------
// 结果条文案（docs/分工.md 第 4 节的表；与 src/pages/Thermostat.tsx 的 VERDICT_TEXT / resultText 同一口径，
// 字段名换成 204 的五项）

export const VERDICT_TEXT: Readonly<Record<FieldResult, string>> = Object.freeze({
  applied: '已生效', unchanged: '指令已下发，设备状态暂未变化', unverifiable: '该项暂无回读，无法确认', unknown: '已下发，结果未知',
})
export const FIELD_STATE: Readonly<Record<FieldResult, string>> = Object.freeze({ applied: '已生效', unchanged: '未生效（设备状态暂未变化）', unverifiable: '暂无回读，无法确认', unknown: '结果未知' })

/** 结果条用正常样式（已生效，或已下发正在核对）还是警示样式 */
export const isGood = (r: WriteResult) => r.outcome === 'ok' && (r.settling === true || (r.verdict === undefined ? r.readback === 'pending' : r.verdict === 'applied'))

/** 逐字段列表（只有一个字段时不列） */
export function fieldsText(fields: Readonly<Record<string, FieldResult>> | undefined, label: (k: string) => string): string {
  const es = Object.entries(fields ?? {})
  if (es.length < 2) return ''
  return es.map(([k, v]) => `${label(k)}：${FIELD_STATE[v]}`).join('；')
}

/** 结果条文案：确定失败给原因；已下发 / 结果未知按回读核对的四态；还在自动核对（settling）只显示「正在核对」 */
export function resultText(res: WriteResult, label: (k: string) => string): string {
  if (res.outcome === 'fail') return res.text
  if (res.ended === 'expired') {
    const last = res.verdict && res.verdict !== 'applied' ? `${VERDICT_TEXT[res.verdict]}（最近一次核对）` : '已下发，结果未确认'
    return `${last}。写锁有效期已到、仍未核对一致，已恢复下发；请以设备读数为准。`
  }
  if (res.readback === 'waiting') return `下发结果未知：${res.text}。等控制屏结束上一条指令后自动核对 …`
  if (res.readback === 'pending' || res.settling) return res.outcome === 'unknown' ? `下发结果未知：${res.text}。正在核对 …` : '已下发，正在核对 …'
  if (res.readback === 'fail') return '已下发，结果未知（回读失败）。可点「核对」再试，或等到期后自动恢复。'
  if (!res.verdict) return res.text
  if (res.verdict === 'applied') return res.text.startsWith('已下发') ? VERDICT_TEXT.applied : res.text
  const sum = describeFields(res.fields ?? {})
  const list = fieldsText(res.fields, label)
  return `${VERDICT_TEXT[res.verdict]}${sum && list ? `（${sum}）` : ''}。${list ? list + '。' : ''}本项目暂停下发，自动再核对或到期后恢复。`
}
