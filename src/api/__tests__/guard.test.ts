import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { assertWriteAllowed, checkWrite, guardedWrite, WRITE_OPS } from '../guard'
import { setConfig } from '../config'

const TEST = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1' }])
const PROD = resolveConfig([{ apiBase: 'https://api.cosyhome.com.cn/v1' }])

describe('写操作防护', () => {
  it('写接口共 5 个', () => {
    expect(WRITE_OPS).toEqual(['ctrl-201', 'ctrl-203', 'ctrl-204', 'ctrl-206', 'unified-ctrls-send'])
  })

  it('测试环境默认放行全部写接口', () => {
    for (const op of WRITE_OPS) expect(checkWrite(op, ['p1'], TEST)).toEqual({ ok: true })
  })

  it('生产环境默认拦截全部写接口', () => {
    for (const op of WRITE_OPS) expect(checkWrite(op, ['p1'], PROD)).toMatchObject({ ok: false, reason: '生产环境下发未开启' })
  })

  it('生产环境须显式 writeMode=on', () => {
    const on = resolveConfig([{ apiBase: 'https://api.cosyhome.com.cn/v1', writeMode: 'on' }])
    expect(checkWrite('ctrl-201', ['p1'], on).ok).toBe(true)
  })

  it('writeMode=off 在测试环境也全部拦截', () => {
    const off = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1', writeMode: 'off' }])
    for (const op of WRITE_OPS) expect(checkWrite(op, ['p1'], off).ok).toBe(false)
  })

  it('判断不出环境（相对路径、未配置 apiEnv）按生产处理', () => {
    expect(checkWrite('ctrl-206', ['p1'], resolveConfig([{ apiBase: '/api' }])).ok).toBe(false)
    // 完整地址时以域名为准，写 apiEnv:test 也没用
    expect(checkWrite('ctrl-206', ['p1'], resolveConfig([{ apiBase: 'https://api.cosyhome.com.cn/v1', apiEnv: 'test' }])).ok).toBe(false)
  })

  it('项目名单：只放行名单内的项目', () => {
    const cfg = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1', writeProjectIds: ['p1'] }])
    expect(checkWrite('unified-ctrls-send', ['p1'], cfg).ok).toBe(true)
    expect(checkWrite('unified-ctrls-send', ['p1', 'p9'], cfg)).toEqual({ ok: false, reason: '项目不在下发名单内：p9' })
  })

  it('未指定项目、未登记的写操作都拦截', () => {
    expect(checkWrite('ctrl-201', [], TEST).ok).toBe(false)
    expect(checkWrite('ctrl-999' as never, ['p1'], TEST).ok).toBe(false)
  })

  it('assertWriteAllowed 抛 write_blocked；guardedWrite 被拦时不执行', async () => {
    expect(() => assertWriteAllowed('ctrl-204', ['p1'], PROD)).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
    setConfig({ apiBase: 'https://api.cosyhome.com.cn/v1' })
    const run = vi.fn(async () => 1)
    await expect(guardedWrite('ctrl-204', ['p1'], run)).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(run).not.toHaveBeenCalled()
    setConfig({ apiBase: 'https://test.cosyhome.com.cn:9443/v1' })
    await expect(guardedWrite('ctrl-204', ['p1'], run)).resolves.toBe(1)
    setConfig(null)
  })
})
