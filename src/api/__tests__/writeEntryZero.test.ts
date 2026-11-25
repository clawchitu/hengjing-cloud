// 明确给出的 0 经真实写入口放行：writeCtrl / sendUnifiedCtrls → encodeWrite（最后防线）→ requestWrite → fetch。
// 只把 fetch 换成假后端，解码实际发出的请求体；不连任何真实后端。
// 0 在这些字段上是真实指令（关闭、湿度控制、低风速），用户明确选了就必须原样上线，其余不改的字段为 -1。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '../auth'
import { setConfig } from '../config'
import { buildRunningCtrlSet, buildUnifiedCtrlSet, decodeReply, encodeMessage, sendUnifiedCtrls, writeCtrl } from '../ctrl'
import * as pb from '../gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../http'
import { clearTokens, writeTokens } from '../tokens'
import { fakeBackend, json } from './helpers'

const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001' }
const P2 = { id: '66d0aa11bb22cc33dd44ee55', code: '260911001' }
const ok = (schema: Parameters<typeof encodeMessage>[0]) => () => json({ body: encodeMessage(schema, { success: true }) })
const sentBody = (be: ReturnType<typeof fakeBackend>, path: string) => {
  const calls = be.callsTo(path)
  expect(calls).toHaveLength(1)
  return (calls[0].body as { body: string }).body
}

describe('真实写入口：明确给出的 0 放行（解码实际请求体）', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens()
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
    setConfig({ apiBase: '/api', apiEnv: 'test' })
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

  it('203 单项目：roomSwitch=0（全部关闭）', async () => {
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok(pb.UnifiedCtrlSetReplySchema) })
    await expect(writeCtrl(203, P1, buildUnifiedCtrlSet({ roomSwitch: 0 }))).resolves.toMatchObject({ success: true })
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, sentBody(be, '/ctrl/unified-ctrl-set'))).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: 0, roomTemp: -1 })
  })

  it('203 批量：roomSwitch=0（全部关闭）', async () => {
    const be = fakeBackend({ '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1', total: 2 }) })
    await expect(sendUnifiedCtrls([P1, P2], buildUnifiedCtrlSet({ roomSwitch: 0 }))).resolves.toEqual({ batch_id: 'b1', total: 2 })
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, sentBody(be, '/ctrl/unified-ctrls-send'))).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: 0, roomTemp: -1 })
  })

  const base204 = { id: 9326461980, name: '新风1', controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: -1, switch: -1 }
  it.each([
    ['controlType=0（湿度控制）', { controlType: 0 }],
    ['windSpeed=0（低）', { windSpeed: 0 }],
    ['switch=0（关）', { switch: 0 }],
  ] as const)('204：%s', async (_name, change) => {
    const be = fakeBackend({ '/ctrl/running-ctrl-set': ok(pb.RunningCtrlSetReplySchema) })
    await expect(writeCtrl(204, P1, buildRunningCtrlSet(base204.id, base204.name, change))).resolves.toMatchObject({ success: true })
    expect(decodeReply(pb.RunningCtrlSetQuerySchema, sentBody(be, '/ctrl/running-ctrl-set'))).toEqual({ ...base204, ...change })
  })
})
