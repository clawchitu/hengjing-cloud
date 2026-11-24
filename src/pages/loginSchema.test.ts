import { describe, expect, it } from 'vitest'
import { loginDefaults, loginSchema } from './loginSchema'

const msgs = (v: unknown) => {
  const r = loginSchema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}:${i.message}`)
}

describe('登录表单校验', () => {
  it('默认值：空用户名、空密码，记住我默认勾选', () => {
    expect(loginDefaults).toEqual({ account: '', password: '', remember: true })
    expect(msgs(loginDefaults)).toEqual(['account:请输入用户名', 'password:请输入密码'])
  })
  it('用户名去掉首尾空白后为空也不通过', () => {
    expect(msgs({ account: '   ', password: 'x', remember: false })).toEqual(['account:请输入用户名'])
  })
  it('用户名去掉首尾空白；平台账号不是手机号也可以', () => {
    const r = loginSchema.parse({ account: '  cosyhome ', password: ' p ', remember: false })
    expect(r).toEqual({ account: 'cosyhome', password: ' p ', remember: false })
  })
  it('超长拒绝', () => {
    expect(msgs({ account: 'a'.repeat(65), password: 'x', remember: true })).toEqual(['account:用户名过长'])
    expect(msgs({ account: 'a', password: 'x'.repeat(129), remember: true })).toEqual(['password:密码过长'])
  })
  it('remember 必须是布尔值', () => {
    expect(msgs({ account: 'a', password: 'x', remember: 'yes' })).toHaveLength(1)
  })
})
