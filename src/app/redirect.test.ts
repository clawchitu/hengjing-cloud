import { describe, expect, it } from 'vitest'
import { safeFrom } from './redirect'

describe('登录后回跳路径', () => {
  it('站内路径原样返回（含查询串）', () => {
    expect(safeFrom('/sensors')).toBe('/sensors')
    expect(safeFrom('/groups?d=DLR-002')).toBe('/groups?d=DLR-002')
  })
  it('登录页、外站、非字符串 → null（回首页）', () => {
    for (const v of ['/login', '/login?x=1', '//evil.com/x', '/\\evil.com', 'https://evil.com', 'sensors', '', undefined, null, 1]) expect(safeFrom(v)).toBeNull()
  })
})
