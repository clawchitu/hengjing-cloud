// 温度边界与步长、不能设置的情况、节能锁温度、草稿生命周期、201 Query 组装
// （只发改了的标量、不改的 -1、end_modes 用最新读数原样传回、读不到末端不下发）、下发结果分类。
import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage } from '@/api/ctrl'
import { ApiError } from '@/api/errors'
import * as pb from '@/api/gen/ctrl200_pb.js'
import {
  buildRoomSet, buildRoomSwitch, canStep, describeChanges, describeResult, draftChanges, editBlock, editDraft, newDraft, reconcileDraft,
  resolveTempRange, stepTemp, switchBlock, tempBlock, type RoomDraft,
} from '../edit'
import { classify } from '../writes'
import type { RoomView } from '../model'

const R = resolveTempRange(null)
const OK = { online: true, fresh: true }
const ENDS = [
  { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
  { optionName: '顶辐射', type: 1, isSelected: true, isChange: true, switch: 0 },
]
const room = (o: Partial<RoomView> = {}): RoomView => ({
  key: '406658286', equipmentId: 406658286, name: '客厅', temp: 25.8, humidity: 51, dew: 14.9, setTemp: 25.5, windSpeed: 3, eco: 0,
  on: true, mode: '制冷', endModes: [], wireEndModes: ENDS, connected: true, ...o,
})
const draft = (o: Partial<RoomDraft> = {}): RoomDraft => ({ key: '406658286', base: { setTemp: 25.5, eco: 0 }, ...o })
/** 201 Query 编码后再按 proto 解码（下发到线上的就是这些值） */
const wire = (q: object) => decodeReply(pb.RoomTemperatureSetQuerySchema, encodeMessage(pb.RoomTemperatureSetQuerySchema, q))
const q = (b: ReturnType<typeof buildRoomSet>) => { if (!b.ok) throw new Error(b.reason); return b.query }

describe('设定温度范围与步长', () => {
  it('默认 16–30℃、步长 0.5；后端给了范围以后按后端的', () => {
    expect(R).toEqual({ min: 16, max: 30, step: 0.5 })
    expect(resolveTempRange({ min: 18, max: 28, step: 1 })).toEqual({ min: 18, max: 28, step: 1 })
  })
  it('每次 ±0.5；到 30 不能再加，到 16 不能再减', () => {
    expect(stepTemp(25.5, 1, R)).toBe(26)
    expect(stepTemp(25.5, -1, R)).toBe(25)
    expect(stepTemp(29.5, 1, R)).toBe(30)
    expect(stepTemp(30, 1, R)).toBe(30)
    expect(stepTemp(16.5, -1, R)).toBe(16)
    expect(stepTemp(16, -1, R)).toBe(16)
    expect(canStep(30, 1, R)).toBe(false)
    expect(canStep(29.5, 1, R)).toBe(true)
    expect(canStep(16, -1, R)).toBe(false)
    expect(canStep(16.5, -1, R)).toBe(true)
  })
  it('面板值不在格点上：先对齐到相邻格点（25.3 → + 25.5 / − 25.0）；超出范围一步收回边界', () => {
    expect(stepTemp(25.3, 1, R)).toBe(25.5)
    expect(stepTemp(25.3, -1, R)).toBe(25)
    expect(stepTemp(32, -1, R)).toBe(30)
    expect(stepTemp(10, 1, R)).toBe(16)
    expect(canStep(32, 1, R)).toBe(false)
    expect(canStep(10, -1, R)).toBe(false)
  })
  it('连点 +：一路到 30 为止，全是 0.5 的格点', () => {
    let v = 16
    const seen: number[] = []
    for (let i = 0; i < 40; i++) { v = stepTemp(v, 1, R); seen.push(v) }
    expect(seen.at(-1)).toBe(30)
    expect(seen.every((x) => Number.isInteger(x * 2) && x >= 16 && x <= 30)).toBe(true)
  })
})

describe('不能设置的情况', () => {
  it('房间关闭：温度和节能不能设置（后端答复⑦）；开关仍可下发', () => {
    expect(editBlock(room({ on: false }), OK)).toMatch(/房间已关闭/)
    expect(switchBlock(room({ on: false }), OK)).toBeNull()
    expect(buildRoomSet(room({ on: false }), draft({ temp: 24 }), OK, R)).toMatchObject({ ok: false, reason: expect.stringMatching(/房间已关闭/) })
  })
  it('面板未连接、项目离线、最近一次读取失败：都不能设置，开关也不行', () => {
    expect(editBlock(room({ connected: false }), OK)).toMatch(/面板离线/)
    expect(editBlock(room(), { online: false, fresh: true })).toMatch(/项目离线/)
    expect(editBlock(room(), { online: true, fresh: false })).toMatch(/读取面板失败/)
    expect(switchBlock(room({ connected: false }), OK)).toMatch(/面板离线/)
    expect(buildRoomSwitch(room(), true, { online: true, fresh: false }).ok).toBe(false)
  })
  it('读不到末端（end_modes 为空 / 缺失）：设置和开关都不能下发，永远不传空列表', () => {
    const r = room({ wireEndModes: [] })
    expect(editBlock(r, OK)).toMatch(/末端/)
    expect(switchBlock(r, OK)).toMatch(/末端/)
    expect(buildRoomSet(r, draft({ temp: 24 }), OK, R)).toMatchObject({ ok: false, reason: expect.stringMatching(/末端/) })
    expect(buildRoomSwitch(r, false, OK)).toMatchObject({ ok: false, reason: expect.stringMatching(/末端/) })
  })
  it('没有改动、草稿是别的房间的、温度不合法：不给 Query', () => {
    expect(buildRoomSet(room(), draft({ temp: 25.5, eco: 0 }), OK, R)).toMatchObject({ ok: false, reason: '没有需要下发的修改' })
    expect(buildRoomSet(room(), draft({ key: 'other', temp: 24 }), OK, R).ok).toBe(false)
    expect(buildRoomSet(room(), null, OK, R).ok).toBe(false)
    for (const t of [30.5, 15.5, 24.3]) expect(buildRoomSet(room(), draft({ temp: t }), OK, R).ok).toBe(false)
  })
})

describe('节能模式下温度由系统设定', () => {
  it('面板是节能：温度不能改（步进被忽略），Query 也不给', () => {
    const r = room({ eco: 1 })
    expect(tempBlock(r, null)).toMatch(/节能模式下温度由系统设定/)
    expect(editDraft(r, null, { temp: 24 }).temp).toBeUndefined()
    expect(buildRoomSet(r, draft({ base: { setTemp: 25.5, eco: 1 }, temp: 24 }), OK, R).ok).toBe(false)
  })
  it('草稿开节能：去掉已改的温度，之后温度也不能改 → 同一次下发不会同时改温度和开节能', () => {
    const r = room()
    let d = editDraft(r, null, { temp: 24 })
    expect(d.temp).toBe(24)
    d = editDraft(r, d, { eco: 1 })
    expect(d.temp).toBeUndefined()
    expect(editDraft(r, d, { temp: 23 }).temp).toBeUndefined()
    expect(q(buildRoomSet(r, d, OK, R))).toMatchObject({ temperature: -1, eco: 1 })
    // 即使草稿里硬塞了温度，组装也拒绝
    expect(buildRoomSet(r, draft({ temp: 24, eco: 1 }), OK, R)).toMatchObject({ ok: false, reason: expect.stringMatching(/节能/) })
  })
  it('节能 → 标准：只发 eco=0，温度 -1（用面板回读值）', () => {
    const r = room({ eco: 1 })
    const d = editDraft(r, null, { eco: 0 })
    expect(q(buildRoomSet(r, d, OK, R))).toMatchObject({ temperature: -1, eco: 0 })
    expect(tempBlock(r, d)).toMatch(/节能/) // 面板还在节能，温度仍不能改
  })
})

describe('草稿生命周期（回读后整理）', () => {
  it('房间不在 / 关闭 / 面板离线 / 读取失败：清除', () => {
    const d = draft({ temp: 24 })
    expect(reconcileDraft(d, undefined, OK)).toMatchObject({ draft: null, cleared: 'gone' })
    expect(reconcileDraft(d, room({ on: false }), OK)).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, room({ connected: false }), OK)).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, room(), { online: true, fresh: false })).toMatchObject({ draft: null, cleared: 'blocked' })
  })
  it('回读值与草稿一致的项去掉，全一致则清除', () => {
    const d = draft({ temp: 24, eco: 1 })
    expect(reconcileDraft(d, room({ setTemp: 24 }), OK).draft).toEqual(draft({ eco: 1 }))
    expect(reconcileDraft(d, room({ setTemp: 24, eco: 1 }), OK)).toMatchObject({ draft: null, cleared: 'applied' })
  })
  it('编辑期间外部改了面板值（既不是原值也不是草稿值）：冲突，不能下发', () => {
    const d = draft({ temp: 24 })
    const r = room({ setTemp: 26 })
    expect(reconcileDraft(d, r, OK)).toMatchObject({ draft: d, conflict: ['temp'] })
    expect(buildRoomSet(r, d, OK, R)).toMatchObject({ ok: false, reason: expect.stringMatching(/外部变化/) })
    expect(reconcileDraft(draft({ eco: 1 }), room({ eco: 1, setTemp: 25.5 }), OK).cleared).toBe('applied')
  })
  it('没有变化时返回同一个草稿对象（不触发多余的状态更新）', () => {
    const d = draft({ temp: 24 })
    expect(reconcileDraft(d, room(), OK).draft).toBe(d)
  })
  it('新草稿记下开始编辑时的面板值作为基准', () => {
    expect(newDraft(room({ setTemp: 22, eco: 1 })).base).toEqual({ setTemp: 22, eco: 1 })
  })
})

describe('201 Query：只发改了的标量，其余 -1，end_modes 用这份读数原样传回', () => {
  it('只改温度', () => {
    const x = q(buildRoomSet(room(), draft({ temp: 24.5 }), OK, R))
    const want = { equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: ENDS }
    expect(x).toEqual(want)
    expect(wire(x)).toEqual(want)
  })
  it('只改节能（标准 → 节能、节能 → 标准；0 要真的发成 0，不是 -1）', () => {
    expect(q(buildRoomSet(room({ eco: 0 }), draft({ eco: 1 }), OK, R))).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: 1, switch: -1, endModes: ENDS })
    const off = q(buildRoomSet(room({ eco: 1 }), draft({ base: { setTemp: 25.5, eco: 1 }, eco: 0 }), OK, R))
    expect(wire(off)).toMatchObject({ temperature: -1, eco: 0, switch: -1, windSpeed: -1, humidity: -1 })
  })
  it('end_modes 用传入这份房间读数的（换一份读数就换），是拷贝不是同一个对象', () => {
    const fresh = [{ optionName: '地冷', type: 3, isSelected: true, isChange: true, switch: 1 }]
    const r = room({ wireEndModes: fresh })
    const x = q(buildRoomSet(r, draft({ temp: 24 }), OK, R))
    expect(x.endModes).toEqual(fresh)
    expect(x.endModes[0]).not.toBe(fresh[0])
  })
  it('风速、湿度永远不改：-1', () => {
    const x = q(buildRoomSet(room({ windSpeed: 100 }), draft({ temp: 20 }), OK, R))
    expect(x.windSpeed).toBe(-1)
    expect(x.humidity).toBe(-1)
  })
  it('房间开关：只有 switch 是真实值（关 = 0，不是缺省），末端原样传回', () => {
    expect(q(buildRoomSwitch(room(), false, OK))).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: 0, endModes: ENDS })
    expect(wire(q(buildRoomSwitch(room(), true, OK)))).toMatchObject({ switch: 1, temperature: -1, eco: -1, endModes: ENDS })
  })
})

describe('下发结果分类', () => {
  it('确定没生效才算失败（复用统一控制 outcomeOf）：写防护、本地参数、未登录、503 + code 14 → 未下发；success=false、网关无权限、后端参数错误 → 下发失败', () => {
    for (const e of [new ApiError('write_blocked', 'x'), new ApiError('bad_request', 'x'), new ApiError('unauthenticated', 'x', { status: 401 }), new ApiError('unavailable', 'x', { status: 503, code: 14 })]) {
      expect(classify(e)).toMatchObject({ outcome: 'fail', sent: false })
      expect(classify(e).text).toMatch(/^未下发：/)
    }
    for (const e of [new ApiError('ctrl', 'x'), new ApiError('forbidden', 'x', { status: 403 }), new ApiError('bad_request', 'x', { status: 400 })]) {
      expect(classify(e)).toMatchObject({ outcome: 'fail', sent: true })
      expect(classify(e).text).toMatch(/^下发失败：/)
    }
    expect(classify(new ApiError('write_blocked', '名单外')).text).toBe('未下发：名单外')
  })
  it('503 不带 code 14（网关纯文本 503、无 code、别的 code）：结果未知，不算失败（请求可能已到后端）', () => {
    for (const e of [new ApiError('unavailable', 'Service Unavailable', { status: 503 }), new ApiError('unavailable', 'x', { status: 503, code: 2 }), new ApiError('unavailable', 'x')]) {
      expect(classify(e)).toMatchObject({ outcome: 'unknown', sent: true })
    }
  })
  it('超时、断网、500、回复无法解析、中止、未知异常：结果未知（不说下发失败）', () => {
    for (const k of ['timeout', 'network', 'server', 'aborted'] as const) expect(classify(new ApiError(k, 'x')).outcome).toBe('unknown')
    expect(classify(new Error('boom')).outcome).toBe('unknown')
    expect(classify(new ApiError('server', '控制屏回复无法解析')).text).not.toContain('下发失败')
  })
})

describe('文案', () => {
  it('待下发与成功提示', () => {
    const c = draftChanges(room(), draft({ temp: 24.5 }))
    expect(describeChanges(c)).toBe('设定温度 25.5 → 24.5°C')
    expect(describeResult(draftChanges(room(), draft({ eco: 1 })))).toBe('节能模式 开')
  })
})
