import { describe, expect, it } from 'vitest'
import { snapshotProject, type WriteProject } from '../../../api/guard'
import { APP_CODE, capabilitiesOf, hasRooms, isStandalone, toAppCode } from '../capabilities'
import { isOnlineEntity, joinScope, PLATFORM_DEALER, PLATFORM_DEALER_ID, withPlatformDealer, projectsInGroup, projectsInGroups, resolveCurrentProject, resolveDealerId, toDealer, toGroup, toProject } from '../map'
import type { Group, Project } from '../types'

const P = (id: string, extra: Partial<Project> = {}): Project => ({
  id, code: 'c' + id, name: 'n' + id, groupId: '', city: '', district: '', kind: '', online: false, version: '', devices: 0, programCode: 1, ...extra,
})
const G = (id: string, projectIds: string[], dealerId = 'D1'): Group => ({ id, code: id, dealerId, name: id, type: '', typeColor: 'cyan', desc: '', created: '', projectIds })

describe('在线判定', () => {
  it('online 只有 true 才在线；缺失、false、字符串都按离线', () => {
    expect(isOnlineEntity({ online: true })).toBe(true)
    expect(isOnlineEntity({})).toBe(false)
    expect(isOnlineEntity({ online: false })).toBe(false)
    expect(isOnlineEntity({ online: 'true' })).toBe(false)
  })
  it('项目、集成项目的映射用同一判定', () => {
    expect(toProject({ id: 'a', online: true }).online).toBe(true)
    expect(toProject({ id: 'b' }).online).toBe(false)
    expect(toGroup({ id: 'g' }).online).toBe(false)
    expect(toGroup({ id: 'g', online: true }).online).toBe(true)
  })
})

describe('app_code 能力', () => {
  it('后端给字符串，转成数字；缺失或非法为 0', () => {
    expect(toAppCode('12')).toBe(12)
    expect(toAppCode(1)).toBe(1)
    expect(toAppCode(undefined)).toBe(0)
    expect(toAppCode('')).toBe(0)
    expect(toAppCode('abc')).toBe(0)
    expect(toAppCode('1.5')).toBe(0)
  })
  it('1 通用版：有房间温控、温度可设、没有新风运行设置', () => {
    expect(capabilitiesOf(APP_CODE.GENERAL)).toEqual({ appCode: 1, thermostat: true, roomTemp: true, freshAirSettings: false, supported: true })
  })
  it('12 独立空气系统：没有房间温控、温度不可设、有新风运行设置', () => {
    expect(capabilitiesOf('12')).toEqual({ appCode: 12, thermostat: false, roomTemp: false, freshAirSettings: true, supported: true })
  })
  it('8 暂不用本平台：标为不支持；缺失编码同样不支持，但页面按「非 12」处理', () => {
    expect(capabilitiesOf(8)).toMatchObject({ supported: false, thermostat: true, freshAirSettings: false })
    expect(capabilitiesOf(null)).toMatchObject({ appCode: 0, supported: false, thermostat: true })
  })
  it('hasRooms / isStandalone 与能力一致（演示数据的 11/21/31 都有房间）', () => {
    for (const c of [1, 11, 21, 31]) { expect(hasRooms({ programCode: c })).toBe(true); expect(isStandalone({ programCode: c })).toBe(false) }
    expect(hasRooms({ programCode: 12 })).toBe(false)
    expect(isStandalone({ programCode: 12 })).toBe(true)
  })
})

describe('实体映射', () => {
  it('ProjectEntity → Project：code 用于显示，app_code 进 programCode，设备数取 brief_stat', () => {
    const p = toProject({
      id: '6aa3', name: '独立空气系统测试', code: '260911001', app_code: '12', app_name: '独立空气系统', app_version: '1.0',
      app_category_name: '空气系统', distributor_id: 'D1', customer_region: '320000/320500/320506', control_screen_id: 'cs', brief_stat: { device_count: '3' }, online: true,
    })
    expect(p).toMatchObject({ id: '6aa3', code: '260911001', programCode: 12, appName: '独立空气系统', version: '1.0', kind: '空气系统', devices: 3, region: '320000/320500/320506', distributorId: 'D1', controlScreenId: 'cs', online: true })
    expect(toProject({ id: 'x' })).toMatchObject({ code: '', name: '', programCode: 0, devices: 0, version: '' })
  })
  it('IntegratedProjectEntity → Group：project_ids 去重；平台创建的没有 distributor_id', () => {
    expect(toGroup({ id: 'g1', code: '2', name: '五恒集成项目', distributor_id: 'D1', project_ids: ['a', 'b', 'a'], created_at: '2026-11-24 07:49:41' }))
      .toMatchObject({ id: 'g1', code: '2', dealerId: 'D1', projectIds: ['a', 'b'], created: '2026-11-24 07:49:41' })
    expect(toGroup({ id: 'g0' })).toMatchObject({ dealerId: PLATFORM_DEALER_ID, projectIds: [] })
  })
  it('DistributorEntity → Dealer：简称缺失时用全称', () => {
    expect(toDealer({ id: 'D1', name: '科希家研发苏州main', abbreviation: '科希家研发' }).short).toBe('科希家研发')
    expect(toDealer({ id: 'D2', name: '某经销商' }).short).toBe('某经销商')
  })
})

describe('组织范围', () => {
  const projects = [P('a', { online: true }), P('b'), P('c'), P('d')]
  it('只保留集成项目里的项目，顺序沿用项目列表；groupId 取第一个包含它的集成项目', () => {
    const s = joinScope([], [G('g2', ['c', 'a']), G('g1', ['a', 'x'])], projects, { dealerAccount: false })
    expect(s.projects.map((p) => [p.id, p.groupId])).toEqual([['a', 'g2'], ['c', 'g2']])
  })
  it('经销商账号没有经销商列表时按集成项目归纳（只用于侧栏分组）', () => {
    const s = joinScope([], [G('g1', ['a'], 'D1'), G('g2', ['b'], 'D2'), G('g3', ['c'], 'D1')], projects, { dealerAccount: true })
    expect(s.dealers.map((d) => d.id)).toEqual(['D1', 'D2'])
    expect(joinScope([], [G('g1', ['a'])], projects, { dealerAccount: false }).dealers).toEqual([])
  })
  it('平台账号：没有 distributor_id 的集成项目归到虚拟经销商「平台」，侧栏能看到', () => {
    const plat = toGroup({ id: 'g0', project_ids: ['a'] })
    const s = joinScope([{ id: 'D1', name: '甲', short: '甲', region: '' }], [plat, G('g1', ['b'], 'D1')], projects, { dealerAccount: false })
    expect(s.dealers.map((d) => d.id)).toEqual(['D1', PLATFORM_DEALER_ID])
    expect(s.groups.find((g) => g.id === 'g0')?.dealerId).toBe(PLATFORM_DEALER_ID)
    expect(s.dealers[1]).toEqual(PLATFORM_DEALER)
    // 都有归属时不补，原数组原样返回（引用不变）
    const ds = [{ id: 'D1', name: '甲', short: '甲', region: '' }]
    expect(withPlatformDealer(ds, [G('g1', [], 'D1')])).toBe(ds)
  })
  it('projectsInGroup / projectsInGroups 按 projectIds 判断归属（一个项目可属于多个集成项目）', () => {
    const g1 = G('g1', ['b', 'a']), g2 = G('g2', ['a', 'c'])
    expect(projectsInGroup(g1, projects).map((p) => p.id)).toEqual(['a', 'b'])
    expect(projectsInGroup(g2, projects).map((p) => p.id)).toEqual(['a', 'c'])
    expect(projectsInGroups([g1, g2], projects).map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(projectsInGroup(undefined, projects)).toEqual([])
  })
})

describe('当前项目解析', () => {
  const ps = [P('a'), P('b')]
  it('存储的 ID 有效就用它', () => expect(resolveCurrentProject(ps, 'b')?.id).toBe('b'))
  it('失效（换账号、项目被移出范围）回退到第一个可见项目', () => expect(resolveCurrentProject(ps, 'zzz')?.id).toBe('a'))
  it('没选过回退到第一个', () => expect(resolveCurrentProject(ps, '')?.id).toBe('a'))
  it('没有可见项目（加载中 / 无数据）为 null', () => expect(resolveCurrentProject([], 'a')).toBeNull())
})

describe('经销商默认值', () => {
  it('列表为空 → 空串；列表到达 → 第一个；选过且仍在列表里 → 保留；选的不在了 → 回到第一个', () => {
    expect(resolveDealerId([], '')).toBe('')
    expect(resolveDealerId([{ id: 'D1' }, { id: 'D2' }], '')).toBe('D1')
    expect(resolveDealerId([{ id: 'D1' }, { id: 'D2' }], 'D2')).toBe('D2')
    expect(resolveDealerId([{ id: 'D1' }], 'D2')).toBe('D1')
  })
})

describe('与写入口对齐（写防护按 code 比对白名单、请求用 id）', () => {
  it('Project 能直接当 WriteProject 传给写入口：快照取到 id 与 code', () => {
    const p = toProject({ id: '6aa3a0ade8f3372b86b15b05', code: '260911001', app_code: '12', online: true })
    const w: WriteProject = p // 类型层面可直接传
    expect(snapshotProject(w)).toEqual({ id: '6aa3a0ade8f3372b86b15b05', code: '260911001' })
  })
  it('后端缺 code 的项目映射为空串，写防护拒绝（fail closed），不会用别的字段顶替', () => {
    expect(toProject({ id: 'x' }).code).toBe('')
    expect(snapshotProject(toProject({ id: 'x' }))).toBeNull()
  })
})
