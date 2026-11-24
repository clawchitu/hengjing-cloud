import { describe, expect, it } from 'vitest'
import { NO_DEALER, dealerPickModel } from './dealerPick'

describe('dealerPickModel', () => {
  it('经销商列表为空、dealerId 为空时不产生空字符串选项（Radix Select 遇到会抛错）', () => {
    const m = dealerPickModel([], '')
    expect(m.value).toBe(NO_DEALER)
    expect(m.items).toEqual([{ value: NO_DEALER, label: '未找到匹配的经销商', disabled: true }])
    expect(m.items.every((i) => i.value !== '')).toBe(true)
  })

  it('搜索无命中时保留当前经销商作为禁用占位项', () => {
    const m = dealerPickModel([], 'DLR-002')
    expect(m).toEqual({ value: 'DLR-002', items: [{ value: 'DLR-002', label: '未找到匹配的经销商', disabled: true }] })
  })

  it('有命中时逐个列出', () => {
    const m = dealerPickModel([{ id: 'DLR-001', name: '甲' }, { id: 'DLR-003', name: '丙' }], 'DLR-003')
    expect(m.value).toBe('DLR-003')
    expect(m.items.map((i) => i.value)).toEqual(['DLR-001', 'DLR-003'])
  })
})
