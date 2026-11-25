import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import { assertNoImplicitZero, assertWriteAllowed, checkWrite, isNonCanonicalPath, isWritePath, normalizePath, WRITE_OPS } from '../guard'

const TEST = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1' }])
const PROD = resolveConfig([{ apiBase: 'https://api.cosyhome.com.cn/v1' }])

describe('写操作防护', () => {
  it('写接口共 5 个', () => {
    expect(WRITE_OPS).toEqual(['ctrl-201', 'ctrl-203', 'ctrl-204', 'ctrl-206', 'unified-ctrls-send'])
  })

  // 后端实体 id 与 code 不同，白名单只认 code
  const P = { id: '66cfd7959fb60d63c917fd0a', code: '240829001' }
  const Q = { id: '66d0aa11bb22cc33dd44ee55', code: '260911001' }

  it('测试环境默认放行全部写接口（默认白名单内的项目）', () => {
    for (const op of WRITE_OPS) expect(checkWrite(op, [P], TEST)).toEqual({ ok: true })
    for (const op of WRITE_OPS) expect(checkWrite(op, [Q], TEST)).toEqual({ ok: true })
  })

  it('生产环境默认拦截全部写接口', () => {
    for (const op of WRITE_OPS) expect(checkWrite(op, [P], PROD)).toMatchObject({ ok: false, reason: '生产环境下发未开启' })
  })

  it('生产环境须显式 writeMode=on', () => {
    const on = resolveConfig([{ apiBase: 'https://api.cosyhome.com.cn/v1', writeMode: 'on' }])
    expect(checkWrite('ctrl-201', [P], on).ok).toBe(true)
  })

  it('writeMode=off 在测试环境也全部拦截', () => {
    const off = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1', writeMode: 'off' }])
    for (const op of WRITE_OPS) expect(checkWrite(op, [P], off).ok).toBe(false)
  })

  it('判断不出环境（相对路径、未配置 apiEnv）按生产处理', () => {
    expect(checkWrite('ctrl-206', [P], resolveConfig([{ apiBase: '/api' }])).ok).toBe(false)
    // 完整地址时以域名为准，写 apiEnv:test 也没用
    expect(checkWrite('ctrl-206', [P], resolveConfig([{ apiBase: 'https://api.cosyhome.com.cn/v1', apiEnv: 'test' }])).ok).toBe(false)
  })

  it('白名单按 code 比对：名单内放行，名单外拒绝；用 id 匹配名单无效', () => {
    const cfg = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1', writeProjectCodes: ['240829001'] }])
    for (const op of WRITE_OPS) {
      expect(checkWrite(op, [P], cfg).ok).toBe(true)
      expect(checkWrite(op, [P, Q], cfg)).toEqual({ ok: false, reason: '项目不在下发名单内：260911001' })
      expect(checkWrite(op, [{ id: '240829001', code: '66cfd7959fb60d63c917fd0a' }], cfg).ok).toBe(false)
    }
    const byId = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1', writeProjectCodes: [P.id] }])
    expect(checkWrite('ctrl-203', [P], byId).ok).toBe(false)
  })

  it('白名单为空：拒绝所有写操作', () => {
    const empty = resolveConfig([{ apiBase: 'https://test.cosyhome.com.cn:9443/v1', writeProjectCodes: [] }])
    const emptyOn = resolveConfig([{ apiBase: 'https://api.cosyhome.com.cn/v1', writeMode: 'on', writeProjectCodes: '' }])
    for (const op of WRITE_OPS) {
      expect(checkWrite(op, [P], empty)).toEqual({ ok: false, reason: '下发名单为空' })
      expect(checkWrite(op, [P], emptyOn)).toEqual({ ok: false, reason: '下发名单为空' })
    }
  })

  it.each([
    ['code 缺失', { id: P.id }],
    ['code 空串', { id: P.id, code: '' }],
    ['code 只有空白', { id: P.id, code: '  ' }],
    ['code 首尾带空白', { id: P.id, code: ' 240829001' }],
    ['id 首尾带空白', { id: P.id + ' ', code: P.code }],
    ['code 为数字', { id: P.id, code: 240829001 }],
    ['code 为 null', { id: P.id, code: null }],
    ['code 为数组', { id: P.id, code: ['240829001'] }],
    ['id 缺失', { code: P.code }],
    ['id 空串', { id: '', code: P.code }],
    ['id 为数字', { id: 1, code: P.code }],
    ['项目为字符串', P.code],
    ['项目为 null', null],
    ['getter 抛错', { id: P.id, get code(): string { throw new Error('x') } }],
  ] as const)('%s：一律拒绝（fail closed）', (_, bad) => {
    for (const op of WRITE_OPS) {
      expect(checkWrite(op, [bad], TEST)).toMatchObject({ ok: false })
      expect(checkWrite(op, [P, bad], TEST)).toMatchObject({ ok: false })
      expect(() => assertWriteAllowed(op, [bad], TEST)).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
    }
  })

  it('未指定项目、项目列表不是数组、未登记的写操作都拦截', () => {
    expect(checkWrite('ctrl-201', [], TEST).ok).toBe(false)
    expect(checkWrite('ctrl-201', P as never, TEST).ok).toBe(false)
    expect(() => assertWriteAllowed('ctrl-201', P as never, TEST)).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
    expect(checkWrite('ctrl-999' as never, [P], TEST).ok).toBe(false)
  })

  it('assertWriteAllowed：拦截抛 write_blocked；通过返回只读一次的快照，按 id 去重', () => {
    expect(() => assertWriteAllowed('ctrl-204', [P], PROD)).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
    expect(assertWriteAllowed('ctrl-204', [P], TEST)).toEqual([P])
    expect(assertWriteAllowed('unified-ctrls-send', [P, Q, { ...P }], TEST)).toEqual([P, Q])
    // 第一次读到名单内的 code，之后变成别的：只读一次，快照里是校验过的值
    let n = 0
    const flaky = { id: P.id, get code() { return n++ === 0 ? P.code : 'evil' } }
    const [snap] = assertWriteAllowed('ctrl-206', [flaky], TEST)
    expect(snap).toEqual(P)
    expect(Object.isFrozen(snap)).toBe(true)
  })

  it('同一 id 对应不同 code：拒绝', () => {
    expect(() => assertWriteAllowed('unified-ctrls-send', [P, { id: P.id, code: Q.code }], TEST)).toThrow(expect.objectContaining({ kind: 'write_blocked' }))
  })

  it('写接口路径识别', () => {
    expect(isWritePath('/ctrl/room-temperature-set')).toBe(true)
    expect(isWritePath('/v1/ctrl/unified-ctrls-send')).toBe(true)
    expect(isWritePath('/ctrl/room-temperature-data-get')).toBe(false)
    expect(isWritePath('/ctrl/unified-ctrls-records')).toBe(false)
    expect(isWritePath('/ctrl/projects')).toBe(false)
  })

  it('路径规范化：./、..、反斜杠、重复斜杠、大小写、空白、百分号编码、查询串', () => {
    const W = '/ctrl/room-temperature-set'
    for (const p of ['/./ctrl/room-temperature-set', '/x/../ctrl/room-temperature-set', '/ctrl\\room-temperature-set', '//ctrl///room-temperature-set/',
      '/CTRL/Room-Temperature-Set', '/v1/ctrl/room-temperature-set', 'V1/ctrl/room-temperature-set', ' /ctrl/room-temperature-set\n', '/ctrl/room-\ttemperature-set',
      '/ctrl/room-temperature-set?x=1', '/ctrl/room-temperature-set#a', '/ctrl/room%2Dtemperature-set', '/ctrl%2Froom-temperature-set', '/ctrl/%2E%2E/ctrl/room-temperature-set', '/ctrl/room%252Dtemperature-set']) {
      expect(normalizePath(p), p).toBe(W)
      expect(isWritePath(p), p).toBe(true)
    }
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('/v1')).toBe('/')
  })

  it('完整地址或任意层级下的 ctrl 写路径也识别', () => {
    expect(isWritePath('https://api.cosyhome.com.cn/v1/ctrl/unified-ctrls-send')).toBe(true)
    expect(isWritePath('/api/../ctrl/project-room-switch-set')).toBe(true)
    expect(isWritePath('https://api.cosyhome.com.cn/v1/ctrl/room-temperature-data-get')).toBe(false)
  })

  it('非规范路径识别', () => {
    for (const p of ['/./ctrl/x', '/a/../b', '/a\\b', '/a b', '/a\tb', '/a\n', '/a/%2e%2e/b', '/a%2Fb', '/a%5Cb'])
      expect(isNonCanonicalPath(p), p).toBe(true)
    for (const p of ['/ctrl/room-temperature-data-get', '/v1/me', '/ctrl/unified-ctrls-records?batch_id=a b', 'ctrl/projects'])
      expect(isNonCanonicalPath(p), p).toBe(false)
  })
})

describe('写消息最后防线 assertNoImplicitZero（不变一律 -1，0 只能来自明确的改动）', () => {
  const none = new Set<string>()
  it('203 / 批量统一控制：运行模式为 0 一律拒发，即使登记为明确给出', () => {
    const q = { systemSwitch: -1, systemMode: 0, roomSwitch: 1, roomTemp: -1 }
    for (const op of ['ctrl-203', 'unified-ctrls-send'] as const) {
      expect(() => assertNoImplicitZero(op, q, new Set(['roomSwitch', 'systemMode']))).toThrow(/运行模式为 0/)
    }
    expect(() => assertNoImplicitZero('ctrl-203', { ...q, systemMode: -1 }, new Set(['roomSwitch']))).not.toThrow()
  })
  it('没有明确给出的数值为 0 → 拒发（proto3 里漏设的字段解出来就是 0）', () => {
    expect(() => assertNoImplicitZero('ctrl-201', { equipmentId: 1, temperature: 26, humidity: 0, windSpeed: -1, eco: -1, switch: -1, endModes: [] }, new Set(['equipmentId', 'temperature']))).toThrow(/humidity/)
    expect(() => assertNoImplicitZero('ctrl-206', { switch: 0 }, none)).toThrow(/switch/)
    expect(() => assertNoImplicitZero('ctrl-204', { id: 9, name: 'x', controlType: 0, dewPoint: -1, humiditySet: -1, windSpeed: -1, switch: -1 }, new Set(['id', 'name']))).toThrow(/controlType/)
  })
  it('明确给出的 0（关房间、湿度控制、关节能）放行', () => {
    expect(() => assertNoImplicitZero('ctrl-206', { switch: 0 }, new Set(['switch']))).not.toThrow()
    expect(() => assertNoImplicitZero('ctrl-201', { equipmentId: 1, temperature: -1, humidity: -1, windSpeed: -1, eco: 0, switch: -1, endModes: [] }, new Set(['equipmentId', 'eco']))).not.toThrow()
  })
  it('列表：明确给出的（end_modes 完整回传）不逐项查；没给的必须为空', () => {
    const ends = [{ optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 0 }]
    const q = { equipmentId: 1, temperature: 25, humidity: -1, windSpeed: -1, eco: -1, switch: -1, endModes: ends }
    expect(() => assertNoImplicitZero('ctrl-201', q, new Set(['equipmentId', 'temperature', 'endModes']))).not.toThrow()
    expect(() => assertNoImplicitZero('ctrl-201', q, new Set(['equipmentId', 'temperature']))).toThrow(/endModes/)
  })
})
