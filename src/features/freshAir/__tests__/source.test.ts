// 真实数据源：经 callCtrl 打假后端（不连任何真实后端），回包用实测记录的 base64 原文
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '@/api/auth'
import { setConfig } from '@/api/config'
import { encodeMessage } from '@/api/ctrl'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '@/api/http'
import { clearTokens, writeTokens } from '@/api/tokens'
import { fakeBackend, json, text } from '@/api/__tests__/helpers'
import { TEXT_UNSUPPORTED } from '../model'
import { mock210, realFreshAirSource } from '../source'
import { ID_240829001, ID_260911001, Q210_240829001, Q210_260911001, R202_260911001, R210_240829001, R210_260911001 } from './fixtures'

const PID = '6aa3a0ade8f3372b86b15b05'
const R202 = '/ctrl/fresh-dehumidifier-get'
const R210 = '/ctrl/running-ctrl-get'

beforeEach(() => {
  __resetHttpForTests()
  writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
  setCurrentUserId('u1')
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
})
afterEach(() => { vi.unstubAllGlobals(); setConfig(null); clearTokens() })

describe('realFreshAirSource', () => {
  it('202：请求体 Query 为空，回包解码出设备 id', async () => {
    const be = fakeBackend({ [R202]: () => json({ body: R202_260911001 }) })
    const r = await realFreshAirSource.units(PID)
    expect(be.calls[0].body).toEqual({ project_id: PID, user_id: 'u1', body: '' })
    expect(r.list.map((u) => u.deviceId)).toEqual([ID_260911001])
  })
  it('210：Query 只有 device_id（与实测 Query 原文一致），回包标注字段', async () => {
    const be = fakeBackend({ [R210]: () => json({ body: R210_260911001 }) })
    const r = await realFreshAirSource.settings(PID, ID_260911001)
    expect(be.calls[0].body).toEqual({ project_id: PID, user_id: 'u1', body: Q210_260911001 })
    expect(r).toMatchObject({ kind: 'ok', view: { deviceId: ID_260911001, fields: { humiditySet: { state: 'unsettable' } } } })
  })
  it('240829001 的「该软件类型不支持此控制」→ unsupported（不是故障）', async () => {
    const be = fakeBackend({ [R210]: () => json({ body: R210_240829001 }) })
    const r = await realFreshAirSource.settings('66cfd7959fb60d63c917fd0a', ID_240829001)
    expect(be.calls[0].body).toMatchObject({ body: Q210_240829001 })
    expect(r).toEqual({ kind: 'unsupported', message: TEXT_UNSUPPORTED, detail: '该软件类型不支持此控制' })
  })
  it('其他 ctrl 错误文案照常抛错，不当成不支持', async () => {
    // 只有 #2 的回包，文案不是「不支持」
    const body = encodeMessage(pb.RunningCtrlGetReplySchema, { name: '控制屏忙' })
    fakeBackend({ [R210]: () => json({ body }) })
    await expect(realFreshAirSource.settings(PID, ID_260911001)).rejects.toMatchObject({ kind: 'ctrl', message: '控制屏忙' })
  })
  it('回包 id 与请求不符、空回包 → ctrl 错误', async () => {
    fakeBackend({ [R210]: (_c, n) => json({ body: n === 1 ? R210_260911001 : '' }) })
    await expect(realFreshAirSource.settings(PID, ID_240829001)).rejects.toMatchObject({ kind: 'ctrl', message: '读到的运行设置不属于这台新风设备' })
    await expect(realFreshAirSource.settings(PID, ID_260911001)).rejects.toMatchObject({ kind: 'ctrl' })
  })
  it('错误码：503 控制屏未连接、403 无权限、504 未应答、500', async () => {
    fakeBackend({
      [R202]: () => json({ code: 14, message: '控制屏消息发送失败' }, 503),
      [R210]: (_c, n) => (n === 1 ? text('no permission', 403) : n === 2 ? json({ code: 4, message: 'x' }, 504) : json({ code: 13, message: 'x' }, 500)),
    })
    await expect(realFreshAirSource.units(PID)).rejects.toMatchObject({ kind: 'unavailable' })
    await expect(realFreshAirSource.settings(PID, 1)).rejects.toMatchObject({ kind: 'forbidden' })
    await expect(realFreshAirSource.settings(PID, 1)).rejects.toMatchObject({ kind: 'timeout' })
    await expect(realFreshAirSource.settings(PID, 1)).rejects.toMatchObject({ kind: 'server' })
  })
  it('只读：没有任何写接口请求', async () => {
    const be = fakeBackend({ [R202]: () => json({ body: R202_260911001 }), [R210]: () => json({ body: R210_260911001 }) })
    await realFreshAirSource.units(PID)
    await realFreshAirSource.settings(PID, ID_260911001)
    expect(be.calls.map((c) => new URL(c.url, 'http://x').pathname)).toEqual(['/api/ctrl/fresh-dehumidifier-get', '/api/ctrl/running-ctrl-get'])
  })
})

describe('mock210', () => {
  it('演示数据的「中」在 210 里没有对应值 → 无效', () => {
    const f = { name: 'x', control: 'dew', dewSet: 12, humSet: 50, fan: '中', on: true, mode: 2 } as Parameters<typeof mock210>[0]
    expect(mock210(f, 1)).toMatchObject({ controlType: 1, windSpeed: -100, switch: 1, canChange: true })
  })
})
