import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfig } from '../../../api/config'
import { __resetHttpForTests } from '../../../api/http'
import { clearTokens, writeTokens } from '../../../api/tokens'
import { fakeBackend, json, text } from '../../../api/__tests__/helpers'
import { users } from '../../../mock/org'
import { PLATFORM_DEALER_ID } from '../map'
import { mockOrg, orgSource, realSource } from '../sources'

const ctx = { user: users.hjadmin, dealerAccount: false }

beforeEach(() => {
  setConfig({ apiBase: '/api', dataSource: 'real' })
  __resetHttpForTests(); clearTokens()
  writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
})
afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

describe('真实数据源（只读接口）', () => {
  it('项目列表：POST /ctrl/projects，不传分页一次取全部；onlyOnline 传 only_online:true', async () => {
    const be = fakeBackend({ '/ctrl/projects': () => json({ project_entities: [{ id: 'p1', code: '240829001', app_code: '1', online: true }, { id: 'p2', app_code: '12' }], total: 2 }) })
    const ps = await realSource.projects(ctx, {})
    expect(be.callsTo('/ctrl/projects')[0]).toMatchObject({ method: 'POST', body: {} })
    expect(be.callsTo('/ctrl/projects')[0].headers.Authorization).toBe('Bearer A1')
    expect(ps.map((p) => [p.id, p.online, p.programCode])).toEqual([['p1', true, 1], ['p2', false, 12]])
    await realSource.projects(ctx, { onlyOnline: true })
    expect(be.callsTo('/ctrl/projects')[1].body).toEqual({ only_online: true })
  })

  it('经销商：POST /distributors { has_integrated_project:true }', async () => {
    const be = fakeBackend({ '/distributors': () => json({ distributor_entities: [{ id: 'D1', name: '科希家研发苏州main', abbreviation: '科希家研发' }], total: 1 }) })
    expect(await realSource.dealers(ctx)).toEqual([{ id: 'D1', name: '科希家研发苏州main', short: '科希家研发', region: '', code: undefined }])
    expect(be.callsTo('/distributors')[0].body).toEqual({ has_integrated_project: true })
  })

  it('集成项目：不传经销商按账号范围；传入时带 distributor_id', async () => {
    const be = fakeBackend({ '/integrated-projects': () => json({ entities: [{ id: 'g1', code: '2', project_ids: ['p1'] }], total: 3 }) })
    expect((await realSource.groups(ctx, undefined)).map((g) => g.projectIds)).toEqual([['p1']])
    await realSource.groups(ctx, 'D1')
    expect(be.callsTo('/integrated-projects').map((c) => c.body)).toEqual([{}, { distributor_id: 'D1' }])
  })

  it('虚拟经销商「平台」：不传 distributor_id 取全部，只留没有归属经销商的', async () => {
    const be = fakeBackend({ '/integrated-projects': () => json({ entities: [{ id: 'g0', project_ids: ['p1'] }, { id: 'g1', distributor_id: 'D1' }] }) })
    expect((await realSource.groups(ctx, PLATFORM_DEALER_ID)).map((g) => g.id)).toEqual(['g0'])
    expect(be.callsTo('/integrated-projects')[0].body).toEqual({})
  })

  it('碰撞夹具：后端经销商 id 等于哨兵时被丢弃，选不到，也就不会误走「取全部再过滤」', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fakeBackend({ '/distributors': () => json({ distributor_entities: [{ id: PLATFORM_DEALER_ID, name: '撞名' }, { id: '62d7aa299e984547ba4b9372', name: '正常' }] }) })
    expect((await realSource.dealers(ctx)).map((d) => d.id)).toEqual(['62d7aa299e984547ba4b9372'])
    warn.mockRestore()
  })

  it('空响应 {}（proto3 不输出空列表）→ 空数组', async () => {
    fakeBackend({ '/ctrl/projects': () => json({}), '/integrated-projects': () => json({}), '/distributors': () => json({}), '/apps': () => json({}) })
    expect(await realSource.projects(ctx, {})).toEqual([])
    expect(await realSource.groups(ctx, undefined)).toEqual([])
    expect(await realSource.dealers(ctx)).toEqual([])
    expect(await realSource.apps(ctx)).toEqual({})
  })

  it('错误按 S4 归一：403 no permission → forbidden', async () => {
    fakeBackend({ '/ctrl/projects': () => text('no permission', 403) })
    await expect(realSource.projects(ctx, {})).rejects.toMatchObject({ kind: 'forbidden' })
  })

  it('应用：app_id → 名称', async () => {
    fakeBackend({ '/apps': () => json({ app_entities: [{ id: 'a12', code: '12', name: '独立空气系统' }, { id: 'a1', code: '1', name: '通用版' }] }) })
    expect(await realSource.apps(ctx)).toEqual({ a12: '独立空气系统', a1: '通用版' })
  })
})

describe('数据源切换', () => {
  it('dataSource 决定用哪个源；mock 不发请求', async () => {
    const be = fakeBackend({})
    expect(orgSource()).toBe(realSource)
    setConfig({ dataSource: 'mock' })
    expect(orgSource()).not.toBe(realSource)
    const ps = await orgSource().projects(ctx, {})
    expect(ps.length).toBeGreaterThan(0)
    expect(be.fetchMock).not.toHaveBeenCalled()
  })

  it('mock：经销商账号只见自己的经销商；code 与 id 相同；集成项目带 projectIds；同一用户取到同一批对象', () => {
    const dctx = { user: users.cosyhome, dealerAccount: true }
    expect(mockOrg.dealers(dctx).map((d) => d.id)).toEqual(['DLR-001'])
    expect(mockOrg.dealers(ctx).length).toBe(3)
    const ps = mockOrg.projects(dctx)
    expect(ps.every((p) => p.code === p.id)).toBe(true)
    const g = mockOrg.groups(dctx).find((x) => x.id === 'GRP-SH-001')!
    expect(g.projectIds).toEqual(ps.filter((p) => p.groupId === 'GRP-SH-001').map((p) => p.id))
    expect(mockOrg.projects(dctx)).toBe(ps)
    expect(mockOrg.groups(ctx, 'DLR-002').every((x) => x.dealerId === 'DLR-002')).toBe(true)
    expect(mockOrg.projects(ctx, { onlyOnline: true }).every((p) => p.online)).toBe(true)
  })
})
