// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { dealerNames, defaultSections, matchProject, searchProjects } from '../switcher'
import { __resetPrefsForTests, getPinned, getRecent, recordRecent, togglePinned, RECENT_KEEP } from '../prefs'
import { PLATFORM_DEALER, PLATFORM_DEALER_ID } from '../map'
import type { Dealer, Group, Project } from '../types'

const P = (id: string, name: string, online = true, extra: Partial<Project> = {}): Project =>
  ({ id, code: 'C' + id, name, groupId: '', city: '', district: '', area: '', kind: '', online, version: '', devices: 0, programCode: 1, ...extra })
const G = (id: string, dealerId: string, projectIds: string[]): Group =>
  ({ id, code: id, dealerId, name: id, type: '', typeColor: 'cyan', desc: '', created: '', projectIds })
const kxj: Dealer = { id: 'D1', name: '科希家研发有限公司', short: '科希家研发', region: '' }

describe('dealerNames：每个项目一个经销商名，「平台」只在没有真实经销商时出现', () => {
  it('同一项目在科希家研发和平台两个集成项目里：显示科希家研发，两者都能搜到', () => {
    const projects = [P('p1', '一号'), P('p2', '二号')]
    const n = dealerNames({ dealers: [kxj, PLATFORM_DEALER], groups: [G('g1', 'D1', ['p1']), G('g2', PLATFORM_DEALER_ID, ['p1', 'p2'])], projects })
    expect(n.label.get('p1')).toBe('科希家研发')
    expect(n.label.get('p2')).toBe('平台')
    expect(n.terms.get('p1')).toEqual(expect.arrayContaining(['科希家研发有限公司', '科希家研发', '平台']))
  })
  it('接口给了 distributor_name 优先用它', () => {
    const n = dealerNames({ dealers: [kxj], groups: [G('g1', 'D1', ['p1'])], projects: [P('p1', '一号', true, { distributorName: '苏州某经销商' })] })
    expect(n.label.get('p1')).toBe('苏州某经销商')
  })
})

describe('matchProject / searchProjects', () => {
  const projects = [P('a1', '朝阳 A栋'), P('b2', '河西府', false), P('a1', '朝阳 A栋（重复）')]
  const names = dealerNames({ dealers: [kxj], groups: [G('g', 'D1', ['a1', 'b2'])], projects })
  it('按名称、code、实体 id、经销商名匹配，不区分大小写', () => {
    expect(matchProject(projects[0], [], '朝阳')).toBe(true)
    expect(matchProject(projects[0], [], 'ca1')).toBe(true)
    expect(matchProject(projects[0], [], 'A1')).toBe(true)
    expect(matchProject(projects[1], ['科希家研发'], '科希家')).toBe(true)
    expect(matchProject(projects[1], [], '不存在')).toBe(false)
  })
  it('结果按 id 去重，离线不排后，空关键词无结果', () => {
    expect(searchProjects(projects, names, '科希家').map((p) => p.id)).toEqual(['a1', 'b2'])
    expect(searchProjects(projects, names, '  ')).toEqual([])
  })
})

describe('defaultSections', () => {
  const projects = Array.from({ length: 300 }, (_, i) => P('p' + i, '项目' + i, i % 7 !== 0))
  it('经销商：已置顶 → 最近使用（最多 5 个，去掉已置顶）→ 全部（去掉上面出现过的），每个项目只出现一次', () => {
    const s = defaultSections({ projects: [...projects, projects[3]], recent: ['p9', 'p1', 'gone', 'p2', 'p3', 'p4', 'p5', 'p6'], pinned: ['p1', 'p0'], dealerAccount: true })
    expect(s.map((x) => x.key)).toEqual(['pinned', 'recent', 'all'])
    expect(s[0].rows.map((p) => p.id)).toEqual(['p1', 'p0'])
    expect(s[1].rows.map((p) => p.id)).toEqual(['p9', 'p2', 'p3', 'p4', 'p5'])
    const ids = s.flatMap((x) => x.rows.map((p) => p.id))
    expect(ids).toHaveLength(300)
    expect(new Set(ids).size).toBe(300)
    // 离线项目（p0、p7…）照常在原位置
    expect(s[2].rows[0].id).toBe('p6')
    expect(s[2].rows.find((p) => p.id === 'p7')?.online).toBe(false)
  })
  it('平台账号只列已置顶和最近使用；都没有时为空', () => {
    expect(defaultSections({ projects, recent: ['p8'], pinned: ['p2'], dealerAccount: false }).map((x) => [x.key, x.rows.map((p) => p.id)])).toEqual([['pinned', ['p2']], ['recent', ['p8']]])
    expect(defaultSections({ projects, recent: [], pinned: [], dealerAccount: false })).toEqual([])
  })
  it('存储里不在当前账号范围内的 id（别的账号留下的、已删除的）：置顶和最近使用都跳过', () => {
    const s = defaultSections({ projects, recent: ['HZ-ONLY', 'p4'], pinned: ['gone', 'HZ-ONLY', 'p1'], dealerAccount: false })
    expect(s.map((x) => [x.key, x.rows.map((p) => p.id)])).toEqual([['pinned', ['p1']], ['recent', ['p4']]])
    expect(defaultSections({ projects, recent: ['gone'], pinned: ['HZ-ONLY'], dealerAccount: false })).toEqual([])
  })
})

describe('prefs：按账号存 localStorage', () => {
  beforeEach(() => { localStorage.clear(); __resetPrefsForTests() })
  it('最近使用放最前、去重、按账号隔离、有上限', () => {
    recordRecent('mock:a', 'x'); recordRecent('mock:a', 'y'); recordRecent('mock:a', 'x')
    expect(getRecent('mock:a')).toEqual(['x', 'y'])
    expect(getRecent('mock:b')).toEqual([])
    expect(JSON.parse(localStorage.getItem('hjc-recent-projects:mock:a')!)).toEqual(['x', 'y'])
    for (let i = 0; i < 50; i++) recordRecent('mock:a', 'p' + i)
    expect(getRecent('mock:a')).toHaveLength(RECENT_KEEP)
  })
  it('置顶切换；坏数据按空处理', () => {
    togglePinned('mock:a', 'x'); togglePinned('mock:a', 'y')
    expect(getPinned('mock:a')).toEqual(['y', 'x'])
    togglePinned('mock:a', 'y')
    expect(getPinned('mock:a')).toEqual(['x'])
    for (const [i, bad] of ['{bad', '{}', 'null', '"x"', '42'].entries()) {
      localStorage.setItem('hjc-pinned-projects:mock:c' + i, bad)
      localStorage.setItem('hjc-recent-projects:mock:c' + i, bad)
      expect(getPinned('mock:c' + i)).toEqual([])
      expect(getRecent('mock:c' + i)).toEqual([])
    }
    localStorage.setItem('hjc-pinned-projects:mock:d', '[1,null,"p1","",{},"p1","p2"]')
    expect(getPinned('mock:d')).toEqual(['p1', 'p2'])
    togglePinned(null, 'x')
    expect(getPinned(null)).toEqual([])
  })
})
