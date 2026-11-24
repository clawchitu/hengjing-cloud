// @vitest-environment jsdom
// 下发核对口径（Fable 11/24）：success=true 之后按下发后回读判结果。
// - 无法核对三种情况：a 没有房间条目；b 200 回包为空 {}；c 下发的字段 200 里根本没有（系统开关、运行模式）
// - 回读请求本身失败（网络错误、超时、非 2xx）单独算「结果未知」，不并进无法核对
// - 混合字段：能核对的照常判，整体按排序 B（Fable 11/25）：结果未知 > 未变化 > 无法核对 > 已生效；锁按字段判断，到期释放
// 回读走真实的 readUnifiedSnapshot（ctrl 200 解码 + summarizeRooms），fetch 用假后端替换；下发函数注入。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '@/api/auth'
import { setConfig } from '@/api/config'
import { encodeMessage } from '@/api/ctrl'
import { ApiError } from '@/api/errors'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { UnifiedCtrlSetQuery_OperatingMode as Mode } from '@/api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '@/api/http'
import { clearTokens, writeTokens } from '@/api/tokens'
import * as L from '@/api/writeLock'
import { fakeBackend, json, text } from '@/api/__tests__/helpers'
import { TEXT } from '../constants'
import { createUnifiedBatch, readUnifiedSnapshot, type BatchProject, type BatchSender, type UnifiedSnapshot } from '../batch'
import { match203, verifiable203 } from '../lock'
import { createUnifiedController, type UnifiedState } from '../machine'
import type { UnifiedContext, UnifiedDraft } from '../rules'

const CTX: UnifiedContext = { projectId: 'p1', projectCode: '240829001', projectName: '测试项目', appCode: 1, online: true }
type Room = { switch?: number; setTemp?: number; isConnected?: boolean }
const roomsBody = (data: Room[]) => json({ body: encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: data.map((r, i) => ({ id: i + 1, name: `房间${i + 1}`, ...r })) }) })
const OFF2: Room[] = [{ switch: 0, setTemp: 26, isConnected: true }, { switch: 0, setTemp: 26, isConnected: true }]
const ON2: Room[] = [{ switch: 1, setTemp: 26, isConnected: true }, { switch: 1, setTemp: 26, isConnected: true }]

beforeEach(() => {
  __resetHttpForTests(); clearTokens(); localStorage.clear()
  writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
  setCurrentUserId('u1')
  setConfig({ apiBase: '/api', apiEnv: 'test' })
  L.__resetWriteLockForTests(() => ({ user: 'u1', gen: 1 }))
})
afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

/** 下发前回读 OFF2；下发后回读由 after 决定（Response 或抛错） */
function backendWith(after: () => Response | Promise<Response>) {
  let n = 0
  return fakeBackend({ '/ctrl/room-temperature-data-get': () => (n++ === 0 ? roomsBody(OFF2) : after()) })
}
async function run(draft: UnifiedDraft, readBack: (id: string, s: AbortSignal) => Promise<UnifiedSnapshot> = readUnifiedSnapshot): Promise<UnifiedState<UnifiedSnapshot>> {
  const send = vi.fn(async () => ({ success: true, msg: '' }))
  const ctl = createUnifiedController<UnifiedSnapshot>({ getContext: () => CTX, readBack, toEcho: (s) => s, send, log: () => {} })
  expect(ctl.request(draft).status).toBe('confirming')
  const end = await ctl.confirm()
  expect(send).toHaveBeenCalledTimes(1)
  return end
}
const kinds = (s: UnifiedState<UnifiedSnapshot>) => ('mismatches' in s ? s.mismatches.map((m) => [m.field, m.kind]) : null)

describe('无法核对的三种情况（不能判成已生效或未变化）', () => {
  it('a. 200 里没有房间条目（data: []）→ 无法核对', async () => {
    backendWith(() => roomsBody([]))
    const end = await run({ roomSwitch: 1 })
    expect(end.status).toBe('unverifiable')
    expect(kinds(end)).toEqual([['roomSwitch', 'missing']])
  })

  it('b. 200 回包是空的 {} → 无法核对', async () => {
    backendWith(() => json({ body: '' }))
    const end = await run({ roomSwitch: 1, roomTemp: 26.5 })
    expect(end.status).toBe('unverifiable')
    expect(kinds(end)).toEqual([['roomSwitch', 'missing'], ['roomTemp', 'missing']])
  })

  it('b′. 200 外层 JSON 都是 {}（没有 body 字段）→ 同样无法核对', async () => {
    backendWith(() => json({}))
    expect((await run({ roomSwitch: 1 })).status).toBe('unverifiable')
  })

  it('c. 下发的字段 200 里根本没有：系统开关 / 运行模式 → 无法核对（未核对），即使房间读数齐全', async () => {
    backendWith(() => roomsBody(ON2))
    const sw = await run({ systemSwitch: 1 })
    expect(sw.status).toBe('unverifiable')
    expect(kinds(sw)).toEqual([['systemSwitch', 'unreadable']])
    backendWith(() => roomsBody(ON2))
    const mode = await run({ systemMode: Mode.OPERATION_MODE_AUTO })
    expect(mode.status).toBe('unverifiable')
    expect(kinds(mode)).toEqual([['systemMode', 'unreadable']])
  })
})

describe('回读请求本身失败 → 结果未知（不并进无法核对），提示刷新核对', () => {
  const expectUnknown = (end: UnifiedState<UnifiedSnapshot>) => {
    expect(end.status).toBe('unknown')
    if (end.status !== 'unknown') return
    expect(end.replied).toBe(true)
    expect(end.error).toBe(TEXT.sentUnknown)
    expect(end.after).toBeNull()
    expect(end.afterError).toContain(TEXT.readAfterFailedUnknown)
  }
  it('网络错误', async () => {
    backendWith(() => { throw new TypeError('Failed to fetch') })
    expectUnknown(await run({ roomSwitch: 1 }))
  })
  it('非 2xx：500 / 503', async () => {
    backendWith(() => text('oops', 500))
    expectUnknown(await run({ roomSwitch: 1 }))
    backendWith(() => text('unavailable', 503))
    expectUnknown(await run({ roomSwitch: 1, systemSwitch: 1 }))
  })
  it('超时', async () => {
    let n = 0
    const readBack = async (id: string, s: AbortSignal) => (n++ === 0 ? readUnifiedSnapshot(id, s) : Promise.reject(new ApiError('timeout', '请求超时')))
    backendWith(() => roomsBody(ON2))
    expectUnknown(await run({ roomSwitch: 1 }, readBack))
  })
})

describe('混合字段：能核对的照常判，整体按排序 B（结果未知 > 未变化 > 无法核对 > 已生效）', () => {
  it('房间开关读到了但不一致 + 系统开关读不到 → 未变化；房间开关的不一致照常列出', async () => {
    backendWith(() => roomsBody(OFF2))
    const end = await run({ systemSwitch: 1, roomSwitch: 1 })
    expect(end.status).toBe('unapplied')
    expect(kinds(end)).toEqual([['systemSwitch', 'unreadable'], ['roomSwitch', 'differ']])
    expect(end.status === 'unapplied' && end.mismatches[1].message).toBe('房间开关下发 开启，回读 关闭')
  })

  it('房间开关一致 + 运行模式读不到 → 无法核对（不能判已生效）', async () => {
    backendWith(() => roomsBody(ON2))
    const end = await run({ systemMode: Mode.OPERATION_MODE_SUMMER, roomSwitch: 1 })
    expect(end.status).toBe('unverifiable')
    expect(kinds(end)).toEqual([['systemMode', 'unreadable']])
  })

  it('温度不一致 + 有房间没回报开关（null）→ 未变化', async () => {
    backendWith(() => roomsBody([{ switch: 1, setTemp: 26, isConnected: true }, { switch: 65536, setTemp: 26, isConnected: true }]))
    const end = await run({ roomSwitch: 1, roomTemp: 26.5 })
    expect(end.status).toBe('unapplied')
    expect(kinds(end)).toEqual([['roomSwitch', 'missing'], ['roomTemp', 'differ']])
  })

  it('同一字段：一个房间读到关闭（不一致）、一个房间没回报（无效值）→ 未变化，不一致照常列出', async () => {
    backendWith(() => roomsBody([{ switch: 0, setTemp: 26, isConnected: true }, { switch: 65536, setTemp: 26, isConnected: true }]))
    const end = await run({ roomSwitch: 1 })
    expect(end.status).toBe('unapplied')
    expect(kinds(end)).toEqual([['roomSwitch', 'differ'], ['roomSwitch', 'missing']])
    expect(end.status === 'unapplied' && end.mismatches[0].message).toBe('房间开关下发 开启，回读 关闭（2 个房间中 1 个）')
  })

  it('只有能核对的字段、且读到的不一致 → 未变化', async () => {
    backendWith(() => roomsBody(OFF2))
    const end = await run({ roomSwitch: 1 })
    expect(end.status).toBe('unapplied')
  })

  it('有房间离线又有不一致 → 结果未知（比未变化更不确定）', async () => {
    backendWith(() => roomsBody([{ switch: 0, setTemp: 26, isConnected: true }, { switch: 1, setTemp: 26, isConnected: false }]))
    const end = await run({ roomSwitch: 1 })
    expect(end.status).toBe('unknown')
    expect(end.status === 'unknown' && end.afterError).toBe(TEXT.roomsOffline)
  })
})

describe('文案', () => {
  it('未变化 / 无法核对', () => {
    expect(TEXT.unapplied).toBe('指令已下发，设备状态暂未变化')
    expect(TEXT.unverifiable).toBe('该项暂无回读，无法确认')
  })
})

describe('写锁：无法核对照常持有，到期释放', () => {
  const P: BatchProject = { id: 'p1', code: '240829001', name: '测试项目', programCode: 1, online: true, controlScreenId: 'S1' }
  const okSend: BatchSender = async (_p, _q, o) => { if (!o.beforeSend()) throw new ApiError('write_blocked', 'x'); return { success: true, msg: '' } }
  const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

  for (const [name, draft, after, status] of [
    ['a. 没有房间条目', { roomSwitch: 1 }, () => roomsBody([]), 'unverifiable'],
    ['b. 回包为空 {}', { roomSwitch: 1 }, () => json({ body: '' }), 'unverifiable'],
    ['c. 系统开关', { systemSwitch: 1 }, () => roomsBody(ON2), 'unverifiable'],
    ['混合：系统开关 + 房间开关不一致（未变化）', { systemSwitch: 1, roomSwitch: 1 }, () => roomsBody(OFF2), 'unapplied'],
  ] as const) {
    it(name, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        // 核对器与 lock.ts 同口径：这些情况核对一律不一致
        L.configureWriteLock({ resolveProject: (id) => (id === 'p1' ? { id: 'p1', controlScreenId: 'S1' } : null) })
        L.registerVerifier(203, async (rec, s) => verifiable203(rec.target) && match203(rec.target, await readUnifiedSnapshot(rec.projectId, s)))
        backendWith(after)
        const b = createUnifiedBatch({ getProjects: () => [P], send: okSend, log: () => {}, now: () => new Date() })
        expect(b.prepare(['p1'], draft).phase).toBe('confirming')
        const done = await b.start()
        await flush()
        expect(done.rows[0].status).toBe(status)
        expect(L.lockOf('screen:S1')?.phase).toBe('unknown')
        vi.advanceTimersByTime(L.DEFAULT_TTL_MS + 10)
        expect(L.lockOf('screen:S1')).toBeNull()
      } finally { vi.useRealTimers() }
    })
  }
})
