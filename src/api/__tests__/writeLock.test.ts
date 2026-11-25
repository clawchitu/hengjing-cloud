// @vitest-environment jsdom
// 下发写锁（writeLock.ts，口径经 Fable 复核，11/24）。不发任何真实请求。覆盖：多键原子互斥；按 #24 writeOnce 的真实顺序接入
// （先等令牌、再 beforeSend 里 claim、再 fetch）；原写未结算不放锁；unknown 不被后续 settle 覆盖；
// 核对晚于原写结算、结算后自动核对；核对前确认可见与锁键一致（不可见不读）、503 按屏离线、读取途中换号作废、超时 / 预先中止；
// 发送前的账号绑定（同号重登换代、续期不换代）；别的账号看不到 label / projectId；有效期（内存锁与恢复锁都到期放开、强制重读事件、
// 最短 30 秒、不续期）；持久化（markSent 即落盘、ok / fail 删除、刷新恢复为未知、按消息号注册核对器、坏数据与时钟异常作废、
// 不存 label 与凭据）；跨标签 storage 事件；订阅与跨卸载。
import { act, cleanup, render } from '@testing-library/react'
import { createElement, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import { setConfig } from '../config'
import { __resetHttpForTests, refreshSession } from '../http'
import { __resetSessionForTests, signIn, signOut } from '../session'
import { clearTokens } from '../tokens'
import * as L from '../writeLock'
import { matchAllRoomsSwitch } from '../writeLockVerify'
import { fakeBackend, json } from './helpers'

const {
  __resetWriteLockForTests, acquire, claim, configureWriteLock, currentAccount, isHolder, lockKeysOf, lockOf, lockVersion, markOverdue,
  markSent, onForceReread, release, requireVerify, settle, subscribe, verify, registerVerifier, parseStored, STORAGE_PREFIX,
  DEFAULT_TTL_MS, MIN_TTL_MS, OTHER_ACCOUNT_TEXT, writeLockTtl, RETRY_DELAYS_MS, checkSentRecord, ROOM_IDS_MAX,
} = L
type LockToken = L.LockToken

/** 两个测试项目共用一块控制屏 */
const PA = { id: 'pa', controlScreenId: 'SCREEN-1', dtuId: 'DTU-1' }
const PB = { id: 'pb', controlScreenId: 'SCREEN-1' }
const PC = { id: 'pc', controlScreenId: 'SCREEN-2' }
const KEY = 'screen:SCREEN-1'
const REC: L.SentRecord = { msg: 201, deviceId: 406658286, target: { temperature: 24.5, eco: -1, switch: -1 } }

let acct = { user: 'u1' as string | null, gen: 1 }
let visible: Record<string, L.LockTarget> = {}
const gate = () => { let open = () => {}; let fail = (_e?: unknown) => {}; const p = new Promise<void>((r, j) => { open = r; fail = (e) => j(e ?? new Error('x')) }); return { p, open, fail } }
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
const take = (t: L.LockTarget = PA, label = '客厅'): LockToken => { const r = acquire(t, label); if (!r.ok) throw new Error('busy'); return r.token }
const stored = () => Object.keys(localStorage).filter((k) => k.startsWith(STORAGE_PREFIX))
const rec = (o: Partial<L.StoredLock> = {}): L.StoredLock => ({ v: 1, op: 'o1', keys: [KEY, 'dtu:DTU-1', 'project:pa'], projectId: 'pa', userId: 'u1', sentAt: Date.now() - 1000, ...REC, ...o })
const put = (r: object, key = KEY) => localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(r))

/** 按 #24 writeOnce 的顺序：先等令牌（异步），再同步 beforeSend，通过才 fetch */
function writeOnce(beforeSend: () => boolean, net: () => Promise<void>, opts: { failBeforeSend?: boolean } = {}) {
  return (async () => {
    await Promise.resolve(); await Promise.resolve() // freshAccessToken()
    if (opts.failBeforeSend) throw new ApiError('unauthenticated', '登录已过期')
    let ok = false
    try { ok = beforeSend() === true } catch { ok = false }
    if (!ok) throw new ApiError('write_blocked', '发送前复核未通过，未下发')
    return net()
  })()
}
/** 调用方的标准写法：acquire → requestWrite(beforeSend: claim) → markSent → settle */
async function drive(t: LockToken, p: Promise<void>, record: L.SentRecord = REC, check?: (s: AbortSignal) => Promise<L.MatchResult>) {
  markSent(t, p, record)
  if (check) requireVerify(t, check)
  try { await p; settle(t, 'ok'); return 'ok' } catch (e) {
    const unknown = e instanceof ApiError && (e.kind === 'timeout' || e.kind === 'network' || e.kind === 'server')
    settle(t, unknown ? 'unknown' : 'fail')
    return unknown ? 'unknown' : 'fail'
  }
}
/** 走到 unknown：已认领、发出（Promise 由 g 控制）、定为结果未知 */
function toUnknown(fn?: L.VerifyFn, g = gate()) {
  const t = take()
  claim(t)
  markSent(t, g.p, REC)
  settle(t, 'unknown')
  if (fn) requireVerify(t, fn)
  return { t, g }
}
async function unknownSettled(fn?: L.VerifyFn) {
  const { t, g } = toUnknown(undefined)
  g.fail(); await flush()
  if (fn) requireVerify(t, fn)
  return t
}

beforeEach(() => {
  localStorage.clear()
  acct = { user: 'u1', gen: 1 }
  visible = { pa: PA, pb: PB, pc: PC }
  __resetWriteLockForTests(() => acct)
  configureWriteLock({ resolveProject: (id) => visible[id] ?? null })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('锁键：多键原子互斥', () => {
  it('全部可用键：控制屏 → DTU → 项目 id（空白不算）', () => {
    expect(lockKeysOf({ id: 'p', controlScreenId: 'S1', dtuId: 'D1' })).toEqual(['screen:S1', 'dtu:D1', 'project:p'])
    expect(lockKeysOf({ id: 'p', controlScreenId: '  ', dtuId: 'D1' })).toEqual(['dtu:D1', 'project:p'])
    expect(lockKeysOf({ id: 'p' })).toEqual(['project:p'])
  })
  it('同屏两个项目：第二个 busy；不同屏互不影响', () => {
    take(PA)
    const b = acquire(PB, '全部开启')
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.busy).toMatchObject({ key: KEY, projectId: 'pa', label: '客厅', phase: 'held', mine: true })
    expect(acquire(PC).ok).toBe(true)
  })
  it('同屏另一份数据只有 DTU、同一项目刷新后缺了屏号：仍然 busy；lockOf 任一键命中；释放时一起放', () => {
    const t = take(PA)
    expect(acquire({ id: 'px', dtuId: 'DTU-1' }).ok).toBe(false)
    expect(acquire({ id: 'pa' }).ok).toBe(false)
    expect(lockOf('dtu:DTU-1')?.projectId).toBe('pa')
    expect(lockOf({ id: 'pa' })?.key).toBe(KEY)
    release(t)
    for (const k of lockKeysOf(PA)) expect(lockOf(k)).toBeNull()
  })
  it('主键空闲但次要键被占（先锁的那份数据只有 DTU）：也 busy', () => {
    take({ id: 'px', dtuId: 'DTU-1' })
    expect(acquire(PA).ok).toBe(false)
    expect(lockOf('screen:SCREEN-1')).toBeNull() // 没有半途占住任何键
  })
})

describe('接入时序（按 #24 writeOnce：先等令牌、再 beforeSend、再 fetch）', () => {
  it('能发出：beforeSend 里 claim 通过、fetch 一次；success 只算已下发，核对一致后才释放、删记录', async () => {
    const t = take()
    const net = vi.fn(async () => { expect(stored()).toEqual([STORAGE_PREFIX + KEY]) }) // 发出时记录已在
    let same = false
    expect(await drive(t, writeOnce(() => claim(t), net), REC, async () => same)).toBe('ok')
    expect(net).toHaveBeenCalledTimes(1)
    await flush()
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', outcome: 'ok', lastVerify: 'mismatch' }) // 已下发、设备未变化
    expect(stored()).toHaveLength(1)
    same = true
    expect(await verify(KEY)).toBe('released')
    expect(lockOf(PA)).toBeNull()
    expect(stored()).toEqual([])
  })
  it('确定失败（success=false）：释放、记录删除', async () => {
    const t = take()
    expect(await drive(t, writeOnce(() => claim(t), async () => { throw new ApiError('ctrl', '控制屏拒绝') }))).toBe('fail')
    expect(lockOf(PA)).toBeNull()
    expect(stored()).toEqual([])
  })
  it('超时：进入 unknown，不释放，记录保留', async () => {
    const t = take()
    expect(await drive(t, writeOnce(() => claim(t), async () => { throw new ApiError('timeout', '未收到控制屏应答') }))).toBe('unknown')
    await flush()
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', sendSettled: true })
    expect(acquire(PB).ok).toBe(false)
    expect(stored()).toHaveLength(1)
  })
  it('同步 mock sender（beforeSend 在拿到 Promise 之前执行）：先 claim 后 markSent 也能正确登记', async () => {
    const t = take()
    const syncSender = (beforeSend: () => boolean) => (beforeSend() ? Promise.resolve() : Promise.reject(new ApiError('write_blocked', 'x')))
    const g = gate()
    const p = syncSender(() => claim(t)).then(() => g.p)
    markSent(t, p, REC)
    requireVerify(t, async () => true)
    expect(lockOf(PA)?.phase).toBe('sent')
    settle(t, 'ok')
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', outcome: 'ok', sendSettled: false }) // 原写还没结算
    expect(await verify(KEY)).toBe('send-pending')
    g.open(); await flush()
    expect(lockOf(PA)).toBeNull() // 结算后自动核对，一致才放
  })
  it('beforeSend 没调用（发送前失败）/ 返回 false / 抛错：都不留锁、不留记录（不 settle 也会在 Promise 结算时释放）', async () => {
    const run = (before: (t: LockToken) => () => boolean, o: { failBeforeSend?: boolean } = {}) => {
      const t = take()
      const p = writeOnce(before(t), async () => {}, o)
      markSent(t, p, REC)
      return p.catch(() => {})
    }
    await run((t) => () => claim(t), { failBeforeSend: true })
    await run(() => () => false)
    await run(() => () => { throw new Error('页面卸载') })
    await flush()
    expect(lockOf(PA)).toBeNull()
    expect(stored()).toEqual([])
    // 有 settle 的写法：未认领 → 必未发出，直接释放（即使结论写成 unknown）
    const t = take()
    await drive(t, writeOnce(() => false, async () => {}))
    expect(lockOf(PA)).toBeNull()
    const t2 = take()
    settle(t2, 'unknown')
    expect(lockOf(PA)).toBeNull()
  })
  it('发送前绑定账号：换账号 / 换代后 claim 失败；claim 只能一次；旧 token 无效', () => {
    const t = take()
    acct = { user: 'u1', gen: 2 }
    expect(isHolder(t)).toBe(false)
    expect(claim(t)).toBe(false)
    acct = { user: 'u1', gen: 1 }
    expect(claim(t)).toBe(true)
    expect(claim(t)).toBe(false)
    const t2 = take(PC)
    release(t2)
    take(PC)
    expect(claim(t2)).toBe(false)
  })
})

describe('原写未结算不放锁；unknown 不被覆盖', () => {
  it('settle fail 早于原写结算：保持，结算后释放；期间 release 被拒', async () => {
    const g = gate()
    const t = take()
    claim(t)
    markSent(t, g.p, REC)
    settle(t, 'fail')
    await flush()
    expect(lockOf(PA)).toMatchObject({ phase: 'sent', sendSettled: false, outcome: 'fail' })
    expect(release(t)).toBe(false)
    g.fail()
    await flush()
    expect(lockOf(PA)).toBeNull()
  })
  it('settle ok（success 只算已下发）：进入待核对；原写结算后也不放，核对不一致保持、release 被拒，核对一致才放', async () => {
    const g = gate()
    const t = take()
    claim(t)
    markSent(t, g.p, REC)
    let same: L.MatchResult = false
    requireVerify(t, async () => same)
    settle(t, 'ok')
    g.open(); await flush()
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', outcome: 'ok', sendSettled: true, lastVerify: 'mismatch' })
    expect(release(t)).toBe(false)
    settle(t, 'fail') // 只认第一次 settle
    expect(lockOf(PA)?.phase).toBe('unknown')
    same = true
    expect(await verify(KEY)).toBe('released')
  })
  it('unknown 后再手动 settle ok / fail：不变，仍锁', () => {
    const { t } = toUnknown(async () => false)
    settle(t, 'ok'); settle(t, 'fail')
    expect(lockOf(PA)?.phase).toBe('unknown')
    expect(release(t)).toBe(false)
  })
  it('原写 Promise 迟到 resolve（success=true）不再放锁：只标记已结算、自动核对一次；不一致仍锁', async () => {
    const fn = vi.fn(async () => false)
    const { g } = toUnknown(fn)
    g.open(); await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', sendSettled: true, lastVerify: 'mismatch' })
    expect(stored()).toHaveLength(1)
  })
  it('无法核对（读数里没有目标字段）：与不一致分开记录；锁保持到有效期到期、不提前放、不续期，到期强制重读', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const events: unknown[] = []
    onForceReread((e) => events.push(e))
    const t = take()
    claim(t)
    markSent(t, Promise.resolve(), REC)
    requireVerify(t, async () => 'unverifiable')
    settle(t, 'ok')
    await vi.advanceTimersByTimeAsync(0)
    const exp0 = lockOf(PA)?.expiresAt
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', lastVerify: 'unverifiable' })
    await vi.advanceTimersByTimeAsync(DEFAULT_TTL_MS - 1000)
    expect(await verify(KEY)).toBe('unverifiable')
    expect(lockOf(PA)?.expiresAt).toBe(exp0)
    expect(release(t)).toBe(false)
    await vi.advanceTimersByTimeAsync(1001)
    expect(lockOf(PA)).toBeNull()
    expect(events).toHaveLength(1)
  })
  it('核对结果记在锁上：未变化 / 结果未知（读失败）/ 屏离线 / 无法核对', async () => {
    let r: () => Promise<L.MatchResult> = async () => false
    const t = await unknownSettled(() => r())
    void t
    expect(await verify(KEY)).toBe('mismatch')
    expect(lockOf(PA)?.lastVerify).toBe('mismatch')
    r = async () => { throw new Error('x') }
    expect(await verify(KEY)).toBe('failed')
    expect(lockOf(PA)?.lastVerify).toBe('failed')
    r = async () => { throw new ApiError('unavailable', 'x') }
    expect(await verify(KEY)).toBe('offline')
    r = async () => 'unverifiable'
    expect(await verify(KEY)).toBe('unverifiable')
    expect(lockOf(PA)?.lastVerify).toBe('unverifiable')
  })
  it('真实顺序：先 markSent，调用方 await 后在 catch 里 settle(unknown)（原写已先结算）→ 自动核对一次', async () => {
    const fn = vi.fn(async () => true)
    const t = take()
    const p = writeOnce(() => claim(t), async () => { throw new ApiError('timeout', '未收到控制屏应答') })
    markSent(t, p, REC)
    requireVerify(t, fn)
    try { await p } catch { settle(t, 'unknown') }
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(lockOf(PA)).toBeNull()
  })
  it('截止只改标记，不放锁', () => {
    const t = take()
    claim(t)
    markSent(t, new Promise(() => {}), REC)
    markOverdue(t)
    settle(t, 'unknown')
    expect(lockOf(PA)).toMatchObject({ overdue: true, phase: 'unknown' })
  })
})

describe('核对', () => {
  it('原写未结算：verify 直接 send-pending，不读；结算后的自动核对才读，一致才放（先读后结算的旧读不存在）', async () => {
    const order: string[] = []
    const fn = vi.fn(async () => { order.push('read'); return true })
    const { g } = toUnknown(fn)
    expect(await verify(KEY)).toBe('send-pending')
    expect(fn).not.toHaveBeenCalled()
    order.push('settled')
    g.fail(); await flush()
    expect(order).toEqual(['settled', 'read'])
    expect(lockOf(PA)).toBeNull()
  })
  it('不一致 / 读取失败 / 503（屏离线）：保持，可以再核对', async () => {
    let mode: 'mismatch' | 'throw' | 'offline' | 'ok' = 'mismatch'
    await unknownSettled(async () => {
      if (mode === 'throw') throw new Error('x')
      if (mode === 'offline') throw new ApiError('unavailable', '控制屏未连接', { status: 503, code: 14 })
      return mode === 'ok'
    })
    expect(await verify(KEY)).toBe('mismatch')
    mode = 'throw'
    expect(await verify(KEY)).toBe('failed')
    mode = 'offline'
    expect(await verify(KEY)).toBe('offline')
    expect(lockOf(PA)?.phase).toBe('unknown')
    mode = 'ok'
    expect(await verify(KEY)).toBe('released')
  })
  it('不可见（项目不在当前账号范围）或锁键对不上（项目数据的屏号变了）：不发读请求，锁保持', async () => {
    const fn = vi.fn(async () => true)
    await unknownSettled(fn)
    visible = { pb: PB }
    expect(await verify(KEY)).toBe('not-visible')
    visible = { pa: { id: 'pa', controlScreenId: 'SCREEN-9' } }
    expect(await verify(KEY)).toBe('not-visible')
    configureWriteLock({ resolveProject: null }) // 没注入查询：一律不读
    expect(await verify(KEY)).toBe('not-visible')
    expect(fn).not.toHaveBeenCalled()
    expect(lockOf(PA)?.phase).toBe('unknown')
  })
  it('预先中止的 signal：直接返回，不读', async () => {
    const fn = vi.fn(async () => true)
    await unknownSettled(fn)
    const ac = new AbortController(); ac.abort()
    expect(await verify(KEY, ac.signal)).toBe('aborted')
    expect(fn).not.toHaveBeenCalled()
  })
  it('核对卡住：超时后 verifying 复位、锁保留，可以再核对', async () => {
    let calls = 0
    const t = await unknownSettled()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    requireVerify(t, () => { calls += 1; return calls === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(true) })
    const v = verify(KEY)
    expect(lockOf(PA)?.verifying).toBe(true)
    await vi.advanceTimersByTimeAsync(L.VERIFY_TIMEOUT_MS + 1)
    expect(await v).toBe('failed')
    expect(lockOf(PA)).toMatchObject({ verifying: false, phase: 'unknown' })
    vi.useRealTimers()
    expect(await verify(KEY)).toBe('released')
  })
})

describe('候选结果提交（#33）与无效核对', () => {
  it('超时：核对函数一收到中止就同步返回候选结果（先于超时错误胜出）→ 作废，不提交、不放锁', async () => {
    const t = await unknownSettled()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const commit = vi.fn()
    requireVerify(t, (sig) => new Promise((resolve) => { sig.addEventListener('abort', () => resolve({ same: true, commit })) }))
    const v = verify(KEY)
    await vi.advanceTimersByTimeAsync(L.VERIFY_TIMEOUT_MS + 1)
    expect(await v).toBe('failed')
    expect(commit).not.toHaveBeenCalled()
    expect(lockOf(PA)).toMatchObject({ verifying: false, phase: 'unknown' })
    vi.useRealTimers()
  })
  it('有效核对先提交再按结论放锁；不一致也提交（只提交一致的那部分由调用方决定）；读取途中换号不提交', async () => {
    const commit = vi.fn()
    let same = false
    const t = await unknownSettled(async () => ({ same, commit }))
    expect(await verify(KEY)).toBe('mismatch')
    expect(commit).toHaveBeenCalledTimes(1)
    requireVerify(t, async () => { acct = { user: 'u2', gen: 9 }; return { same: true, commit } })
    expect(await verify(KEY)).toBe('account-changed')
    expect(commit).toHaveBeenCalledTimes(1)
    acct = { user: 'u1', gen: 1 }
    same = true
    requireVerify(t, async () => ({ same, commit }))
    expect(await verify(KEY)).toBe('released')
    expect(commit).toHaveBeenCalledTimes(2)
  })
  it('commit 返回 false（Fable 裁定：提交这一刻否决）：一致也不放锁，结论记 mismatch、逐字段结果未知，标 lastVetoed；下一次核对开始时清掉', async () => {
    let veto = true
    const commit = vi.fn(() => (veto ? false : undefined))
    await unknownSettled(async () => ({ same: true, commit }))
    expect(await verify(KEY)).toBe('mismatch')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(lockOf(PA)).toMatchObject({ phase: 'unknown', lastVerify: 'mismatch', lastVetoed: true })
    expect(lockOf(PA)?.lastFields).toEqual({ temperature: 'unknown' })
    veto = false
    const v = verify(KEY)
    expect(lockOf(PA)?.lastVetoed).toBe(false) // 核对开始即清
    expect(await v).toBe('released')
    expect(lockOf(PA)).toBeNull()
  })
  it('读取途中换号：核对器返回的逐字段结果作废，改了的字段全部记为结果未知；别的账号看不到 lastFields', async () => {
    const t = await unknownSettled(async () => { acct = { user: 'u2', gen: 9 }; return { verdict: 'applied', fields: { temperature: 'applied' } } })
    void t
    expect(await verify(KEY)).toBe('account-changed')
    acct = { user: 'u1', gen: 1 }
    expect(lockOf(PA)?.lastFields).toEqual({ temperature: 'unknown' })
    acct = { user: 'u2', gen: 9 }
    expect(lockOf(PA)).toMatchObject({ owner: 'other-account', label: '', projectId: '' })
    expect(lockOf(PA)?.lastFields).toBeUndefined()
  })
  it('回读失败时只把「改了的字段」记为结果未知：203 的 systemMode 0 = 不改', async () => {
    const t = take(); claim(t)
    markSent(t, Promise.resolve(), { msg: 203, deviceId: null, target: { systemSwitch: -1, systemMode: -1, roomSwitch: 1, roomTemp: -1 } })
    requireVerify(t, async () => { throw new Error('网络错误') })
    settle(t, 'unknown')
    await flush()
    expect(lockOf(PA)?.lastFields).toEqual({ roomSwitch: 'unknown' })
  })
})

describe('核对不绑定账号；发起者信息防泄露', () => {
  it('owner：本次会话 / 同一用户的上一会话 / 别的账号；别的账号看不到 label 与 projectId', async () => {
    await unknownSettled(async () => false)
    expect(lockOf(PA)).toMatchObject({ owner: 'current', label: '客厅', projectId: 'pa' })
    acct = { user: 'u1', gen: 2 }
    expect(lockOf(PA)).toMatchObject({ owner: 'previous-session', mine: false, label: '客厅' })
    acct = { user: 'u2', gen: 3 }
    expect(lockOf(PA)).toMatchObject({ owner: 'other-account', label: '', projectId: '' })
    expect(OTHER_ACCOUNT_TEXT).toBe('上一账号的下发结果未知，请稍后再试或联系有权限的账号')
  })
  it('同号重登、别的账号：只要能读就核对，一致即放', async () => {
    for (const who of [{ user: 'u1', gen: 2 }, { user: 'u2', gen: 3 }]) {
      const fn = vi.fn(async () => true)
      await unknownSettled(fn)
      acct = who
      expect(await verify(KEY)).toBe('released')
      expect(fn).toHaveBeenCalledTimes(1)
      acct = { user: 'u1', gen: 1 }
    }
  })
  it('别的账号读不到（不可见 / 无权限）：保持锁', async () => {
    await unknownSettled(async () => { throw new ApiError('forbidden', '无权限') })
    acct = { user: 'u2', gen: 2 }
    expect(await verify(KEY)).toBe('failed')
    visible = {}
    expect(await verify(KEY)).toBe('not-visible')
    expect(lockOf(PA)?.phase).toBe('unknown')
  })
  it('读取途中换代 / 换号：结果作废，保持锁', async () => {
    await unknownSettled(async () => { acct = { user: 'u1', gen: 9 }; return true })
    expect(await verify(KEY)).toBe('account-changed')
    expect(lockOf(PA)?.phase).toBe('unknown')
  })

  it('默认账号来源是 api/session：不先退出的同号重登换代；令牌续期不换代；退出换代', async () => {
    __resetWriteLockForTests()
    setConfig({ apiBase: '/api', dataSource: 'real' })
    __resetHttpForTests(); __resetSessionForTests(); clearTokens()
    __resetWriteLockForTests()
    let n = 0
    fakeBackend({
      '/auth/login': () => { n += 1; return json({ access_token: `A${n}`, refresh_token: `R${n}`, expires_in: 7200 }) },
      '/auth/refresh': () => { n += 1; return json({ access_token: `A${n}`, refresh_token: `R${n}`, expires_in: 7200 }) },
      '/me': () => json({ user_entity: { id: 'u1', name: '甲' } }),
      '/auth/invalidate': () => json({}),
    })
    await signIn('a', 'pw', true)
    const g1 = currentAccount()
    expect(g1.user).toBe('u1')
    await refreshSession()
    expect(currentAccount()).toEqual(g1) // 续期不换代
    const t = take()
    await signIn('a', 'pw', true) // 不先退出，直接同号重登
    const g2 = currentAccount()
    expect(g2.user).toBe('u1')
    expect(g2.gen).not.toBe(g1.gen)
    expect(isHolder(t)).toBe(false)
    expect(lockOf(PA)?.owner).toBe('previous-session')
    const notes: number[] = []
    const off = subscribe(() => notes.push(lockVersion()))
    await signOut()
    expect(currentAccount().gen).not.toBe(g2.gen)
    expect(notes.length).toBeGreaterThan(0)
    off()
    setConfig(null)
  })
})

describe('逐字段结果（lastFields）', () => {
  it('核对函数返回逐字段结论：只有全部一致才放锁；混合时锁保持，lastVerify 为整体、lastFields 逐字段', async () => {
    let r: L.MatchResult = { verdict: 'unchanged', fields: { temperature: 'unchanged', humidity: 'unverifiable' } }
    await unknownSettled(async () => r)
    expect(await verify(KEY)).toBe('mismatch')
    expect(lockOf(PA)).toMatchObject({ lastVerify: 'mismatch', lastFields: { temperature: 'unchanged', humidity: 'unverifiable' } })
    r = { verdict: 'unverifiable', fields: { temperature: 'applied', humidity: 'unverifiable' } }
    expect(await verify(KEY)).toBe('unverifiable')
    expect(lockOf(PA)?.lastFields).toEqual({ temperature: 'applied', humidity: 'unverifiable' })
    r = { verdict: 'unknown', fields: { temperature: 'unknown' } }
    expect(await verify(KEY)).toBe('failed') // 结果未知（面板离线）
    expect(lockOf(PA)?.lastFields).toEqual({ temperature: 'unknown' })
    r = { verdict: 'applied', fields: { temperature: 'applied' } }
    expect(await verify(KEY)).toBe('released')
  })
  it('回读失败：每个目标字段都记为结果未知', async () => {
    await unknownSettled(async () => { throw new Error('网络错误') })
    expect(await verify(KEY)).toBe('failed')
    expect(lockOf(PA)?.lastFields).toEqual({ temperature: 'unknown' }) // REC 只改了温度
  })
})

describe('自动重新核对（退避）', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  /** 已认领、登记、定为已下发，原写立即结算；返回核对次数计数 */
  async function sentOk(fn: () => Promise<L.MatchResult>) {
    const t = take()
    claim(t)
    markSent(t, Promise.resolve(), REC)
    requireVerify(t, fn)
    settle(t, 'ok')
    await vi.advanceTimersByTimeAsync(0)
    return t
  }
  it('未变化：结算后核对一次，再按 5 秒、20 秒、60 秒退避核对，共 4 次；之后不再自动核对，到期放锁', async () => {
    fake()
    expect(RETRY_DELAYS_MS).toEqual([5_000, 20_000, 60_000])
    const fn = vi.fn(async () => false as L.MatchResult)
    await sentOk(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fn).toHaveBeenCalledTimes(4)
    expect(lockOf(PA)?.lastVerify).toBe('mismatch')
    await vi.advanceTimersByTimeAsync(DEFAULT_TTL_MS)
    expect(fn).toHaveBeenCalledTimes(4)
    expect(lockOf(PA)).toBeNull()
  })
  it('无法核对也退避；某次核对一致即放锁、不再排后续', async () => {
    fake()
    let n = 0
    const fn = vi.fn(async (): Promise<L.MatchResult> => (++n >= 3 ? true : 'unverifiable'))
    await sentOk(fn)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(lockOf(PA)?.lastVerify).toBe('unverifiable')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(lockOf(PA)).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fn).toHaveBeenCalledTimes(3)
  })
  it('只退避 3 次：有效期再长也不再自动核对', async () => {
    fake()
    configureWriteLock({ ttlMs: 10 * 60_000 })
    const fn = vi.fn(async () => false as L.MatchResult)
    await sentOk(fn)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(fn).toHaveBeenCalledTimes(4)
  })
  it('不超过有效期：有效期 30 秒时只排得下 5 秒、20 秒两次（第三次不排，只剩到期定时器）', async () => {
    fake()
    configureWriteLock({ ttlMs: 30_000 })
    const fn = vi.fn(async () => false as L.MatchResult)
    await sentOk(fn)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lockOf(PA)).toBeNull()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(fn).toHaveBeenCalledTimes(3)
  })
  it('读取失败 / 屏离线也按同样节奏退避（共 4 次）', async () => {
    fake()
    let n = 0
    const fn = vi.fn(async (): Promise<L.MatchResult> => { n += 1; if (n % 2) throw new Error('x'); throw new ApiError('unavailable', 'x') })
    await sentOk(fn)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(fn).toHaveBeenCalledTimes(4)
    expect(lockOf(PA)?.lastVerify).toBe('offline')
  })
  it('首次「不可见」（组织数据还没就绪）→ 退避后可见且一致 → 放锁', async () => {
    fake()
    const fn = vi.fn(async () => true as L.MatchResult)
    visible = {}
    await sentOk(fn)
    expect(fn).not.toHaveBeenCalled()
    visible = { pa: PA }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(lockOf(PA)).toBeNull()
  })
  it('退避到点时手动核对还在进行：等它的结果，仍不一致就继续剩余退避', async () => {
    fake()
    let release: (v: L.MatchResult) => void = () => {}
    let calls = 0
    const fn = vi.fn((): Promise<L.MatchResult> => { calls += 1; return calls === 2 ? new Promise((r) => { release = r }) : Promise.resolve(false) })
    await sentOk(fn) // 第 1 次：不一致，排 5 秒
    await vi.advanceTimersByTimeAsync(4_000)
    const manual = verify(KEY) // 第 2 次：手动核对，挂着
    await vi.advanceTimersByTimeAsync(1_000) // 5 秒到点：遇到进行中，不另发
    expect(fn).toHaveBeenCalledTimes(2)
    release(false)
    expect(await manual).toBe('mismatch')
    await vi.advanceTimersByTimeAsync(20_000) // 继续剩余退避：20 秒后再核对
    expect(fn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fn).toHaveBeenCalledTimes(4)
  })
  it('时钟已跨过到期、到期定时器还没执行：退避回调到点直接 expire（放锁一次、强制重读一次），不再核对', async () => {
    fake()
    const events: unknown[] = []
    onForceReread((e) => events.push(e))
    const fn = vi.fn(async () => false as L.MatchResult)
    await sentOk(fn)
    vi.setSystemTime(Date.now() + DEFAULT_TTL_MS) // 系统时间跳过到期，定时器都还没跑
    await vi.advanceTimersByTimeAsync(5_000) // 退避回调先到点
    expect(fn).toHaveBeenCalledTimes(1)
    expect(lockOf(PA)).toBeNull()
    expect(events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_TTL_MS) // 原来的到期定时器再到点：不重复
    expect(events).toHaveLength(1)
  })
  it('已过有效期：手动核对不发起（expired）；读取途中过了有效期：不接受结果，只 expire 一次', async () => {
    fake()
    const events: unknown[] = []
    onForceReread((e) => events.push(e))
    const fn = vi.fn(async () => false as L.MatchResult)
    await sentOk(fn)
    vi.setSystemTime(Date.now() + DEFAULT_TTL_MS)
    expect(await verify(KEY)).toBe('expired')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
    // 读取途中过期
    __resetWriteLockForTests(() => acct)
    configureWriteLock({ resolveProject: (id) => visible[id] ?? null })
    onForceReread((e) => events.push(e))
    let done: (v: L.MatchResult) => void = () => {}
    const t = take(); claim(t); markSent(t, Promise.resolve(), REC)
    requireVerify(t, () => new Promise<L.MatchResult>((r) => { done = r }))
    settle(t, 'ok')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + DEFAULT_TTL_MS)
    done(true) // 一致，但已过期：不按一致放锁，按到期处理
    await vi.advanceTimersByTimeAsync(0)
    expect(lockOf(PA)).toBeNull()
    expect(events).toHaveLength(2)
  })
  it('退避等待中的手动核对被中止 / 读取途中换号：不断链，下一次照常重试（重新检查账号与可见性）；最终到期放锁', async () => {
    fake()
    let release: (v: L.MatchResult) => void = () => {}
    let calls = 0
    const fn = vi.fn((): Promise<L.MatchResult> => {
      calls += 1
      if (calls === 2) return new Promise((r) => { release = r }) // 手动核对：挂着，随后被中止
      if (calls === 3) { acct = { user: 'u1', gen: 7 }; return Promise.resolve(true) } // 读取途中换代：作废
      return Promise.resolve(false)
    })
    await sentOk(fn) // 第 1 次：不一致，排 5 秒
    await vi.advanceTimersByTimeAsync(4_000)
    const ac = new AbortController()
    const manual = verify(KEY, ac.signal)
    await vi.advanceTimersByTimeAsync(1_000) // 5 秒到点：等手动核对
    ac.abort(); release(true)
    expect(await manual).toBe('aborted')
    await vi.advanceTimersByTimeAsync(20_000) // 不断链：20 秒后第 3 次（换代 → 作废）
    expect(fn).toHaveBeenCalledTimes(3)
    expect(lockOf(PA)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(60_000) // 第 4 次：仍不一致
    expect(fn).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(DEFAULT_TTL_MS) // 最终到期
    expect(lockOf(PA)).toBeNull()
  })
  it('放锁（手动核对一致）后排着的退避不再执行', async () => {
    fake()
    let same = false
    const fn = vi.fn(async () => same as L.MatchResult)
    await sentOk(fn)
    same = true
    expect(await verify(KEY)).toBe('released')
    expect(vi.getTimerCount()).toBe(0) // 退避与到期定时器都已清掉
    await vi.advanceTimersByTimeAsync(100_000)
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('刷新恢复的锁：注册核对器后同样退避', async () => {
    fake()
    put(rec())
    vi.resetModules()
    const R = await import('../writeLock')
    R.configureWriteLock({ resolveProject: (id) => visible[id] ?? null })
    const fn = vi.fn(async () => false)
    R.registerVerifier(201, fn)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('有效期', () => {
  it('默认 2 分钟、可配置、最短 30 秒', () => {
    expect(writeLockTtl()).toBe(DEFAULT_TTL_MS)
    configureWriteLock({ ttlMs: 5_000 })
    expect(writeLockTtl()).toBe(MIN_TTL_MS)
    configureWriteLock({ ttlMs: 90_000 })
    expect(writeLockTtl()).toBe(90_000)
  })
  it('内存锁（原写永不结算）从发出起算，到期放锁、删记录、通知订阅者并发强制重读事件；核对失败不续期', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const events: { keys: readonly string[]; projectId: string }[] = []
    onForceReread((e) => events.push(e))
    let notes = 0
    subscribe(() => { notes += 1 })
    const t = take()
    claim(t)
    markSent(t, new Promise(() => {}), REC)
    settle(t, 'unknown')
    requireVerify(t, async () => false)
    await vi.advanceTimersByTimeAsync(DEFAULT_TTL_MS - 1000)
    expect(await verify(KEY)).toBe('send-pending')
    expect(lockOf(PA)).not.toBeNull()
    const before = notes
    await vi.advanceTimersByTimeAsync(1001)
    expect(lockOf(PA)).toBeNull()
    expect(stored()).toEqual([])
    expect(notes).toBeGreaterThan(before)
    expect(events).toEqual([{ keys: lockKeysOf(PA), projectId: 'pa' }])
  })
})

describe('读取凭据：beginRead / commitRead（页面回读与 verify 同一条提交路径）', () => {
  it('还没发出（held）不给凭据；已发出给凭据，账号、token、有效期都对得上才提交', () => {
    const t = take()
    expect(L.beginRead(t)).toBeNull()
    claim(t)
    markSent(t, gate().p, REC)
    const ticket = L.beginRead(t)
    const commit = vi.fn()
    expect(L.commitRead(ticket, commit)).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
  })
  it('读取途中换号 / 换代：丢弃，不提交', () => {
    const t = take(); claim(t); markSent(t, gate().p, REC)
    const ticket = L.beginRead(t)
    acct = { user: 'u2', gen: 2 }
    const commit = vi.fn()
    expect(L.commitRead(ticket, commit)).toBe(false)
    expect(commit).not.toHaveBeenCalled()
  })
  it('读取途中锁到期（时钟已过有效期、计时器还没跑）、锁放开后被新的下发占用、读取被中止：都丢弃', () => {
    vi.useFakeTimers()
    const t = take(); claim(t); markSent(t, gate().p, REC)
    const commit = vi.fn()
    const ticket = L.beginRead(t)
    vi.setSystemTime(Date.now() + DEFAULT_TTL_MS + 1)
    expect(lockOf(PA)).not.toBeNull()
    expect(L.commitRead(ticket, commit)).toBe(false)
    vi.advanceTimersByTime(DEFAULT_TTL_MS + 1)
    expect(lockOf(PA)).toBeNull()
    const t2 = take(); claim(t2); markSent(t2, gate().p, REC)
    expect(L.commitRead(ticket, commit)).toBe(false)
    const ac = new AbortController(); ac.abort()
    expect(L.commitRead(L.beginRead(t2), commit, ac.signal)).toBe(false)
    expect(L.commitRead(null, commit)).toBe(false)
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('持久化（localStorage）', () => {
  it('markSent 就落盘（还没认领也写）；记录只含锁键、projectId、消息号、设备 id、目标、userId、sentAt，不含 label 与凭据', () => {
    const t = take(PA, '客厅 设定温度')
    markSent(t, new Promise(() => {}), REC)
    const raw = localStorage.getItem(STORAGE_PREFIX + KEY)!
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['deviceId', 'keys', 'msg', 'op', 'projectId', 'sentAt', 'target', 'userId', 'v'])
    expect(raw).not.toContain('客厅')
    expect(raw).not.toMatch(/token|Bearer|password/i)
    expect(parseStored(raw)).toMatchObject({ keys: lockKeysOf(PA), projectId: 'pa', msg: 201, deviceId: 406658286, userId: 'u1' })
  })
  it('206 的目标房间集合随记录落盘，刷新后可用；坏的 roomIds 作废', async () => {
    const t = take()
    markSent(t, new Promise(() => {}), { msg: 206, deviceId: null, target: { switch: 1 }, roomIds: [1, 2] })
    expect(parseStored(localStorage.getItem(STORAGE_PREFIX + KEY))).toMatchObject({ msg: 206, roomIds: [1, 2] })
    expect(parseStored(JSON.stringify({ ...rec({ msg: 206, deviceId: null, target: { switch: 1 } }), roomIds: ['x'] }))).toBeNull()
    expect(parseStored(JSON.stringify({ ...rec({ msg: 206, deviceId: null, target: { switch: 1 } }), roomIds: [] }))).toBeNull()
  })
  it('206 目标房间集合最多 512 个：满额照常落盘与恢复，超过的在发送前由 checkSentRecord 拒绝', () => {
    expect(ROOM_IDS_MAX).toBe(512)
    const ids = (n: number) => Array.from({ length: n }, (_, i) => 9_007_199_254_740_991 - i)
    const full: L.SentRecord = { msg: 206, deviceId: null, target: { switch: 1 }, roomIds: ids(ROOM_IDS_MAX) }
    expect(checkSentRecord(full)).toBeNull()
    const t = take()
    markSent(t, new Promise(() => {}), full)
    expect(parseStored(localStorage.getItem(STORAGE_PREFIX + KEY))?.roomIds).toHaveLength(ROOM_IDS_MAX)
    expect(checkSentRecord({ ...full, roomIds: ids(ROOM_IDS_MAX + 1) })).toMatch(/超过 512 个.*未下发/)
    expect(parseStored(JSON.stringify({ ...rec({ msg: 206, deviceId: null, target: { switch: 1 } }), roomIds: ids(ROOM_IDS_MAX + 1) }))).toBeNull()
  })
  it('checkSentRecord：206 缺目标房间集合或为空 → 拒绝；201 正常记录通过；不合规记录拒绝', () => {
    expect(checkSentRecord({ msg: 206, deviceId: null, target: { switch: 1 } })).toMatch(/没有读到目标房间/)
    expect(checkSentRecord({ msg: 206, deviceId: null, target: { switch: 1 }, roomIds: [] })).toMatch(/没有读到目标房间/)
    expect(checkSentRecord(REC)).toBeNull()
    expect(checkSentRecord({ msg: 201, deviceId: 1, target: { access_token: 'A1' } })).toMatch(/不合规/)
  })
  it('checkSentRecord：203 运行模式为 0 一律拒发（不变是 -1）；-1 和合法模式通过', () => {
    const r203 = (systemMode: number) => ({ msg: 203, deviceId: null, target: { systemSwitch: -1, systemMode, roomSwitch: 1, roomTemp: -1 } })
    expect(checkSentRecord(r203(0))).toMatch(/运行模式为 0.*未下发/)
    expect(checkSentRecord(r203(-1))).toBeNull()
    expect(checkSentRecord(r203(100))).toBeNull()
  })
  it('206 漏传目标房间集合：告警、照常落盘锁住；回包里的房间全部一致也按无法核对，不放锁', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerVerifier(206, async (r) => matchAllRoomsSwitch(r, { data: [{ id: 1, switch: 1, isConnected: true }] } as never))
    const t = take(); claim(t)
    markSent(t, Promise.resolve(), { msg: 206, deviceId: null, target: { switch: 1 } })
    settle(t, 'unknown')
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('206 缺少目标房间集合'))
    expect(stored()).toHaveLength(1)
    expect(lockOf(PA)).toMatchObject({ lastVerify: 'unverifiable', lastFields: { switch: 'unverifiable' } })
    expect(await verify(KEY)).toBe('unverifiable')
    expect(lockOf(PA)).not.toBeNull()
  })
  it('206 已发出但目标房间集合为空数组：规范成缺失照常落盘，刷新恢复后仍锁住、核对按无法核对', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerVerifier(206, async (r) => matchAllRoomsSwitch(r, { data: [{ id: 1, switch: 1, isConnected: true }] } as never))
    const t = take(); claim(t)
    markSent(t, Promise.resolve(), { msg: 206, deviceId: null, target: { switch: 1 }, roomIds: [] })
    settle(t, 'unknown')
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('206 缺少目标房间集合'))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('不合规'))
    const saved = parseStored(localStorage.getItem(STORAGE_PREFIX + KEY))
    expect(saved).toMatchObject({ msg: 206 })
    expect(saved?.roomIds).toBeUndefined()
    expect(lockOf(PA)).toMatchObject({ lastVerify: 'unverifiable' })
    expect(await verify(KEY)).toBe('unverifiable')
    expect(lockOf(PA)).not.toBeNull()
  })
  it('206 目标房间在回包里缺失：剩下的房间一致也不放锁（无法核对）；全部在且一致才放', async () => {
    let data = [{ id: 1, switch: 1, isConnected: true }]
    registerVerifier(206, async (r) => matchAllRoomsSwitch(r, { data } as never))
    const t = take(); claim(t)
    markSent(t, Promise.resolve(), { msg: 206, deviceId: null, target: { switch: 1 }, roomIds: [1, 2] })
    settle(t, 'unknown')
    await flush()
    expect(lockOf(PA)).toMatchObject({ lastVerify: 'unverifiable' })
    data = [...data, { id: 2, switch: 1, isConnected: true }]
    expect(await verify(KEY)).toBe('released')
    expect(lockOf(PA)).toBeNull()
  })
  it('刷新恢复旧版 206 记录（没有 roomIds）：不能据部分回包判一致，锁保持', async () => {
    put(rec({ msg: 206, deviceId: null, target: { switch: 1 } }))
    vi.resetModules()
    const R = await import('../writeLock')
    R.configureWriteLock({ resolveProject: (id) => visible[id] ?? null })
    expect(R.lockOf(PA)).toMatchObject({ origin: 'restored' })
    R.registerVerifier(206, async (r) => matchAllRoomsSwitch(r, { data: [{ id: 1, switch: 1, isConnected: true }] } as never))
    await flush()
    expect(R.lockOf(PA)).toMatchObject({ lastVerify: 'unverifiable' })
    expect(stored()).toHaveLength(1)
  })
  it('核对数据不合规（凭据样的字段、非标量）：不落盘', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [{ msg: 201, deviceId: 1, target: { access_token: 'A1' } }, { msg: 201, deviceId: 1, target: { a: { b: 1 } } }] as unknown as L.SentRecord[]) {
      const t = take()
      markSent(t, new Promise(() => {}), bad)
      expect(stored()).toEqual([])
      __resetWriteLockForTests(() => acct)
    }
  })

  it('刷新恢复：记录一律按结果未知恢复；注册该消息号的核对器时立刻核对，一致放开并删记录', async () => {
    put(rec())
    vi.resetModules()
    const R = await import('../writeLock')
    R.configureWriteLock({ resolveProject: (id) => visible[id] ?? null })
    expect(R.lockOf(PB)).toMatchObject({ origin: 'restored', phase: 'unknown', sendSettled: true, label: '' })
    expect(R.acquire(PB).ok).toBe(false)
    const seen: L.StoredLock[] = []
    R.registerVerifier(201, async (r) => { seen.push(r); return true })
    await flush()
    expect(seen[0]).toMatchObject({ msg: 201, deviceId: 406658286, target: REC.target })
    expect(R.lockOf(PB)).toBeNull()
    expect(stored()).toEqual([])
  })
  it('刷新恢复后核对不一致：保持（不续期）；到期放开、通知、强制重读', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    put(rec({ sentAt: Date.now() - (DEFAULT_TTL_MS - 500) }))
    vi.resetModules()
    const R = await import('../writeLock')
    R.configureWriteLock({ resolveProject: (id) => visible[id] ?? null })
    const events: unknown[] = []
    R.onForceReread((e) => events.push(e))
    const exp0 = R.lockOf(PA)?.expiresAt
    expect(exp0).toBeDefined()
    R.registerVerifier(201, async () => false)
    await vi.advanceTimersByTimeAsync(10)
    expect(R.lockOf(PA)?.phase).toBe('unknown')
    expect(R.lockOf(PA)?.expiresAt).toBe(exp0) // 核对失败不续期
    let notified = 0
    R.subscribe(() => { notified += 1 })
    await vi.advanceTimersByTimeAsync(600)
    expect(R.lockOf(PA)).toBeNull()
    expect(notified).toBeGreaterThan(0)
    expect(events).toHaveLength(1)
    expect(stored()).toEqual([])
  })
  it('加载时作废：已到期、sentAt 晚于现在（时钟异常 / 篡改）、JSON 损坏、版本 / 字段不对、凭据样字段、非法锁键、存储键与主键不符', async () => {
    const now = Date.now()
    put(rec({ keys: ['screen:OLD'], sentAt: now - DEFAULT_TTL_MS - 1 }), 'screen:OLD')
    put(rec({ keys: ['screen:FUTURE'], sentAt: now + 60_000 }), 'screen:FUTURE')
    localStorage.setItem(STORAGE_PREFIX + 'screen:BAD1', '{不是 JSON')
    put({ ...rec({ keys: ['screen:BAD2'] }), v: 2 }, 'screen:BAD2')
    put({ ...rec({ keys: ['screen:BAD3'] }), target: { refresh_token: 'R' } }, 'screen:BAD3')
    put({ ...rec({ keys: ['screen:BAD4'] }), label: '客厅' }, 'screen:BAD4')
    put(rec({ keys: ['evil:x'] }), 'screen:BAD5')
    put(rec(), 'screen:MISMATCH')
    localStorage.setItem('other-key', 'keep')
    vi.resetModules()
    const R = await import('../writeLock')
    for (const k of ['screen:OLD', 'screen:FUTURE', KEY, 'screen:MISMATCH']) expect(R.lockOf(k)).toBeNull()
    expect(stored()).toEqual([])
    expect(localStorage.getItem('other-key')).toBe('keep')
  })
  it('跨标签：别的标签页写入的记录同步为 synced（拦住本标签）；对方删除时同步删除；坏数据忽略；本标签自己的锁不受别人删除影响', () => {
    const r = rec({ op: 'other-tab', projectId: 'pb', userId: 'u9' })
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: JSON.stringify(r) }))
    expect(lockOf(PA)).toMatchObject({ origin: 'synced', phase: 'unknown', owner: 'other-account', label: '', projectId: '' })
    expect(acquire(PA).ok).toBe(false)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: null }))
    expect(lockOf(PA)).toBeNull()
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: '{坏' }))
    expect(lockOf(PA)).toBeNull()
    toUnknown(async () => false)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: null }))
    expect(lockOf(PA)?.origin).toBe('local')
  })
  it('同步来的锁：verify 直接 send-pending、不读；到期放锁时不代删对方的记录', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fn = vi.fn(async () => true)
    registerVerifier(201, fn)
    const raw = JSON.stringify(rec({ op: 'other-tab', sentAt: Date.now() - (DEFAULT_TTL_MS - 100) }))
    localStorage.setItem(STORAGE_PREFIX + KEY, raw)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: raw }))
    expect(await verify(KEY)).toBe('send-pending')
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(lockOf(PA)).toBeNull()
    expect(localStorage.getItem(STORAGE_PREFIX + KEY)).toBe(raw)
  })
  it('别的标签页删除记录（放锁）：本标签按到期处理，发强制重读', () => {
    const events: unknown[] = []
    onForceReread((e) => events.push(e))
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: JSON.stringify(rec({ op: 'other-tab' })) }))
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: null }))
    expect(lockOf(PA)).toBeNull()
    expect(events).toEqual([{ keys: rec().keys, projectId: 'pa' }])
  })
  it('注册核对器不会去核对别的标签页同步来的锁（对方的写可能还在路上）', async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + KEY, newValue: JSON.stringify(rec({ op: 'other-tab' })) }))
    const fn = vi.fn(async () => true)
    registerVerifier(201, fn)
    await flush()
    expect(fn).not.toHaveBeenCalled()
    expect(lockOf(PA)?.origin).toBe('synced')
  })
})

describe('订阅与模块级', () => {
  it('每次状态变化都通知；订阅者抛错不影响锁', async () => {
    const seen: number[] = []
    const off = subscribe(() => seen.push(lockVersion()))
    const off2 = subscribe(() => { throw new Error('坏了') })
    const t = take()
    await drive(t, writeOnce(() => claim(t), async () => {}))
    expect(seen.length).toBeGreaterThanOrEqual(4)
    off(); off2()
  })
  it('组件卸载再挂载：锁仍在，页面能显示常驻锁提示', () => {
    function Banner() {
      useSyncExternalStore(subscribe, lockVersion, lockVersion)
      const l = lockOf(PB)
      return createElement('div', { 'data-testid': 'b' }, l ? `锁：${l.label} ${l.phase}` : '无锁')
    }
    const first = render(createElement(Banner))
    expect(first.getByTestId('b').textContent).toBe('无锁')
    let t!: LockToken
    act(() => { t = take() })
    expect(first.getByTestId('b').textContent).toBe('锁：客厅 held')
    first.unmount()
    act(() => { claim(t); markSent(t, new Promise(() => {}), REC); settle(t, 'unknown') })
    const second = render(createElement(Banner))
    expect(second.getByTestId('b').textContent).toBe('锁：客厅 unknown')
  })
})
