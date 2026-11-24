import { describe, expect, it } from 'vitest'
import { ApiError, errorFromResponse, errorFromThrown, isRetryable, redact } from '../errors'
import { clearTokens, writeTokens } from '../tokens'

const J = 'application/json'
describe('错误归一（依据实测记录-1124）', () => {
  it.each([
    [403, 'text/plain', 'token err', 'unauthenticated', '登录已过期，请重新登录'],
    [403, 'text/plain', 'no permission', 'forbidden', '无权限'],
    [401, J, '{"code":16,"message":"密码错误，请重试"}', 'unauthenticated', '密码错误，请重试'],
    [401, J, '{"code":16,"message":"no token"}', 'unauthenticated', '登录已过期，请重新登录'],
    [401, J, '{"code":16,"message":"token is not valid 1, jwt.ParseWithClaims failed"}', 'unauthenticated', '登录已过期，请重新登录'],
    [500, J, '{"code":13,"message":"项目信息查询失败"}', 'server', '项目信息查询失败'],
    [503, J, '{"code":14,"message":"控制屏消息发送失败"}', 'unavailable', '控制屏消息发送失败'],
    [504, J, '{"code":4,"message":"deadline"}', 'timeout', 'deadline'],
    [502, 'text/html', '<html>bad gateway</html>', 'network', '网络连接失败'],
    [500, J, 'not json', 'server', '服务器错误'],
    [400, J, '{"code":3}', 'bad_request', '请求参数有误'],
  ])('%i %s %s → %s', (status, ct, body, kind, message) => {
    const e = errorFromResponse(status, ct, body)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.kind).toBe(kind)
    expect(e.message).toBe(message)
    expect(e.status).toBe(status)
  })

  it('保留 gRPC 码', () => {
    expect(errorFromResponse(500, J, '{"code":13,"message":"x"}').code).toBe(13)
  })

  it('网络错误、超时、取消', () => {
    expect(errorFromThrown(new TypeError('fetch failed'), false).kind).toBe('network')
    expect(errorFromThrown(new DOMException('a', 'AbortError'), true).kind).toBe('timeout')
    expect(errorFromThrown(new DOMException('a', 'AbortError'), false).kind).toBe('aborted')
  })

  it('只有网络/超时/服务器错误可重试', () => {
    expect(isRetryable(new ApiError('network', ''))).toBe(true)
    expect(isRetryable(new ApiError('server', ''))).toBe(true)
    for (const k of ['unauthenticated', 'forbidden', 'unavailable', 'ctrl', 'write_blocked'] as const) {
      expect(isRetryable(new ApiError(k, ''))).toBe(false)
    }
    expect(isRetryable(new Error('x'))).toBe(false)
  })
})

describe('令牌脱敏', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLXZhbHVl'
  it('JWT、Bearer 值、*_token 字段值都替换成 ***', () => {
    expect(redact(`bad ${jwt} end`)).toBe('bad *** end')
    expect(redact('Authorization: Bearer abcdefgh123')).toBe('Authorization: Bearer ***')
    expect(redact('{"refresh_token":"r-123456789","x":1}')).toBe('{"refresh_token":"***","x":1}')
    expect(redact('refreshToken=zzzzzzzzzz')).toBe('refreshToken=***')
  })
  it('当前存储的令牌原文在任何 ApiError 信息里都被替换', () => {
    writeTokens({ accessToken: 'opaque-access-0001', refreshToken: 'opaque-refresh-0002', expiresAt: Date.now() + 1000 })
    const e = new ApiError('server', '刷新失败 opaque-refresh-0002 / opaque-access-0001')
    expect(e.message).toBe('刷新失败 *** / ***')
    expect(errorFromResponse(500, J, `{"code":13,"message":"bad opaque-refresh-0002"}`).message).toBe('bad ***')
    clearTokens()
  })
})
