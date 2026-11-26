// 202 滤网字段：filter_life 是天数，filter_life_p 是 0–1 的比例（后端 11/25 答复第 10 条）。
import { describe, expect, it } from 'vitest'
import { filterOf, hoursText } from '../filter'

describe('filterOf', () => {
  it('11/25 实测 filter_life = 100、filter_life_p = 1：100 天、100%（新风机一直关机，滤网没有消耗）', () => {
    expect(filterOf({ filterLife: 100, filterLifeP: 1 })).toEqual({ days: 100, ratio: 1, percent: 100, level: 'ok' })
  })
  it('比例乘 100 显示；告警阈值按比例：< 0.15 红，< 0.5 橙', () => {
    expect(filterOf({ filterLifeP: 0.72 })).toMatchObject({ percent: 72, level: 'ok' })
    expect(filterOf({ filterLifeP: 0.5 }).level).toBe('ok')
    expect(filterOf({ filterLifeP: 0.45 })).toMatchObject({ percent: 45, level: 'orange' })
    expect(filterOf({ filterLifeP: 0.08 })).toMatchObject({ percent: 8, level: 'red' })
  })
  it('0 是有效读数；65536、-100、超出 0–1、缺失按无数据', () => {
    expect(filterOf({ filterLife: 0, filterLifeP: 0 })).toEqual({ days: 0, ratio: 0, percent: 0, level: 'red' })
    for (const p of [65536, -100, 1.5, 100, -0.1, NaN, undefined]) expect(filterOf({ filterLifeP: p })).toMatchObject({ ratio: null, percent: null, level: null })
    expect(filterOf({ filterLife: 65536 }).days).toBeNull()
    expect(filterOf({ filterLife: -5 }).days).toBeNull()
  })
})

describe('hoursText', () => {
  it('加千分位和单位；0 是有效读数', () => {
    expect(hoursText(1234)).toBe('1,234 小时')
    expect(hoursText(36)).toBe('36 小时')
    expect(hoursText(0)).toBe('0 小时')
    expect(hoursText(1234567)).toBe('1,234,567 小时')
  })
  it('-1、缺失、非有限数显示「—」', () => {
    for (const v of [-1, null, undefined, NaN, Infinity]) expect(hoursText(v)).toBe('—')
  })
})
