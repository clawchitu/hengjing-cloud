import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { consoleLogger, makeEntry, maskId } from '../log'
import { createUnifiedController } from '../machine'
import type { UnifiedLogEntry } from '../log'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlc2lnbmF0dXJl'

describe('日志脱敏', () => {
  it('项目 id 只留首尾 4 位；短 id 全部打码', () => {
    expect(maskId('66cfd7959fb60d63c917fd0a')).toBe('66cf…fd0a')
    expect(maskId('12345678')).toBe('***')
    expect(maskId('')).toBeUndefined()
  })

  it('文案里的令牌、Bearer、*_token 被替换', () => {
    const e = makeEntry('failure', { message: `x ${JWT} Bearer abcdefghijk access_token=zzzzzzzzzz` }, new Date(0))
    expect(e.message).not.toContain(JWT)
    expect(e.message).not.toContain('abcdefghijk')
    expect(e.message).not.toContain('zzzzzzzzzz')
    expect(e.at).toBe('1970-01-01T00:00:00.000Z')
  })

  it('文案里的完整项目 id 换成打码后的', () => {
    const e = makeEntry('blocked', { projectId: '66cfd7959fb60d63c917fd0a', message: '项目不在下发名单内：66cfd7959fb60d63c917fd0a' })
    expect(e.message).toBe('项目不在下发名单内：66cf…fd0a')
  })

  it('query 只保留数值字段，混进来的其他字段丢掉', () => {
    const e = makeEntry('send', { query: { systemSwitch: -1, roomTemp: 24, user_id: 'u-secret', token: JWT, bad: NaN } as object })
    expect(e.query).toEqual({ systemSwitch: -1, roomTemp: 24 })
  })

  it('整条流程的日志里没有完整项目 id、user_id、令牌、回读原始数据', async () => {
    const logs: UnifiedLogEntry[] = []
    const projectId = '66cfd7959fb60d63c917fd0a'
    const ctl = createUnifiedController<{ name: string; secret: string }>({
      getContext: () => ({ projectId, projectCode: '240829001', appCode: 1, online: true }),
      readBack: async () => ({ name: '房间11', secret: 'READBACK-RAW' }),
      send: async () => { throw new ApiError('server', `失败 ${JWT} 项目 ${projectId}`) },
      verify: () => [],
      log: (e) => logs.push(e),
    })
    ctl.request({ roomTemp: 24 })
    await ctl.confirm()
    const text = JSON.stringify(logs)
    expect(text).not.toContain(projectId)
    expect(text).not.toContain(JWT)
    expect(text).not.toContain('READBACK-RAW')
    expect(text).toContain('240829001')
    expect(logs.at(-1)).toMatchObject({ event: 'failure', projectId: '66cf…fd0a' })
  })

  it('consoleLogger 输出 JSON 一行', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    consoleLogger(makeEntry('cancel', { projectCode: '240829001' }))
    expect(spy).toHaveBeenCalledWith('[unified-ctrl]', expect.stringContaining('"event":"cancel"'))
    spy.mockRestore()
  })
})
