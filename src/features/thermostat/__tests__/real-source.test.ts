// 真实下发链路：buildRoomSwitch（edit.ts）→ realSource.setRoom → writeCtrl(201) → encodeWrite（最后防线）→ requestWrite → fetch。
// 只把 fetch 换成假后端（src/api/__tests__/helpers.ts）；不连任何真实后端。
// 钉住：用户明确选的「关房间」（switch=0）一路传到线上，不会被最后防线误拒；没改的标量为 -1。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '@/api/auth'
import { setConfig } from '@/api/config'
import { decodeReply, encodeMessage } from '@/api/ctrl'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '@/api/http'
import { clearTokens, writeTokens } from '@/api/tokens'
import { fakeBackend, json } from '@/api/__tests__/helpers'
import { buildRoomSwitch } from '../edit'
import type { RoomView } from '../model'
import { realSource } from '../source'

const P = { id: '66cfd7959fb60d63c917fd0a', code: '240829001' }
const ENDS = [
  { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
  { optionName: '顶辐射', type: 1, isSelected: true, isChange: true, switch: 0 },
]
const room: RoomView = {
  key: '406658286', equipmentId: 406658286, name: '客厅', temp: 25.8, humidity: 51, dew: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0,
  on: true, switchKnown: true, mode: '制冷', endModes: [], wireEndModes: ENDS, connected: true,
}

describe('温控面板真实下发链路（realSource.setRoom + 假后端）', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens()
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
    setConfig({ apiBase: '/api', apiEnv: 'test' })
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

  it('201 关房间（0 是明确改动）：请求发出，线上解码 switch=0，其余标量 -1、末端不改', async () => {
    const be = fakeBackend({ '/ctrl/room-temperature-set': () => json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: true }) }) })
    const built = buildRoomSwitch(room, false, { online: true, fresh: true })
    if (!built.ok) throw new Error(built.reason)
    await realSource.setRoom(P, built.query, () => true)
    const calls = be.callsTo('/ctrl/room-temperature-set')
    expect(calls).toHaveLength(1)
    expect(decodeReply(pb.RoomTemperatureSetQuerySchema, (calls[0].body as { body: string }).body))
      .toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: 0, endModes: [] })
  })
})
