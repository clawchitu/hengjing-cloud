// S10c 204 写锁核对：record204 / match204（210 + 202 新读，只比对改动字段）、verifier204（刷新恢复用，真实接口 + 假后端）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRunningCtrlSet, encodeMessage } from '@/api/ctrl'
import { setConfig } from '@/api/config'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { setCurrentUserId } from '@/api/auth'
import { __resetHttpForTests } from '@/api/http'
import { clearTokens, writeTokens } from '@/api/tokens'
import { checkSentRecord, type StoredLock } from '@/api/writeLock'
import { fakeBackend, json } from '@/api/__tests__/helpers'
import { match204, record204, verifier204 } from '../lockVerify'
import type { Raw210 } from '../model'

const ID = 1514027092
const U = (o: object = {}) => ({ id: ID, isConnected: true, ...o })
const R = (o: Partial<Raw210> = {}): Raw210 => ({ id: ID, name: 'TXFS500', controlType: 0, dewPoint: 13, humiditySet: 55, windSpeed: 1, switch: 1, canChange: true, ...o })
const rec = (changes: Parameters<typeof buildRunningCtrlSet>[2]) => record204(buildRunningCtrlSet(ID, 'TXFS500', changes))

describe('record204', () => {
  it('只放五个可写字段，没改的 -1；能通过 checkSentRecord', () => {
    const r = rec({ windSpeed: 1 })
    expect(r).toEqual({ msg: 204, deviceId: ID, target: { controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 1, switch: -1 } })
    expect(checkSentRecord(r)).toBeNull()
    expect(checkSentRecord(rec({}))).not.toBeNull()
  })
})

describe('match204：只比对改动字段', () => {
  it('一致 → 已生效；不一致 → 未变化（0 是真实读数）', () => {
    expect(match204(rec({ windSpeed: 1 }), { units: { data: [U()] }, settings: R() })).toEqual({ verdict: 'applied', fields: { windSpeed: 'applied' } })
    expect(match204(rec({ windSpeed: 0 }), { units: { data: [U()] }, settings: R() })).toEqual({ verdict: 'unchanged', fields: { windSpeed: 'unchanged' } })
    expect(match204(rec({ windSpeed: 0 }), { units: { data: [U()] }, settings: R({ windSpeed: 0 }) })).toMatchObject({ verdict: 'applied' })
  })

  it('control_type = -1 的设备改风速：露点 / 湿度回读 -1 不参与，风速一致即已生效', () => {
    const s = R({ controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 1 })
    expect(match204(rec({ windSpeed: 1 }), { units: { data: [U()] }, settings: s })).toEqual({ verdict: 'applied', fields: { windSpeed: 'applied' } })
  })

  it('改动字段回读 -1 / 65536 → 无法核对', () => {
    for (const v of [-1, 65536]) {
      expect(match204(rec({ windSpeed: 1 }), { units: { data: [U()] }, settings: R({ windSpeed: v }) })).toEqual({ verdict: 'unverifiable', fields: { windSpeed: 'unverifiable' } })
      expect(match204(rec({ humiditySet: 56 }), { units: { data: [U()] }, settings: R({ humiditySet: v }) })).toEqual({ verdict: 'unverifiable', fields: { humiditySet: 'unverifiable' } })
    }
  })

  it('210 没有读数 / id 不符 → 无法核对；202 里设备缺失或重复 → 无法核对；设备未连接 → 结果未知', () => {
    expect(match204(rec({ windSpeed: 1 }), { units: { data: [U()] }, settings: null })).toMatchObject({ verdict: 'unverifiable' })
    expect(match204(rec({ windSpeed: 1 }), { units: { data: [U()] }, settings: R({ id: 7 }) })).toMatchObject({ verdict: 'unverifiable' })
    expect(match204(rec({ windSpeed: 1, switch: 1 }), { units: { data: [] }, settings: R() })).toEqual({ verdict: 'unverifiable', fields: { windSpeed: 'unverifiable', switch: 'unverifiable' } })
    expect(match204(rec({ windSpeed: 1 }), { units: { data: [U(), U()] }, settings: R() })).toMatchObject({ verdict: 'unverifiable' })
    expect(match204(rec({ windSpeed: 1 }), { units: { data: [U({ isConnected: false })] }, settings: R() })).toEqual({ verdict: 'unknown', fields: { windSpeed: 'unknown' } })
  })

  it('混合：一项一致、一项不一致 → 未变化（verdictOf）', () => {
    expect(match204(rec({ windSpeed: 1, switch: 0 }), { units: { data: [U()] }, settings: R() })).toEqual({ verdict: 'unchanged', fields: { windSpeed: 'applied', switch: 'unchanged' } })
  })

  it('核对数据不对 → false', () => {
    expect(match204({ msg: 201, deviceId: ID, target: { windSpeed: 1 } }, { units: { data: [U()] }, settings: R() })).toBe(false)
    expect(match204({ msg: 204, deviceId: null, target: { windSpeed: 1 } }, { units: { data: [U()] }, settings: R() })).toBe(false)
    expect(match204(rec({}), { units: { data: [] }, settings: R() })).toBe(false)
  })
})

describe('verifier204（刷新恢复的锁：新读 202 + 210）', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens()
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
    setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })
  const stored = (r: ReturnType<typeof rec>): StoredLock => ({ ...r, key: 'screen:S', projectId: 'p12', token: 't', owner: 'u#1', sentAt: Date.now(), expiresAt: Date.now() + 60_000 } as unknown as StoredLock)

  it('读 202、210（用设备 id），按改动字段比对；210「id 不符」按无法核对，不抛错', async () => {
    let s210: Raw210 = R({ windSpeed: 1 })
    const be = fakeBackend({
      '/ctrl/fresh-dehumidifier-get': () => json({ body: encodeMessage(pb.FreshDehumidifierGetReplySchema, { data: [U()] }) }),
      '/ctrl/running-ctrl-get': () => json({ body: encodeMessage(pb.RunningCtrlGetReplySchema, s210) }),
    })
    const ac = new AbortController()
    expect(await verifier204(stored(rec({ windSpeed: 1 })), ac.signal)).toEqual({ verdict: 'applied', fields: { windSpeed: 'applied' } })
    expect((be.callsTo('/ctrl/running-ctrl-get')[0].body as { project_id: string }).project_id).toBe('p12')
    s210 = R({ id: 7 })
    expect(await verifier204(stored(rec({ windSpeed: 1 })), ac.signal)).toEqual({ verdict: 'unverifiable', fields: { windSpeed: 'unverifiable' } })
  })

  it('读取失败（500）抛错（写锁记结果未知）', async () => {
    fakeBackend({
      '/ctrl/fresh-dehumidifier-get': () => json({ code: 13, message: 'x' }, 500),
    })
    await expect(verifier204(stored(rec({ windSpeed: 1 })), new AbortController().signal)).rejects.toBeTruthy()
  })
})
