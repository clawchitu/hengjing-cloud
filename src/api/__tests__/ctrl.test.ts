import { create, toBinary } from '@bufbuild/protobuf'
import { base64Encode, BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '../auth'
import { CTRL, buildProjectRoomSwitchSet, buildRoomTemperatureSet, buildRunningCtrlSet, buildUnifiedCtrlSet, callCtrl, decodeReply, encodeMessage, encodeWrite, sendUnifiedCtrls, validateWriteQuery, writeCtrl } from '../ctrl'
import { setConfig } from '../config'
import * as pb from '../gen/ctrl200_pb.js'
import { __resetHttpForTests, request, requestWrite } from '../http'
import { __resetSealedForTests } from '../guard'
import { ctrlQuery } from '../query'
import { clearTokens, writeTokens } from '../tokens'
import { withUnchanged } from '../values'
import { fakeBackend, json, sealedBody } from './helpers'

// 后端实体 id 与项目 code 不同：白名单按 code，请求体用 id
const P1 = { id: '66cfd7959fb60d63c917fd0a', code: '240829001' }
const P2 = { id: '66d0aa11bb22cc33dd44ee55', code: '260911001' }

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
  it('200 的 switch / set_temp 是普通 proto3 标量：值为 0 时不上线，解码为 0（关），是真实读数', () => {
    const r = decodeReply(pb.RoomTemperatureDataGetReplySchema, encodeMessage(pb.RoomTemperatureDataGetReplySchema, { data: [{ id: 1, name: '房间11', temperature: 22 }] })) as { data: Array<Record<string, unknown>> }
    expect(r.data[0].switch).toBe(0)
    expect(r.data[0].setTemp).toBe(0)
  })

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
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
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
    await expect(writeCtrl(206, P1, buildProjectRoomSwitchSet(true))).rejects.toMatchObject({ kind: 'write_blocked' })
    await expect(sendUnifiedCtrls([P1], buildUnifiedCtrlSet({ roomTemp: 26 }))).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('写消息在测试环境放行；超时提示结果未知，只发一次', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test', ctrlTimeoutMs: 20 })
    const fetchMock = vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(writeCtrl(201, P1, buildRoomTemperatureSet(1, { temperature: 26 }))).rejects.toMatchObject({ kind: 'timeout', message: '未收到控制屏应答，下发结果未知' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('Worker 代理连不上后端（502，不带 code）：写操作提示结果未知，不当作控制屏未连接，只发一次', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: '后端连接失败' }), { status: 502, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(writeCtrl(201, P1, buildRoomTemperatureSet(1, { temperature: 26 }))).rejects.toMatchObject({ kind: 'network', message: '后端连接失败，下发结果未知' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('上游真实的 503 code 14 仍是控制屏未连接（确定未下发）', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 14, message: '控制屏未连接' }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    await expect(writeCtrl(201, P1, buildRoomTemperatureSet(1, { temperature: 26 }))).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('写消息成功：201 只改温度时，其余字段编码后为 -1、末端为空', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/room-temperature-set': () => json({ body: encodeMessage(pb.RoomTemperatureSetReplySchema, { success: true }) }) })
    await expect(writeCtrl(201, P1, buildRoomTemperatureSet(406658286, { temperature: 26 }))).resolves.toMatchObject({ success: true })
    const sent = decodeReply(pb.RoomTemperatureSetQuerySchema, (be.calls[0].body as { body: string }).body)
    expect(sent).toEqual({ equipmentId: 406658286, temperature: 26, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: [] })
  })

  it('批量统一控制：去重、不传 user_id、body 为 203 Query', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1', total: 2 }) })
    const q = buildUnifiedCtrlSet({ roomTemp: 26 })
    expect(q).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: 26 })
    await expect(sendUnifiedCtrls([P1, P2, { ...P1 }], q)).resolves.toEqual({ batch_id: 'b1', total: 2 })
    const body = be.calls[0].body as { project_ids: string[]; body: string; user_id?: string }
    expect(body.project_ids).toEqual([P1.id, P2.id])
    expect(body.user_id).toBeUndefined()
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual(q)
  })
})

describe('写防护按项目 code：201/203/204/206 与批量统一控制', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens()
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

  const cases = [
    [201, () => buildRoomTemperatureSet(1, { temperature: 26 })],
    [203, () => buildUnifiedCtrlSet({ roomTemp: 26 })],
    [204, () => buildRunningCtrlSet(9, '新风1', { dewPoint: 14 })],
    [206, () => buildProjectRoomSwitchSet(true)],
  ] as const
  const routes = () => Object.fromEntries(cases.map(([t]) => [`/ctrl/${CTRL[t].route}`, () => json({ body: encodeMessage(CTRL[t].reply, { success: true }) })]))

  it.each(cases)('%i：code 在白名单内放行，请求体 project_id 用实体 id', async (type, build) => {
    setConfig({ apiBase: '/api', apiEnv: 'test', writeProjectCodes: [P1.code] })
    const be = fakeBackend(routes())
    await expect(writeCtrl(type, P1, build() as never)).resolves.toMatchObject({ success: true })
    expect(be.calls).toHaveLength(1)
    expect(be.calls[0].url).toBe(`/api/ctrl/${CTRL[type].route}`)
    expect((be.calls[0].body as { project_id: string }).project_id).toBe(P1.id)
    expect(JSON.stringify(be.calls[0].body)).not.toContain(P1.code)
  })

  it.each(cases)('%i：code 不在白名单 / 名单为空 / 名单里写的是 id → 拒绝，不发请求', async (type, build) => {
    for (const writeProjectCodes of [[P2.code], [], [P1.id]]) {
      setConfig({ apiBase: '/api', apiEnv: 'test', writeProjectCodes })
      const be = fakeBackend(routes())
      await expect(writeCtrl(type, P1, build() as never)).rejects.toMatchObject({ kind: 'write_blocked' })
      expect(be.calls).toHaveLength(0)
    }
  })

  it.each(cases)('%i：code 缺失、为空、类型不对 → 拒绝，不发请求', async (type, build) => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    for (const bad of [{ id: P1.id }, { id: P1.id, code: '' }, { id: P1.id, code: 240829001 }, { id: P1.id, code: null }, P1.id]) {
      const be = fakeBackend(routes())
      await expect(writeCtrl(type, bad as never, build() as never)).rejects.toMatchObject({ kind: 'write_blocked' })
      expect(be.calls).toHaveLength(0)
    }
  })

  it('批量统一控制：全部在白名单内放行，project_ids 用实体 id', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1', total: 2 }) })
    await sendUnifiedCtrls([P1, P2], buildUnifiedCtrlSet({ roomTemp: 26 }))
    expect((be.calls[0].body as { project_ids: string[] }).project_ids).toEqual([P1.id, P2.id])
  })

  it('批量统一控制：有一个不在白名单或 code 不合规就整批拒绝', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test', writeProjectCodes: [P1.code] })
    const be = fakeBackend({ '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1', total: 2 }) })
    const q = buildUnifiedCtrlSet({ roomTemp: 26 })
    await expect(sendUnifiedCtrls([P1, P2], q)).rejects.toMatchObject({ kind: 'write_blocked' })
    await expect(sendUnifiedCtrls([P1, { id: P2.id } as never], q)).rejects.toMatchObject({ kind: 'write_blocked' })
    await expect(sendUnifiedCtrls([], q)).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('requestWrite()：项目字段由写入口用防护通过后的快照填入，code 只读一次', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test', writeProjectCodes: [P1.code] })
    const be = fakeBackend({ '/ctrl/project-room-switch-set': () => json({}) })
    let n = 0
    const flaky = { id: P1.id, get code() { return n++ === 0 ? P1.code : 'evil' } }
    await requestWrite('ctrl-206', [flaky], { body: sealedBody('ctrl-206') })
    expect(n).toBe(1)
    expect(be.calls[0].body).toEqual({ body: 'CAE=', project_id: P1.id })
  })

  it('requestWrite()：调用方自带项目字段（借白名单项目过检、换成别的 id）一律拒绝，不发请求', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/project-room-switch-set': () => json({}), '/ctrl/unified-ctrls-send': () => json({}) })
    for (const key of ['project_id', 'project_ids', 'projectId', 'projectIds', 'PROJECT_ID']) {
      await expect(requestWrite('ctrl-206', [P1], { [key]: 'other-entity-id' })).rejects.toMatchObject({ kind: 'write_blocked' })
      await expect(requestWrite('unified-ctrls-send', [P1], { [key]: ['other-entity-id'] })).rejects.toMatchObject({ kind: 'write_blocked' })
    }
    for (const bad of [null, [], 'x']) await expect(requestWrite('ctrl-206', [P1], bad as never)).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('requestWrite()：body 不是普通对象、带函数字段（含 toJSON）、访问器、Symbol 键 → 拒绝，不发请求（单项目与批量）', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/project-room-switch-set': () => json({}), '/ctrl/unified-ctrls-send': () => json({}) })
    const evil = () => ({ project_id: 'other-entity-id', project_ids: ['other-entity-id'] })
    class Body { body = '' }
    const bads: unknown[] = [
      { toJSON: evil },
      { body: '', toJSON: evil },
      Object.assign(Object.create(null), { toJSON: evil }),
      Object.create({ toJSON: evil }),
      { body: '', get user_id() { return 'u' } },
      Object.defineProperty({}, 'toJSON', { value: evil, enumerable: false }),
      { body: '', [Symbol('x')]: 1 },
      new Body(),
      new Map(),
      new Date(),
      new Proxy({}, { getPrototypeOf: () => { throw new Error('x') } }),
    ]
    for (const bad of bads) {
      await expect(requestWrite('ctrl-206', [P1], bad as never)).rejects.toMatchObject({ kind: 'write_blocked' })
      await expect(requestWrite('unified-ctrls-send', [P1, P2], bad as never)).rejects.toMatchObject({ kind: 'write_blocked' })
    }
    expect(be.calls).toHaveLength(0)
  })

  it('requestWrite()：普通对象（含 null 原型）浅拷贝后填入快照 id，不修改调用方对象（单项目与批量）', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/project-room-switch-set': () => json({}), '/ctrl/unified-ctrls-send': () => json({}) })
    const b1 = { user_id: 'u1', body: sealedBody('ctrl-206') }
    await requestWrite('ctrl-206', [P1], b1)
    expect(be.calls[0].body).toEqual({ user_id: 'u1', body: 'CAE=', project_id: P1.id })
    expect(b1).toEqual({ user_id: 'u1', body: 'CAE=' })
    const b2 = Object.assign(Object.create(null) as Record<string, unknown>, { body: sealedBody('unified-ctrls-send', 'GAE=') })
    await requestWrite('unified-ctrls-send', [P1, P2], b2)
    expect(be.calls[1].body).toEqual({ body: 'GAE=', project_ids: [P1.id, P2.id] })
    expect(Object.keys(b2)).toEqual(['body'])
  })

  it('requestWrite()：单项目写消息传多个项目 → 拒绝；批量统一控制填 project_ids', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrls-send': () => json({}) })
    for (const op of ['ctrl-201', 'ctrl-203', 'ctrl-204', 'ctrl-206'] as const) {
      await expect(requestWrite(op, [P1, P2], {})).rejects.toMatchObject({ kind: 'write_blocked' })
    }
    expect(be.calls).toHaveLength(0)
    await requestWrite('unified-ctrls-send', [P1, P2], { body: sealedBody('unified-ctrls-send', 'GAE=') })
    expect(be.calls[0].body).toEqual({ body: 'GAE=', project_ids: [P1.id, P2.id] })
  })
})

describe('写消息不依赖 proto 默认值', () => {
  it('build* 把没改的标量填 -1', () => {
    expect(buildRunningCtrlSet(9, '新风1', { dewPoint: 14 })).toEqual({ id: 9, name: '新风1', controlType: -1, dewPoint: 14, humiditySet: -1, windSpeed: -1, switch: -1 })
    expect(buildProjectRoomSwitchSet(false)).toEqual({ switch: 0 })
  })

  it.each([
    [201, { equipmentId: 1, temperature: 26 }, 'humidity'],
    [203, { roomTemp: 26 }, 'systemSwitch'],
    [204, { id: 1, name: 'x', controlType: 1 }, 'dewPoint'],
    [206, {}, 'switch'],
  ] as const)('%i 缺字段的写请求被拒绝，不发请求', async (type, q, missing) => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({})
    await expect(writeCtrl(type, P1, q as never)).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringContaining(missing) })
    expect(be.calls).toHaveLength(0)
    setConfig(null)
  })

  it.each([
    ['undefined', undefined], ['null', null], ["字符串 'false'", 'false'], ["字符串 'true'", 'true'], ['数字 0', 0], ['数字 1', 1], ['对象', {}],
  ] as const)('206 全部房间开关：非布尔值（%s）拒绝，不发请求', async (_, v) => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({})
    expect(() => buildProjectRoomSwitchSet(v as never)).toThrow(expect.objectContaining({ kind: 'bad_request' }))
    await expect(Promise.resolve().then(() => writeCtrl(206, P1, buildProjectRoomSwitchSet(v as never)))).rejects.toMatchObject({ kind: 'bad_request' })
    expect(be.calls).toHaveLength(0)
    setConfig(null)
  })

  it('206 全部房间开关：true → 1，false → 0', () => {
    expect(buildProjectRoomSwitchSet(true)).toEqual({ switch: 1 })
    expect(buildProjectRoomSwitchSet(false)).toEqual({ switch: 0 })
  })

  it('build* 收到 null 或不传 changes 时一律按不变（-1）处理，不会落成 0', () => {
    expect(buildRoomTemperatureSet(1, { switch: null, eco: null } as never)).toMatchObject({ switch: -1, eco: -1 })
    expect(buildRoomTemperatureSet(1, undefined as never)).toMatchObject({ temperature: -1, switch: -1, endModes: [] })
    // 203 运行模式是枚举，不变是 0（OPERATION_MODE_NONE）；其余数值字段 -1
    expect(buildUnifiedCtrlSet(undefined as never)).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: -1 })
    expect(buildRunningCtrlSet(1, 'x', undefined as never)).toMatchObject({ controlType: -1, switch: -1 })
  })

  it('布尔或字符串冒充数值字段被拒绝（不会被当成 0/1）', () => {
    expect(() => validateWriteQuery(pb.RoomTemperatureSetQuerySchema, buildRoomTemperatureSet(1, { switch: false } as never))).toThrow(/switch/)
    expect(() => validateWriteQuery(pb.ProjectRoomSwitchSetQuerySchema, { switch: '0' })).toThrow(/switch/)
    expect(() => validateWriteQuery(pb.UnifiedCtrlSetQuerySchema, buildUnifiedCtrlSet({ roomSwitch: true } as never))).toThrow(/roomSwitch/)
  })

  it('NaN、嵌套末端缺字段也拒绝', () => {
    expect(() => validateWriteQuery(pb.RoomTemperatureSetQuerySchema, { ...buildRoomTemperatureSet(1, {}), temperature: NaN })).toThrow(/temperature/)
    expect(() => validateWriteQuery(pb.RoomTemperatureSetQuerySchema, buildRoomTemperatureSet(1, { endModes: [{ optionName: '风盘', type: 0 } as never] }))).toThrow(/endModes\[0\]\.isSelected/)
  })
})

describe('写接口只有一个入口', () => {
  beforeEach(() => { writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 }) })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

  it('request() 直接请求写接口路径一律拒绝（测试环境也一样），不发请求', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({})
    for (const p of ['/ctrl/room-temperature-set', '/ctrl/unified-ctrl-set', '/ctrl/running-ctrl-set', '/ctrl/project-room-switch-set',
      '/ctrl/unified-ctrls-send', 'ctrl/project-room-switch-set/', '/v1/ctrl/room-temperature-set?x=1', '/ctrl/some-new-set', '/ctrl/trans-ctrl-message']) {
      await expect(request(p, { body: {} })).rejects.toMatchObject({ kind: 'write_blocked' })
    }
    expect(be.calls).toHaveLength(0)
  })

  it('request()：非规范写法的写接口路径（./、..、反斜杠、重复斜杠、大小写、空白、编码、查询串）也拒绝，不发请求', async () => {
    for (const apiBase of ['/api', 'https://api.cosyhome.com.cn/v1']) {
      setConfig({ apiBase })
      const be = fakeBackend({})
      for (const p of ['/./ctrl/room-temperature-set', '/x/../ctrl/room-temperature-set', '/ctrl\\room-temperature-set', '//ctrl//room-temperature-set',
        '/CTRL/Room-Temperature-Set', '/V1/ctrl/project-room-switch-set', '/ctrl/room-temperature-set ', '/ctrl/room-temperature-set\n', '/ctrl/room-\ttemperature-set',
        '/ctrl/room-temperature-set?a=1#b', '/ctrl/room%2Dtemperature-set', '/ctrl%2Froom-temperature-set', '/ctrl/%2e/unified-ctrl-set', '/../v1/ctrl/unified-ctrls-send']) {
        await expect(request(p, { body: {} }), p).rejects.toMatchObject({ kind: expect.stringMatching(/^(write_blocked|bad_request)$/) })
      }
      expect(be.calls).toHaveLength(0)
    }
    setConfig(null)
  })

  it('callCtrl() 遇到写消息号拒绝', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({})
    for (const t of [201, 203, 204, 206]) await expect(callCtrl(t as never, 'p1')).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('requestWrite() 自带防护：生产 / writeMode=off 拦截', async () => {
    const be = fakeBackend({})
    setConfig({ apiBase: 'https://api.cosyhome.com.cn/v1' })
    await expect(requestWrite('ctrl-206', [P1], {})).rejects.toMatchObject({ kind: 'write_blocked' })
    setConfig({ apiBase: '/api', apiEnv: 'test', writeMode: 'off' })
    await expect(requestWrite('unified-ctrls-send', [P1], {})).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('ctrlQuery 只接受只读消息号', () => {
    for (const t of [201, 203, 204, 206]) expect(() => ctrlQuery(t as never, 'p1')).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
    expect(ctrlQuery(205, 'p1').queryKey).toEqual(['ctrl', 205, 'p1', null])
  })
})

describe('发送边界：直接调 requestWrite 也绕不过写消息校验', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens(); __resetSealedForTests()
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
    setConfig({ apiBase: '/api', apiEnv: 'test', writeProjectCodes: [P1.code, P2.code] })
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })
  const routes = {
    '/ctrl/unified-ctrl-set': () => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success: true }) }),
    '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1' }),
    '/ctrl/project-room-switch-set': () => json({ body: encodeMessage(pb.ProjectRoomSwitchSetReplySchema, { success: true }) }),
  }
  // #60 那条：system_mode = -1（10 字节 varint）
  const MINUS1 = 'CP///////////wEQ////////////ARgBJQAAgL8='

  it('手写 body 没经过 encodeWrite：空串（全部 0 = 关系统、关房间、温度 0）、00:20 那条、#60 那条一律 write_blocked，不发请求', async () => {
    const be = fakeBackend(routes)
    for (const body of ['', 'CP///////////wEYASUAAIC/', MINUS1]) {
      await expect(requestWrite('ctrl-203', [P1], { user_id: 'u1', body }), JSON.stringify(body)).rejects.toMatchObject({ kind: 'write_blocked', message: expect.stringMatching(/encodeWrite/) })
      await expect(requestWrite('unified-ctrls-send', [P1, P2], { body }), JSON.stringify(body)).rejects.toMatchObject({ kind: 'write_blocked', message: expect.stringMatching(/encodeWrite/) })
    }
    await expect(requestWrite('ctrl-206', [P1], { user_id: 'u1', body: '' })).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })
  it('登记过但枚举外（-1、7）仍拒发：发送边界按 schema 解码再查枚举', async () => {
    const be = fakeBackend(routes)
    const bad = [MINUS1, encodeMessage(pb.UnifiedCtrlSetQuerySchema, { systemSwitch: -1, systemMode: 7, roomSwitch: 1, roomTemp: -1 })]
    for (const body of bad) {
      await expect(requestWrite('ctrl-203', [P1], { user_id: 'u1', body: sealedBody('ctrl-203', body) })).rejects.toMatchObject({ kind: 'write_blocked', message: expect.stringMatching(/不在枚举/) })
      await expect(requestWrite('unified-ctrls-send', [P1, P2], { body: sealedBody('unified-ctrls-send', body) })).rejects.toMatchObject({ kind: 'write_blocked', message: expect.stringMatching(/不在枚举/) })
    }
    expect(be.calls).toHaveLength(0)
  })
  it('非规范 base64（带空白、base64url、拼接）即使登记过也拒发；请求体带未知字段拒发', async () => {
    const be = fakeBackend(routes)
    const ok = encodeMessage(pb.UnifiedCtrlSetQuerySchema, { systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 })
    for (const body of [ok + '\n', ` ${ok}`, ok.replace(/\//g, '_'), 'CAE=CAE=', 'CAE']) {
      await expect(requestWrite('ctrl-203', [P1], { user_id: 'u1', body: sealedBody('ctrl-203', body) }), JSON.stringify(body)).rejects.toMatchObject({ kind: 'write_blocked' })
    }
    await expect(requestWrite('unified-ctrls-send', [P1], { body: sealedBody('unified-ctrls-send', ok), shadow_body: 'x' })).rejects.toMatchObject({ kind: 'write_blocked', message: expect.stringMatching(/shadow_body/) })
    await expect(requestWrite('unified-ctrls-send', [P1], { body: sealedBody('unified-ctrls-send', ok), user_id: 'u1' })).rejects.toMatchObject({ kind: 'write_blocked', message: expect.stringMatching(/user_id/) })
    await expect(requestWrite('ctrl-203', [P1], { user_id: 1, body: sealedBody('ctrl-203', ok) } as never)).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })
  it('body 缺失、不是字符串、解不出来 → write_blocked，不发请求', async () => {
    const be = fakeBackend(routes)
    for (const b of [{}, { body: 1 }, { body: null }, { body: sealedBody('ctrl-203', '////') }]) {
      await expect(requestWrite('ctrl-203', [P1], b as never), JSON.stringify(b)).rejects.toMatchObject({ kind: 'write_blocked' })
    }
    expect(be.calls).toHaveLength(0)
  })
  it('登记是按写接口、一次一用：203 登记的 body 不能拿去发批量，发过一次不能再直接重发', async () => {
    const be = fakeBackend(routes)
    const body = encodeWrite('ctrl-203', pb.UnifiedCtrlSetQuerySchema, buildUnifiedCtrlSet({ roomTemp: 24 }))
    await expect(requestWrite('unified-ctrls-send', [P1], { body })).rejects.toMatchObject({ kind: 'write_blocked' })
    await requestWrite('ctrl-203', [P1], { user_id: 'u1', body })
    await expect(requestWrite('ctrl-203', [P1], { user_id: 'u1', body })).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(1)
  })
  it('经 writeCtrl / sendUnifiedCtrls 组装的照常发出（system_mode = 0 不变、可选模式）', async () => {
    const be = fakeBackend(routes)
    await writeCtrl(203, P1, buildUnifiedCtrlSet({ roomSwitch: 1 }))
    await sendUnifiedCtrls([P1], buildUnifiedCtrlSet({ systemMode: 100 as never }))
    expect(be.calls).toHaveLength(2)
  })
})

describe('11/25 事故回归：203 运行模式不变传 0（枚举 NONE），-1 在编码前被拦下', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens()
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
    setConfig({ apiBase: '/api', apiEnv: 'test', writeProjectCodes: [P1.code] })
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })
  const ok = (t: 203 | 201 | 206) => ({ [`/ctrl/${CTRL[t].route}`]: () => json({ body: encodeMessage(CTRL[t].reply, { success: true }) }) })

  it('「全部开启」实际发出的 body：system_mode = 0 不上线（base64 断言，与 11/25 15:35 真机成功的编码同形）', async () => {
    const be = fakeBackend(ok(203))
    await writeCtrl(203, P1, buildUnifiedCtrlSet({ roomSwitch: 1 }))
    const body = (be.calls[0].body as { body: string }).body
    // 08 <-1> 18 01 25 <-1.0f>：没有 #2，后端解出 system_mode = 0 = OPERATION_MODE_NONE（不变）
    expect(body).toBe('CP///////////wEYASUAAIC/')
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body)).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 })
  })

  it('#60 那种请求（system_mode = -1，枚举外）不发：writeCtrl 与批量统一控制都拒绝，不发请求', async () => {
    const be = fakeBackend({ ...ok(203), '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1' }) })
    const q = { systemSwitch: -1, systemMode: -1, roomSwitch: 1, roomTemp: -1 } as never
    await expect(writeCtrl(203, P1, q)).rejects.toMatchObject({ kind: 'write_blocked' })
    await expect(writeCtrl(203, P1, buildUnifiedCtrlSet({ systemMode: -1 as never, roomSwitch: 1 }))).rejects.toMatchObject({ kind: 'write_blocked', message: expect.stringMatching(/不在枚举|运行模式为 -1/) })
    await expect(sendUnifiedCtrls([P1], q)).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('system_mode = 0（不变）照常下发：writeCtrl 与批量统一控制都放行', async () => {
    const be = fakeBackend({ ...ok(203), '/ctrl/unified-ctrls-send': () => json({ batch_id: 'b1' }) })
    await expect(writeCtrl(203, P1, buildUnifiedCtrlSet({ systemMode: 0 as never, roomTemp: 24 }))).resolves.toMatchObject({ success: true })
    await expect(sendUnifiedCtrls([P1], buildUnifiedCtrlSet({ roomTemp: 24 }))).resolves.toMatchObject({ batch_id: 'b1' })
    expect(be.calls).toHaveLength(2)
  })

  it('不是 build* 组装的写消息：任何数值为 0 都拒发；组装函数明确给出的 0 照常下发', async () => {
    const be = fakeBackend({ ...ok(201), ...ok(206) })
    await expect(writeCtrl(206, P1, { switch: 0 })).rejects.toMatchObject({ kind: 'write_blocked' })
    await expect(writeCtrl(201, P1, { equipmentId: 1, temperature: 26, humidity: -1, windSpeed: -1, eco: 0, switch: -1, endModes: [] })).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
    await expect(writeCtrl(206, P1, buildProjectRoomSwitchSet(false))).resolves.toMatchObject({ success: true })
    await expect(writeCtrl(201, P1, buildRoomTemperatureSet(1, { eco: 0 }))).resolves.toMatchObject({ success: true })
    expect(be.calls).toHaveLength(2)
  })
})
