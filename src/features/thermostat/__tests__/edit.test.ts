// 温度边界与步长、不能设置的情况、节能锁温度、草稿生命周期、201 Query 组装
// （只发改了的标量、不改的 -1、end_modes 没改传空列表 / 改了完整回传、读不到末端照常下发）、房间开关未上报、下发结果分类。
import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage } from '@/api/ctrl'
import { ApiError } from '@/api/errors'
import * as pb from '@/api/gen/ctrl200_pb.js'
import {
  buildRoomSet, buildRoomSwitch, canStep, endBlock, sameEnds, sameQuery, shownEnds, toggleEnd, describeChanges, describeResult, draftChanges, editBlock, editDraft, endModesFor, newDraft, reconcileDraft, STALE_TEXT,
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
  on: true, switchKnown: true, mode: '制冷', endModes: [], wireEndModes: ENDS, connected: true, ...o,
})
const draft = (o: Partial<RoomDraft> = {}): RoomDraft => ({ key: '406658286', base: { setTemp: 25.5, eco: 0, ends: [true, true] }, ...o })
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
    expect(editBlock(room(), { online: true, fresh: false })).toBe(STALE_TEXT)
    expect(switchBlock(room({ connected: false }), OK)).toMatch(/面板离线/)
    expect(buildRoomSwitch(room(), true, { online: true, fresh: false }).ok).toBe(false)
  })
  it('读不到末端（end_modes 为空 / 缺失）：照常能设置、能开关，末端传空列表（后端 11/25 答复第 3 条）', () => {
    const r = room({ wireEndModes: [] })
    expect(editBlock(r, OK)).toBeNull()
    expect(switchBlock(r, OK)).toBeNull()
    expect(q(buildRoomSet(r, draft({ temp: 24 }), OK, R)).endModes).toEqual([])
    expect(q(buildRoomSwitch(r, false, OK)).endModes).toEqual([])
  })
  it('房间开关未上报（switchKnown = false）：读到 0 也不当作关着，温度、节能照常能改', () => {
    const r = room({ on: false, switchKnown: false })
    expect(editBlock(r, OK)).toBeNull()
    expect(q(buildRoomSet(r, draft({ temp: 24 }), OK, R))).toMatchObject({ temperature: 24, switch: -1, endModes: [] })
    expect(reconcileDraft(draft({ temp: 24 }), r, OK).draft).not.toBeNull()
    // 其他前提照旧
    expect(editBlock({ ...r, connected: false }, OK)).toMatch(/面板离线/)
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
  it('房间不在 / 关闭 / 面板离线 / 项目离线：清除', () => {
    const d = draft({ temp: 24 })
    expect(reconcileDraft(d, undefined, OK)).toMatchObject({ draft: null, cleared: 'gone' })
    expect(reconcileDraft(d, room({ on: false }), OK)).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, room({ connected: false }), OK)).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, room(), { online: false, fresh: true })).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, room(), { online: false, fresh: false })).toMatchObject({ draft: null, cleared: 'blocked' })
  })
  it('最近一次读取失败（暂时没有新鲜读数）：草稿保留，只是不能下发；真正不能设置的照旧清除', () => {
    const d = draft({ temp: 24 })
    const stale = { online: true, fresh: false }
    expect(reconcileDraft(d, room(), stale)).toEqual({ draft: d, conflict: [] })
    expect(buildRoomSet(room(), d, stale, R)).toEqual({ ok: false, reason: STALE_TEXT })
    expect(reconcileDraft(d, room({ connected: false }), stale)).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, room({ on: false }), stale)).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, room(), OK)).toEqual({ draft: d, conflict: [] }) // 恢复后照常整理、可下发
    expect(buildRoomSet(room(), d, OK, R).ok).toBe(true)
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
    expect(newDraft(room({ setTemp: 22, eco: 1 })).base).toEqual({ setTemp: 22, eco: 1, ends: [true, true] })
  })
})

describe('201 Query：只发改了的标量，其余 -1；end_modes 没改传空列表，改了完整回传', () => {
  it('只改温度：末端没改，传空列表（不再原样回传读到的末端）', () => {
    const x = q(buildRoomSet(room(), draft({ temp: 24.5 }), OK, R))
    const want = { equipmentId: 406658286, temperature: 24.5, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: [] }
    expect(x).toEqual(want)
    expect(wire(x)).toEqual(want)
  })
  it('只改节能（标准 → 节能、节能 → 标准；0 要真的发成 0，不是 -1）', () => {
    expect(q(buildRoomSet(room({ eco: 0 }), draft({ eco: 1 }), OK, R))).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: 1, switch: -1, endModes: [] })
    const off = q(buildRoomSet(room({ eco: 1 }), draft({ base: { setTemp: 25.5, eco: 1 }, eco: 0 }), OK, R))
    expect(wire(off)).toMatchObject({ temperature: -1, eco: 0, switch: -1, windSpeed: -1, humidity: -1 })
  })
  it('改了末端：该房间全部末端完整回传（有 3 个传 3 个），只换 is_selected；switch 只读，原样带回读到的值', () => {
    const three = [...ENDS, { optionName: '地冷', type: 3, isSelected: false, isChange: true, switch: 0 }]
    const r = room({ wireEndModes: three })
    const d = editDraft(r, null, { temp: 24, ends: [true, false, true] })
    const x = q(buildRoomSet(r, d, OK, R))
    expect(x.endModes).toEqual([
      { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
      { optionName: '顶辐射', type: 1, isSelected: false, isChange: true, switch: 0 },
      { optionName: '地冷', type: 3, isSelected: true, isChange: true, switch: 0 },
    ])
    expect(x).toMatchObject({ temperature: 24, eco: -1, switch: -1 })
    expect(x.endModes[0]).not.toBe(three[0])
    expect((wire(x) as { endModes: unknown[] }).endModes).toHaveLength(3)
    expect(describeChanges(draftChanges(r, d))).toContain('末端选中 2 项 → 2 项')
    expect(describeChanges(draftChanges(r, d), ['风盘', '顶辐射', '地冷'])).toContain('参与运行的末端 风盘、顶辐射 → 风盘、地冷')
    // 只改末端：也走 201，标量全部 -1，末端完整回传
    expect(q(buildRoomSet(r, editDraft(r, null, { ends: [true, false, true] }), OK, R))).toMatchObject({ temperature: -1, eco: -1, switch: -1, humidity: -1, windSpeed: -1, endModes: [{ isSelected: true }, { isSelected: false }, { isSelected: true }] })
  })
  it('末端选择与读数相同算没改：空列表；末端和温度一起改：两样都带', () => {
    expect(endModesFor(room(), [true, true])).toEqual({ ok: true, endModes: [] })
    expect(endModesFor(room(), undefined)).toEqual({ ok: true, endModes: [] })
    const x = q(buildRoomSet(room(), draft({ temp: 24, ends: [true, false] }), OK, R))
    expect(x).toMatchObject({ temperature: 24, endModes: [{ isSelected: true, switch: 1 }, { isSelected: false, switch: 0 }] })
  })
  it('末端不合法：一个都没选、取消了不允许关闭的末端（is_change = false）、数量和读数对不上 → 不下发', () => {
    expect(endModesFor(room(), [false, false])).toMatchObject({ ok: false, reason: expect.stringMatching(/至少/) })
    const fixed = room({ wireEndModes: [{ optionName: '全空气', type: 4, isSelected: true, isChange: false, switch: 1 }, ENDS[0]] })
    expect(endModesFor(fixed, [false, true])).toMatchObject({ ok: false, reason: '「全空气」不可取消' })
    const fixedOff = room({ wireEndModes: [{ optionName: '全空气', type: 4, isSelected: false, isChange: false, switch: 0 }, ENDS[0]] })
    expect(endModesFor(fixedOff, [true, true])).toMatchObject({ ok: false, reason: expect.stringMatching(/不允许修改/) })
    expect(endModesFor(room(), [true])).toMatchObject({ ok: false })
    expect(buildRoomSet(room(), draft({ temp: 24, ends: [false, false] }), OK, R)).toMatchObject({ ok: false, reason: expect.stringMatching(/至少/) })
  })
  it('改了末端后读数里的末端选择被外部改了：冲突，不下发', () => {
    const d = editDraft(room(), null, { temp: 24, ends: [true, false] })
    const r = room({ wireEndModes: [{ ...ENDS[0], isSelected: false }, ENDS[1]] })
    expect(reconcileDraft(d, r, OK).conflict).toEqual(['ends'])
    expect(buildRoomSet(r, d, OK, R).ok).toBe(false)
  })
  it('风速、湿度永远不改：-1', () => {
    const x = q(buildRoomSet(room({ windSpeed: 100 }), draft({ temp: 20 }), OK, R))
    expect(x.windSpeed).toBe(-1)
    expect(x.humidity).toBe(-1)
  })
  it('房间开关：只有 switch 是真实值（关 = 0，不是缺省），末端不改（空列表）', () => {
    expect(q(buildRoomSwitch(room(), false, OK))).toEqual({ equipmentId: 406658286, temperature: -1, humidity: -1, windSpeed: -1, eco: -1, switch: 0, endModes: [] })
    expect(wire(q(buildRoomSwitch(room(), true, OK)))).toMatchObject({ switch: 1, temperature: -1, eco: -1, endModes: [] })
    // 开关未上报时也能开 / 关
    expect(q(buildRoomSwitch(room({ switchKnown: false }), true, OK)).switch).toBe(1)
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

describe('末端选择（点标签）', () => {
  const E = [
    { optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 },
    { optionName: '顶辐射', type: 1, isSelected: false, isChange: true, switch: 0 },
  ]
  const AIR = { optionName: '全空气', type: 4, isSelected: true, isChange: false, switch: 1 }
  it('toggleEnd：在草稿当前选择上切换；房间关着也可以改；面板离线 / 读数过期不行', () => {
    const r = room({ wireEndModes: E })
    expect(toggleEnd(r, null, 1, OK)).toEqual({ ok: true, ends: [true, true] })
    const d = editDraft(r, null, { ends: [true, true] })
    expect(toggleEnd(r, d, 0, OK)).toEqual({ ok: true, ends: [false, true] })
    expect(shownEnds(r, d)).toEqual([true, true])
    const off = room({ wireEndModes: E, on: false, switchKnown: true })
    expect(endBlock(off, OK)).toBeNull()
    expect(toggleEnd(off, null, 1, OK).ok).toBe(true)
    expect(toggleEnd(room({ wireEndModes: E, connected: false }), null, 1, OK)).toMatchObject({ ok: false })
    expect(toggleEnd(r, null, 1, { online: true, fresh: false })).toMatchObject({ ok: false, reason: STALE_TEXT })
  })
  it('is_change = false：已选中的「不可取消」、未选中的「不允许修改」，toggleEnd 和 endModesFor（预检兜底）都拒绝', () => {
    const r = room({ wireEndModes: [AIR, ...E] })
    expect(toggleEnd(r, null, 0, OK)).toEqual({ ok: false, reason: '「全空气」不可取消' })
    expect(endModesFor(r, [false, true, false])).toEqual({ ok: false, reason: '「全空气」不可取消' })
    expect(buildRoomSet(r, editDraft(r, null, { ends: [false, true, false] }), OK, R)).toEqual({ ok: false, reason: '「全空气」不可取消' })
    const r2 = room({ wireEndModes: [{ ...AIR, isSelected: false }, ...E] })
    expect(toggleEnd(r2, null, 0, OK)).toEqual({ ok: false, reason: '「全空气」不允许修改' })
    // 名称为空时按 type 显示（4 = 全空气）
    expect(toggleEnd(room({ wireEndModes: [{ ...AIR, optionName: '' }, ...E] }), null, 0, OK)).toEqual({ ok: false, reason: '「全空气」不可取消' })
  })
  it('只改末端：房间关着也能组装 201（标量全 -1），草稿不因房间关着被清；全不选 → 「至少选择一个末端」', () => {
    const off = room({ wireEndModes: E, on: false, switchKnown: true })
    const d = editDraft(off, null, { ends: [true, true] })
    expect(q(buildRoomSet(off, d, OK, R))).toMatchObject({ temperature: -1, eco: -1, switch: -1, endModes: [{ isSelected: true }, { isSelected: true }] })
    expect(reconcileDraft(d, off, OK).draft).toBe(d)
    expect(buildRoomSet(off, editDraft(off, d, { temp: 24 }), OK, R).ok).toBe(false)
    expect(buildRoomSet(off, editDraft(off, null, { ends: [false, false] }), OK, R)).toEqual({ ok: false, reason: '至少选择一个末端' })
  })
  it('温度已被面板追平、房间关着：剩下的末端照常做冲突检查，外部改了末端就不下发', () => {
    const E3 = (s: boolean[]) => ['风盘', '顶辐射', '地冷'].map((n, i) => ({ optionName: n, type: [0, 1, 3][i], isSelected: s[i], isChange: true, switch: 0 }))
    // 编辑时：温度 25.5、末端 [T,F,F]；草稿：温度 26、选中顶辐射。之后外部把温度设成 26、选中地冷、关房间
    const off = room({ on: false, switchKnown: true, setTemp: 26, wireEndModes: E3([true, false, true]) })
    const d = draft({ base: { setTemp: 25.5, eco: 0, ends: [true, false, false] }, temp: 26, ends: [true, true, false] })
    expect(reconcileDraft(d, off, OK)).toMatchObject({ conflict: ['ends'] })
    expect(buildRoomSet(off, d, OK, R)).toEqual({ ok: false, reason: '面板设定值已在外部变化，请重新核对' })
    // 末端没被外部改：只剩末端改动，房间关着照样可以发
    const off2 = room({ on: false, switchKnown: true, setTemp: 26, wireEndModes: E3([true, false, false]) })
    expect(q(buildRoomSet(off2, d, OK, R))).toMatchObject({ temperature: -1, endModes: [{ isSelected: true }, { isSelected: true }, { isSelected: false }] })
  })
  it('sameEnds：个数、顺序、名称、类型、is_change、is_selected 都要一致，switch 不比；sameQuery 同样不比末端 switch', () => {
    expect(sameEnds(E, E.map((m) => ({ ...m, switch: 0 })))).toBe(true)
    expect(sameEnds(E, [E[1], E[0]])).toBe(false)
    expect(sameEnds(E, [E[0]])).toBe(false)
    expect(sameEnds(E, [E[0], { ...E[1], optionName: '顶辐射2' }])).toBe(false)
    expect(sameEnds(E, [E[0], { ...E[1], isSelected: true }])).toBe(false)
    expect(sameEnds(E, [E[0], { ...E[1], isChange: false }])).toBe(false)
    const a = q(buildRoomSet(room({ wireEndModes: E }), editDraft(room({ wireEndModes: E }), null, { ends: [true, true] }), OK, R))
    expect(sameQuery(a, { ...a, endModes: a.endModes.map((m) => ({ ...m, switch: 1 - m.switch })) })).toBe(true)
    expect(sameQuery(a, { ...a, endModes: a.endModes.map((m, i) => (i === 0 ? { ...m, isSelected: false } : m)) })).toBe(false)
  })
})
