import { describe, expect, it } from 'vitest'
import { afterLogin, safeFrom } from './redirect'

describe('登录后回跳路径', () => {
  it('站内路径原样返回（含查询串）', () => {
    expect(safeFrom('/sensors')).toBe('/sensors')
    expect(safeFrom('/groups?d=DLR-002')).toBe('/groups?d=DLR-002')
  })
  it('登录页、外站、非字符串 → null（回首页）', () => {
    for (const v of ['/login', '/login?x=1', '//evil.com/x', '/\\evil.com', 'https://evil.com', 'sensors', '', undefined, null, 1]) expect(safeFrom(v)).toBeNull()
  })
})

describe('换账号登录不回上一个账号的页面（S13 走查 P7）', () => {
  it('原路径是别的账号留下的 → 首页；同一个账号 → 原路径；没记账号 → 原路径；原路径不安全 → 首页', () => {
    expect(afterLogin({ from: '/thermostat', fromUser: 'user:A' }, 'user:B')).toBe('/home')
    expect(afterLogin({ from: '/thermostat', fromUser: 'user:A' }, 'user:A')).toBe('/thermostat')
    expect(afterLogin({ from: '/sensors', fromUser: null }, 'user:B')).toBe('/sensors')
    expect(afterLogin({ from: '//evil.com', fromUser: 'user:A' }, 'user:A')).toBe('/home')
    expect(afterLogin(undefined, 'user:A')).toBe('/home')
  })
})
