import { describe, expect, it } from 'vitest'
import { envOfUrl, resolveConfig, TEST_API_ORIGIN } from '../config'
import { can, isDealer } from '../auth'

describe('运行时配置', () => {
  it('默认：/api、演示数据、按生产处理、超时 10/12 秒', () => {
    expect(resolveConfig([])).toEqual({
      apiBase: '/api', apiEnv: 'prod', dataSource: 'mock', writeMode: 'test-only', writeProjectIds: [],
      requestTimeoutMs: 10_000, ctrlTimeoutMs: 12_000,
    })
  })
  it('后面的层覆盖前面的（构建时 ← 运行时）', () => {
    const c = resolveConfig([{ apiBase: '/api', dataSource: 'mock' }, { apiBase: TEST_API_ORIGIN + '/', dataSource: 'real' }])
    expect(c).toMatchObject({ apiBase: TEST_API_ORIGIN, apiEnv: 'test', dataSource: 'real' })
  })
  it('开发代理指向测试环境时 /api 按测试环境处理', () => {
    expect(resolveConfig([{ apiBase: '/api' }], TEST_API_ORIGIN).apiEnv).toBe('test')
    expect(resolveConfig([{ apiBase: '/api' }], 'https://api.cosyhome.com.cn/v1').apiEnv).toBe('prod')
    // 代理只转发 /api，其他相对路径不沿用代理目标
    expect(resolveConfig([{ apiBase: '/backend' }], TEST_API_ORIGIN).apiEnv).toBe('prod')
    // 协议相对地址按域名判断
    expect(resolveConfig([{ apiBase: '//api.cosyhome.com.cn/v1', apiEnv: 'test' }], TEST_API_ORIGIN).apiEnv).toBe('prod')
  })
  it('相对路径时可显式声明 apiEnv（Worker 代理到测试环境）', () => {
    expect(resolveConfig([{ apiBase: '/api', apiEnv: 'test' }]).apiEnv).toBe('test')
    expect(resolveConfig([{ apiBase: '/api', apiEnv: 'staging' }]).apiEnv).toBe('prod')
  })
  it('域名判断', () => {
    expect(envOfUrl('https://test.cosyhome.com.cn:9443/v1')).toBe('test')
    expect(envOfUrl('https://int.cosyhome.com.cn/v1')).toBe('prod')
    expect(envOfUrl('not a url')).toBe('prod')
  })
})

describe('身份与权限', () => {
  it('/me type：1 是经销商，0 或缺失是平台用户', () => {
    expect(isDealer({ type: 1 })).toBe(true)
    expect(isDealer({ type: 0 })).toBe(false)
    expect(isDealer({})).toBe(false)
    expect(isDealer(null)).toBe(false)
  })
  it('can() 按 /v1 路由模板匹配', () => {
    const paths = ['/v1/projects', '/v1/project/click/{id}', '/v1/ctrl/device-summary-get']
    expect(can(paths, '/projects')).toBe(true)
    expect(can(paths, '/v1/project/click/abc')).toBe(true)
    expect(can(paths, '/project/click')).toBe(false)
    expect(can(paths, '/ctrl/air-sensor-get')).toBe(false)
  })
})
