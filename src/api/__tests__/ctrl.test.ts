import { create, toBinary } from '@bufbuild/protobuf'
import { base64Encode, BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '../auth'
import { CTRL, callCtrl, decodeReply, encodeMessage, sendUnifiedCtrls } from '../ctrl'
import { setConfig } from '../config'
import * as pb from '../gen/ctrl200_pb.js'
import { __resetHttpForTests } from '../http'
import { clearTokens, writeTokens } from '../tokens'
import { withUnchanged } from '../values'
import { fakeBackend, json } from './helpers'

const b64 = (bytes: Uint8Array) => base64Encode(bytes)
/** 模拟后端：每 76 个字符换行 */
const wrap76 = (s: string) => s.replace(/(.{76})/g, '$1\n')
const fieldNumbers = (bytes: Uint8Array) => {
  const r = new BinaryReader(bytes); const out: number[] = []
  while (r.pos < r.len) { const [no, wt] = r.tag(); out.push(no); r.skip(wt, no) }
  return out
}

const ROOM = {
  id: 406658286, name: '房间11', temperature: 22, humidity: 60, dewPoint: 13.5, setTemp: 25.5, setHumi: 0,
  windSpeed: 3, eco: 0, switch: 1, mode: 1, isConnected: true,
  endModes: [
    { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
    { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 },
  ],
}

describe('ctrl 编解码', () => {
  it('11 条消息都有路由和 Query/Reply；写消息正好是 201/203/204/206', () => {
    expect(Object.keys(CTRL)).toEqual(['200', '201', '202', '203', '204', '205', '206', '207', '208', '209', '210'])
    expect(Object.entries(CTRL).filter(([, d]) => 'write' in d).map(([k]) => k)).toEqual(['201', '203', '204', '206'])
  })

  it('空 Query 编码为空串', () => {
    expect(encodeMessage(pb.RoomTemperatureDataGetQuerySchema, {})).toBe('')
  })

  it('201 Query 往返：int64、负数、嵌套末端', () => {
    const q = { equipmentId: 9326461980, ...withUnchanged(['temperature', 'humidity', 'windSpeed', 'eco', 'switch'] as const, { temperature: 26.5 }), endModes: [ROOM.endModes[0]] }
    const s = encodeMessage(pb.RoomTemperatureSetQuerySchema, q)
    expect(decodeReply(pb.RoomTemperatureSetQuerySchema, s)).toEqual(q)
    // 字段号按 proto：equipment_id=1, temperature=2, humidity=3, wind_speed=4, eco=8, switch=9, end_modes=10
    expect(fieldNumbers(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))).toEqual([1, 2, 3, 4, 8, 9, 10])
  })

  it('200 Reply：字段号不连续（#15 end_modes、#16 is_connected），带换行的 base64 也能解', () => {
    const bytes = toBinary(pb.RoomTemperatureDataGetReplySchema, create(pb.RoomTemperatureDataGetReplySchema, {
      data: [{ ...ROOM, id: BigInt(ROOM.id) }],
    }))
    const inner = new BinaryReader(bytes); inner.tag()
    expect(fieldNumbers(inner.bytes())).toEqual([1, 2, 3, 4, 5, 6, 8, 13, 14, 15, 15, 16])
    const s = wrap76(b64(bytes))
    expect(s).toContain('\n')
    const r = decodeReply(pb.RoomTemperatureDataGetReplySchema, s) as { data: typeof ROOM[] }
    expect(r.data[0]).toEqual(ROOM)
    expect(typeof r.data[0].id).toBe('number')
  })

  it('208 Query/Reply 往返（毫秒时间戳）', () => {
    const q = { deviceId: 2042830592, startTime: 1795388400000, endTime: 1795474800000 }
    expect(decodeReply(pb.TPAirSensorDataHourGetQuerySchema, encodeMessage(pb.TPAirSensorDataHourGetQuerySchema, q))).toEqual(q)
  })

  it('读消息 Reply 里出现 #2 错误文案 → ctrl 错误', () => {
    const bytes = new BinaryWriter().tag(2, WireType.LengthDelimited).string('错误的传感器id').finish()
    expect(() => decodeReply(pb.TPAirSensorDataHourGetReplySchema, b64(bytes))).toThrow(expect.objectContaining({ kind: 'ctrl', message: '错误的传感器id' }))
  })

  it('210 只有 #2 → 错误；正常 210 回复不误判', () => {
    const err = new BinaryWriter().tag(2, WireType.LengthDelimited).string('该软件类型不支持此控制').finish()
    expect(() => decodeReply(pb.RunningCtrlGetReplySchema, b64(err))).toThrow(expect.objectContaining({ kind: 'ctrl', message: '该软件类型不支持此控制' }))
    const ok = encodeMessage(pb.RunningCtrlGetReplySchema, { id: 1, name: '新风1', controlType: -1, dewPoint: -1, humiditySet: -1, canChange: false })
    expect(decodeReply(pb.RunningCtrlGetReplySchema, ok)).toMatchObject({ id: 1, name: '新风1', controlType: -1 })
  })

  it('设置类 Reply success=false → ctrl 错误，带 msg', () => {
    const fail = encodeMessage(pb.RoomTemperatureSetReplySchema, { success: false, msg: '房间已关闭' })
    expect(() => decodeReply(pb.RoomTemperatureSetReplySchema, fail)).toThrow(expect.objectContaining({ kind: 'ctrl', message: '房间已关闭' }))
    expect(() => decodeReply(pb.RoomTemperatureSetReplySchema, '')).toThrow(expect.objectContaining({ kind: 'ctrl', message: '下发失败' }))
    const ok = encodeMessage(pb.RoomTemperatureSetReplySchema, { success: true })
    expect(decodeReply(pb.RoomTemperatureSetReplySchema, ok)).toEqual({ success: true, msg: '' })
  })

  it('空 Reply（无数据）解为空列表', () => {
    expect(decodeReply(pb.TPAirSensorGetReplySchema, '')).toEqual({ data: [] })
  })
})

describe('callCtrl', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens()
    writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

  it('读消息：请求体 {project_id,user_id,body}，解出 Reply', async () => {
    setConfig({ apiBase: 'https://test.cosyhome.com.cn:9443/v1' })
    const reply = encodeMessage(pb.DeviceSummaryGetReplySchema, { data: [{ deviceId: 0, deviceName: 'KC2', model: '空气传感器', address: '1', connStatus: 1 }] })
    const be = fakeBackend({ '/v1/ctrl/device-summary-get': () => json({ body: wrap76(reply) }) })
    const r = await callCtrl(205, 'p1')
    expect(r.data[0]).toMatchObject({ deviceName: 'KC2', connStatus: 1 })
    expect(be.calls[0].url).toBe('https://test.cosyhome.com.cn:9443/v1/ctrl/device-summary-get')
    expect(be.calls[0].body).toEqual({ project_id: 'p1', user_id: 'u1', body: '' })
  })

  it('控制屏离线 503 → unavailable', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    fakeBackend({ '/ctrl/air-sensor-get': () => json({ code: 14, message: '控制屏消息发送失败' }, 503) })
    await expect(callCtrl(207, 'p1')).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('写消息在生产环境被拦截，不发请求', async () => {
    setConfig({ apiBase: 'https://api.cosyhome.com.cn/v1' })
    const be = fakeBackend({})
    await expect(callCtrl(206, 'p1', { switch: 1 })).rejects.toMatchObject({ kind: 'write_blocked' })
    await expect(sendUnifiedCtrls(['p1'], { roomTemp: 26 })).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('写消息在测试环境放行；超时提示结果未知', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test', ctrlTimeoutMs: 20 })
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))
    }))
    await expect(callCtrl(201, 'p1', { equipmentId: 1, temperature: 26 })).rejects.toMatchObject({ kind: 'timeout', message: '未收到控制屏应答，下发结果未知' })
  })

  it('批量统一控制：去重、不传 user_id、body 为 203 Query', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1', total: 2 }) })
    const q = { systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: 26 }
    await expect(sendUnifiedCtrls(['p1', 'p2', 'p1'], q)).resolves.toEqual({ batch_id: 'b1', total: 2 })
    const body = be.calls[0].body as { project_ids: string[]; body: string; user_id?: string }
    expect(body.project_ids).toEqual(['p1', 'p2'])
    expect(body.user_id).toBeUndefined()
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual(q)
  })
})
