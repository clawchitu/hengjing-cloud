import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { consoleLogger, errorKindOf, makeEntry, maskId, type UnifiedLogEntry } from '../log'
import { createUnifiedController } from '../machine'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlc2lnbmF0dXJl'
const PID = '66cfd7959fb60d63c917fd0a'
const ALLOWED_KEYS = ['event', 'at', 'projectCode', 'projectId', 'codes', 'errorKind', 'fields']

describe('日志脱敏', () => {
  it('项目 id 只留首尾 4 位；短 id 全部打码', () => {
    expect(maskId(PID)).toBe('66cf…fd0a')
    expect(maskId('12345678')).toBe('***')
    expect(maskId('')).toBeUndefined()
  })

  it('只保留白名单里的代码、字段名、错误 kind；其他一律丢掉', () => {
    const e = makeEntry('failure', {
      projectCode: '240829001',
      projectId: PID,
      codes: ['REJECTED', `x ${JWT}`, 'user_id=u1'],
      fields: ['roomTemp', 'user_id', '房间11'],
      error: new ApiError('ctrl', `失败 ${JWT} user_id=u-secret 项目 ${PID}`),
      // 调用方塞进来的多余东西
      ...({ message: 'RAW', query: { roomTemp: 24 }, user_id: 'u-secret' } as object),
    }, new Date(0))
    expect(e).toEqual({ event: 'failure', at: '1970-01-01T00:00:00.000Z', projectCode: '240829001', projectId: '66cf…fd0a', codes: ['REJECTED'], errorKind: 'ctrl', fields: ['roomTemp'] })
  })

  it('非数字的项目编号不记；非 ApiError 的错误只记 other', () => {
    expect(makeEntry('blocked', { projectCode: `abc ${JWT}` }).projectCode).toBeUndefined()
    expect(errorKindOf(new Error('raw text'))).toBe('other')
    expect(errorKindOf({ kind: 'u-secret' })).toBe('other')
    expect(errorKindOf(undefined)).toBeUndefined()
  })

  it('整条流程（含失败、结果未知）的日志里没有错误原文、完整项目 id、user_id、令牌、下发值、回读内容', async () => {
    for (const sendErr of [new ApiError('server', `失败 ${JWT} user_id=u-secret ${PID}`, { status: 500 }), new ApiError('timeout', `超时 ${PID}`), new Error(`boom u-secret ${PID}`)]) {
      const logs: UnifiedLogEntry[] = []
      let n = 0
      const ctl = createUnifiedController<{ name: string; secret: string; roomTemp: number }>({
        getContext: () => ({ projectId: PID, projectCode: '240829001', appCode: 1, online: true }),
        readBack: async () => { if (n++) throw new Error(`READBACK-ERR u-secret ${PID}`); return { name: '房间11', secret: 'READBACK-RAW', roomTemp: 22.5 } },
        toEcho: (s) => ({ roomTemp: s.roomTemp }),
        send: async () => { throw sendErr },
        log: (e) => logs.push(e),
      })
      ctl.request({ roomTemp: 26.5 })
      await ctl.confirm()
      const text = JSON.stringify(logs)
      for (const bad of [PID, JWT, 'u-secret', 'READBACK-RAW', 'READBACK-ERR', '房间11', '失败', '超时', 'boom', '26.5', '22.5']) expect(text).not.toContain(bad)
      for (const l of logs) for (const k of Object.keys(l)) expect(ALLOWED_KEYS).toContain(k)
      expect(text).toContain('240829001')
      expect(text).toContain('roomTemp')
    }
  })

  it('校验拦截只记代码', () => {
    const logs: UnifiedLogEntry[] = []
    const ctl = createUnifiedController({ getContext: () => ({ projectId: PID, projectCode: '240829001', appCode: 12, online: false }), readBack: async () => ({}), toEcho: () => ({}), log: (e) => logs.push(e) })
    ctl.request({ roomTemp: 24 })
    expect(logs).toEqual([expect.objectContaining({ event: 'blocked', codes: ['OFFLINE', 'TEMP_DISABLED'] })])
    expect(JSON.stringify(logs)).not.toContain('离线')
  })

  it('consoleLogger 输出 JSON 一行', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    consoleLogger(makeEntry('cancel', { projectCode: '240829001' }))
    expect(spy).toHaveBeenCalledWith('[unified-ctrl]', expect.stringContaining('"event":"cancel"'))
    spy.mockRestore()
  })
})
