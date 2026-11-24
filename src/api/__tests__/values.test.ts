import { describe, expect, it } from 'vitest'
import { display, hasChanges, hourlyReading, NO_DATA, reading, setting, UNCHANGED, withUnchanged } from '../values'

describe('-1 不变项', () => {
  it('没给的字段一律 -1', () => {
    expect(withUnchanged(['temperature', 'humidity', 'windSpeed', 'eco', 'switch'] as const, { temperature: 26 }))
      .toEqual({ temperature: 26, humidity: -1, windSpeed: -1, eco: -1, switch: -1 })
  })
  it('0 是有效值（关闭 / 标准），显式 undefined 视为不变', () => {
    expect(withUnchanged(['eco', 'switch'] as const, { eco: 0, switch: undefined })).toEqual({ eco: 0, switch: UNCHANGED })
  })
  it('全是 -1 的请求不算有改动', () => {
    expect(hasChanges(withUnchanged(['a', 'b'] as const, {}))).toBe(false)
    expect(hasChanges(withUnchanged(['a', 'b'] as const, { b: 1 }))).toBe(true)
  })
})

describe('65536 无数据', () => {
  it.each([[NO_DATA, null], [65535, 65535], [0, 0], [-100, -100], [NaN, null], [undefined, null], [null, null], [22.5, 22.5]])('reading(%s) = %s', (v, out) => {
    expect(reading(v)).toBe(out)
  })
  it('小时值额外排除 -100', () => {
    expect(hourlyReading(-100)).toBeNull()
    expect(hourlyReading(NO_DATA)).toBeNull()
    expect(hourlyReading(-5)).toBe(-5)
  })
  it('设定值 -1 → null，显示 --', () => {
    expect(setting(-1)).toBeNull()
    expect(display(setting(-1))).toBe('--')
    expect(display(setting(13.25), 1)).toBe('13.3')
  })
})
