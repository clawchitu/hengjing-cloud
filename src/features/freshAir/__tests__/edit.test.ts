// S10c 新风运行设置的编辑规则与 204 组装（纯函数）。
import { describe, expect, it } from 'vitest'
import { decodeReply, encodeMessage, explicitFieldsOf } from '@/api/ctrl'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { BLOCK_204_CONTROL_TYPE, BLOCK_204_NO_READING, BLOCK_204_NOT_SETTABLE } from '@/api/writeLockVerify'
import {
  build204, describeChanges, draftChanges, editBlock, editDraft, newDraft, panelBlock, reconcileDraft, sameRaw210, sameSettings, stepSetpoint,
  TEXT_CONFLICT, TEXT_CT_LOCKED, TEXT_DEVICE_OFF, TEXT_DEW_INACTIVE, TEXT_DISCONNECTED, TEXT_HUM_INACTIVE, TEXT_NO_CHANGES, TEXT_OFFLINE, TEXT_STALE, TEXT_WRITE_OFF,
  type FaCtx,
} from '../edit'
import { toSettingsView, type Raw210 } from '../model'
import { ID_260911001, R210_260911001 } from './fixtures'

const ID = 1514027092
const CTX: FaCtx = { online: true, fresh: true, connected: true, writable: null }
const raw = (o: Partial<Raw210> = {}): Raw210 => ({ id: ID, name: 'TXFS500', controlType: 0, dewPoint: 13, humiditySet: 55, windSpeed: 2, switch: 1, canChange: true, ...o })
const view = (o: Partial<Raw210> = {}) => toSettingsView(raw(o), ID)
/** 所有字段 -1，只有 over 里的字段是真实值 */
const minus1 = (over: object) => ({ id: ID, name: 'TXFS500', controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: -1, switch: -1, ...over })

describe('panelBlock / editBlock', () => {
  it('面板整体只读：功能开关 / 权限、项目离线、读取失败、设备未连接', () => {
    expect(panelBlock({ ...CTX, writable: TEXT_WRITE_OFF })).toBe(TEXT_WRITE_OFF)
    expect(panelBlock({ ...CTX, online: false })).toBe(TEXT_OFFLINE)
    expect(panelBlock({ ...CTX, fresh: false })).toBe(TEXT_STALE)
    expect(panelBlock({ ...CTX, connected: false })).toBe(TEXT_DISCONNECTED)
    expect(panelBlock(CTX)).toBeNull()
  })

  it('control_type = -1：只禁用控制类型、露点、湿度；风速、开关照常可设', () => {
    const s = view({ controlType: -1, dewPoint: -1, humiditySet: -1 })
    expect(editBlock(s, null, 'controlType', CTX)).toBe(BLOCK_204_NOT_SETTABLE)
    expect(editBlock(s, null, 'dewPoint', CTX)).toBe(BLOCK_204_CONTROL_TYPE)
    expect(editBlock(s, null, 'humiditySet', CTX)).toBe(BLOCK_204_CONTROL_TYPE)
    expect(editBlock(s, null, 'windSpeed', CTX)).toBeNull()
    expect(editBlock(s, null, 'switch', CTX)).toBeNull()
  })

  it('某项读到 -1：只禁用那一项', () => {
    const s = view({ humiditySet: -1 })
    expect(editBlock(s, null, 'humiditySet', CTX)).toBe(BLOCK_204_NOT_SETTABLE)
    for (const f of ['controlType', 'windSpeed', 'switch'] as const) expect(editBlock(s, null, f, CTX)).toBeNull()
  })

  it('露点 / 湿度二选一（按草稿优先的控制类型）；can_change = false 时控制类型不可切换', () => {
    const s = view()
    expect(editBlock(s, null, 'dewPoint', CTX)).toBe(TEXT_DEW_INACTIVE)
    expect(editBlock(s, null, 'humiditySet', CTX)).toBeNull()
    const d = editDraft(s, null, 'controlType', 1, CTX)
    expect(editBlock(s, d, 'dewPoint', CTX)).toBeNull()
    expect(editBlock(s, d, 'humiditySet', CTX)).toBe(TEXT_HUM_INACTIVE)
    expect(editBlock(view({ canChange: false }), null, 'controlType', CTX)).toBe(TEXT_CT_LOCKED)
  })

  it('设备关着：只能改开关；草稿里开机后其他项可改；开关读数不可设置时不按关处理', () => {
    const s = view({ switch: 0 })
    expect(editBlock(s, null, 'windSpeed', CTX)).toBe(TEXT_DEVICE_OFF)
    expect(editBlock(s, null, 'switch', CTX)).toBeNull()
    const on = editDraft(s, null, 'switch', 1, CTX)
    expect(editBlock(s, on, 'windSpeed', CTX)).toBeNull()
    expect(editBlock(view({ switch: -1 }), null, 'windSpeed', CTX)).toBeNull()
  })
})

describe('editDraft / draftChanges / reconcileDraft', () => {
  it('改回读数值等于没改；切换控制类型去掉不再生效的设定值；关机去掉其他改动', () => {
    const s = view()
    let d = editDraft(s, null, 'windSpeed', 1, CTX)
    expect(draftChanges(s, d)).toEqual([['windSpeed', 2, 1]])
    d = editDraft(s, d, 'windSpeed', 2, CTX)
    expect(draftChanges(s, d)).toEqual([])
    d = editDraft(s, d, 'humiditySet', 56, CTX)
    d = editDraft(s, d, 'controlType', 1, CTX)
    expect(d.values).toEqual({ controlType: 1 })
    d = editDraft(s, d, 'windSpeed', 0, CTX)
    d = editDraft(s, d, 'switch', 0, CTX)
    expect(d.values).toEqual({ switch: 0 })
  })

  it('不能改的项不进草稿', () => {
    const s = view({ controlType: -1, dewPoint: -1, humiditySet: -1 })
    expect(editDraft(s, null, 'controlType', 1, CTX).values).toEqual({})
    expect(editDraft(s, null, 'humiditySet', 50, CTX).values).toEqual({})
  })

  it('回读后：已等于草稿 → 清除（applied）；外部改了基准 → 冲突；改动项变得不能设置 → 清除（blocked）；换了设备 → gone', () => {
    const s = view()
    const d = editDraft(s, null, 'windSpeed', 1, CTX)
    expect(reconcileDraft(d, view({ windSpeed: 1 }), CTX)).toMatchObject({ draft: null, cleared: 'applied' })
    expect(reconcileDraft(d, view({ windSpeed: 0 }), CTX).conflict).toEqual(['windSpeed'])
    expect(reconcileDraft(d, view({ windSpeed: -1 }), CTX)).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, view(), { ...CTX, connected: false })).toMatchObject({ draft: null, cleared: 'blocked' })
    expect(reconcileDraft(d, toSettingsView({ ...raw(), id: 7 }, 7), CTX)).toMatchObject({ draft: null, cleared: 'gone' })
    expect(reconcileDraft(d, s, CTX).draft).toBe(d)
  })

  it('设定值步进：露点 0.5、湿度 1，范围内；不在格点上先对齐', () => {
    expect(stepSetpoint('dewPoint', 13, 1)).toBe(13.5)
    expect(stepSetpoint('dewPoint', 13.2, -1)).toBe(13)
    expect(stepSetpoint('dewPoint', 16, 1)).toBe(16)
    expect(stepSetpoint('humiditySet', 55, 1)).toBe(56)
    expect(stepSetpoint('humiditySet', 35, -1)).toBe(35)
  })
})

describe('build204（唯一的组装点）', () => {
  const enc = (q: object) => decodeReply(pb.RunningCtrlSetQuerySchema, encodeMessage(pb.RunningCtrlSetQuerySchema, q))

  it('只放改了的字段，其余 -1；id、name 取读数；登记的明确字段只有 id、name 和改动', () => {
    const s = view()
    const r = build204(s, raw(), editDraft(s, null, 'windSpeed', 1, CTX), CTX)
    expect(r).toMatchObject({ ok: true, changed: ['windSpeed'] })
    if (!r.ok) return
    expect(r.query).toEqual(minus1({ windSpeed: 1 }))
    expect([...explicitFieldsOf(r.query)].sort()).toEqual(['id', 'name', 'windSpeed'])
    expect(enc(r.query)).toEqual(minus1({ windSpeed: 1 }))
  })

  it('明确的 0 能发：风速低、关机、湿度控制', () => {
    for (const [f, base, v] of [['windSpeed', { windSpeed: 1 }, 0], ['switch', {}, 0], ['controlType', { controlType: 1 }, 0]] as const) {
      const s = view(base)
      const r = build204(s, raw(base), editDraft(s, null, f, v, CTX), CTX)
      expect(r.ok && r.query).toEqual(minus1({ [f]: 0 }))
      expect(r.ok && explicitFieldsOf(r.query).has(f)).toBe(true)
    }
  })

  it('11/25 实测读数（humidity_set = -1）：只改风速能发，湿度仍 -1', () => {
    const r0 = decodeReply(pb.RunningCtrlGetReplySchema, R210_260911001) as Raw210
    const s = toSettingsView(r0, ID_260911001)
    // 实测 switch 缺省 0（关）：先开机
    const d = editDraft(s, editDraft(s, null, 'switch', 1, CTX), 'windSpeed', 1, CTX)
    const r = build204(s, r0, d, CTX)
    expect(r.ok && r.query).toEqual({ id: ID_260911001, name: 'TXFS500', controlType: -1, dewPoint: -1, humiditySet: -1, windSpeed: 1, switch: 1 })
  })

  it('不给 Query：只读、没有改动、冲突、读数为空或 id 不符（blocked204 兜底）', () => {
    const s = view()
    const d = editDraft(s, null, 'windSpeed', 1, CTX)
    expect(build204(s, raw(), d, { ...CTX, writable: TEXT_WRITE_OFF })).toEqual({ ok: false, reason: TEXT_WRITE_OFF })
    expect(build204(s, raw(), null, CTX)).toEqual({ ok: false, reason: TEXT_NO_CHANGES })
    expect(build204(view({ windSpeed: 0 }), raw({ windSpeed: 0 }), d, CTX)).toEqual({ ok: false, reason: TEXT_CONFLICT })
    expect(build204(s, null, d, CTX)).toEqual({ ok: false, reason: BLOCK_204_NO_READING })
    expect(build204(s, raw({ id: 7 }), d, CTX)).toEqual({ ok: false, reason: BLOCK_204_NO_READING })
  })

  it('设定值不在范围 / 步长上不给 Query', () => {
    const s = view()
    const d = { ...newDraft(s), values: { humiditySet: 80 } }
    expect(build204(s, raw(), d, CTX)).toMatchObject({ ok: false })
    expect(build204(s, raw(), { ...d, values: { humiditySet: 55.5 } }, CTX)).toMatchObject({ ok: false })
  })

  it('sameRaw210：全部原始字段严格比较（不折叠、不取整，无效值按原值，缺省按 proto3 默认值）', () => {
    expect(sameRaw210(raw(), raw())).toBe(true)
    expect(sameRaw210({ id: ID }, { id: ID, name: '', controlType: 0, dewPoint: 0, canChange: false })).toBe(true)
    for (const o of [{ dewPoint: 14 }, { dewPoint: 13.004 }, { name: 'X' }, { canChange: false }, { switch: 0 }, { id: 7 }]) expect(sameRaw210(raw(), raw(o))).toBe(false)
    expect(sameRaw210(raw({ controlType: -1, dewPoint: 13 }), raw({ controlType: -1, dewPoint: 14 }))).toBe(false)
    expect(sameRaw210(raw({ humiditySet: 65536 }), raw({ humiditySet: -100 }))).toBe(false)
    expect(sameRaw210(raw(), null)).toBe(false)
  })

  it('sameSettings 比对整份读数；describeChanges 文案', () => {
    expect(sameSettings(view(), view())).toBe(true)
    expect(sameSettings(view(), view({ dewPoint: 14 }))).toBe(false)
    expect(sameSettings(view(), view({ canChange: false }))).toBe(false)
    const s = view()
    expect(describeChanges(draftChanges(s, editDraft(s, null, 'windSpeed', 1, CTX)))).toBe('风速 自动 → 高')
    expect(describeChanges([['dewPoint', 13, 13.5], ['humiditySet', 55, 56], ['switch', 1, 0], ['controlType', 0, 1]])).toBe('露点设定 13.0 °C → 13.5 °C，湿度设定 55 %RH → 56 %RH，开关 开 → 关，控制类型 湿度控制 → 露点控制')
  })
})
