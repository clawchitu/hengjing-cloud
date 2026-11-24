import { describe, expect, it } from 'vitest'
import { dealers, groups, projects, users } from './org'

describe('mock 组织数据冒烟', () => {
  it('两个演示账号角色正确', () => {
    expect(users.cosyhome.role).toBe('dealer')
    expect(users.hjadmin.role).toBe('admin')
  })

  it('项目都能追溯到集成项目和经销商', () => {
    const gids = new Set(groups.map((g) => g.id))
    const dids = new Set(dealers.map((d) => d.id))
    expect(projects.length).toBeGreaterThan(0)
    for (const p of projects) expect(gids.has(p.groupId)).toBe(true)
    for (const g of groups) expect(dids.has(g.dealerId)).toBe(true)
  })
})
