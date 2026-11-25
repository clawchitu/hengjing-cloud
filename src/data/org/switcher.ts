// 侧栏项目切换器的纯函数（不依赖 React，单测直接覆盖）：每个项目的经销商名、搜索匹配、默认列表的分段。
// 规则（负责人 11/25 确认）：
// - 按项目 id 去重，每个项目只出现一次；「平台」不是分组（同一个项目属于「科希家研发」和平台建的集成项目时只列一次）；
// - 经销商账号：已置顶 → 最近使用（最多 5 个）→ 自己的全部项目，不按经销商 / 集成项目分组；
// - 平台账号：只列已置顶和最近使用，不列全量，靠搜索找；
// - 搜索按项目名称、项目 ID（code 与实体 id）、经销商名（全称、简称）匹配；界面上不显示 ID；
// - 离线项目照常列出、照常排序，不排到最后。
import { PLATFORM_DEALER_ID } from './map'
import { RECENT_SHOWN } from './prefs'
import type { Dealer, Project, Scope } from './types'

export interface DealerNames {
  /** 行副标题显示的经销商名 */
  label: Map<string, string>
  /** 搜索用：这个项目能匹配的全部经销商名（全称、简称、接口给的 distributor_name） */
  terms: Map<string, string[]>
}

/**
 * 每个项目的经销商名。显示优先用接口的 distributor_name；没有就取包含它的集成项目里第一个真实经销商的简称；
 * 只在平台建的集成项目里为「平台」；都没有为空串。
 */
export function dealerNames(scope: Pick<Scope, 'dealers' | 'groups' | 'projects'>): DealerNames {
  const byId = new Map<string, Dealer>(scope.dealers.map((d) => [d.id, d]))
  const of = new Map<string, Dealer[]>()
  const inPlatform = new Set<string>()
  for (const g of scope.groups) {
    if (g.dealerId === PLATFORM_DEALER_ID) { for (const id of g.projectIds) inPlatform.add(id); continue }
    const d = byId.get(g.dealerId)
    if (!d) continue
    for (const id of g.projectIds) {
      const arr = of.get(id) ?? []
      if (!arr.includes(d)) arr.push(d)
      of.set(id, arr)
    }
  }
  const label = new Map<string, string>()
  const terms = new Map<string, string[]>()
  for (const p of scope.projects) {
    const ds = of.get(p.id) ?? []
    const first = ds.find((d) => d.short || d.name)
    const name = (p.distributorName ?? '').trim() || (first ? first.short || first.name : '') || (inPlatform.has(p.id) ? '平台' : '')
    label.set(p.id, name)
    terms.set(p.id, [...new Set([p.distributorName ?? '', ...ds.flatMap((d) => [d.name, d.short]), inPlatform.has(p.id) ? '平台' : ''].map((s) => s.trim()).filter(Boolean))])
  }
  return { label, terms }
}

/** 按 id 去重，保持第一次出现的顺序 */
export function uniqueById<T extends { id: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>()
  return list.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
}

const norm = (s: string) => s.trim().toLowerCase()

/** 项目名称、项目 ID（code 与实体 id）、经销商名任一包含关键词（不区分大小写） */
export function matchProject(p: Pick<Project, 'id' | 'code' | 'name'>, dealerTerms: readonly string[], q: string): boolean {
  const s = norm(q)
  if (!s) return true
  return [p.name, p.code, p.id, ...dealerTerms].some((v) => !!v && v.toLowerCase().includes(s))
}

/** 搜索结果：可见项目里匹配的，去重，保持项目列表顺序（离线不排后） */
export function searchProjects(projects: readonly Project[], names: Pick<DealerNames, 'terms'>, q: string): Project[] {
  if (!norm(q)) return []
  return uniqueById(projects).filter((p) => matchProject(p, names.terms.get(p.id) ?? [], q))
}

export type SectionKey = 'pinned' | 'recent' | 'all'
export interface SwitchSection { key: SectionKey; label: string; rows: Project[] }

export const SECTION_LABEL: Record<SectionKey, string> = { pinned: '已置顶', recent: '最近使用', all: '全部项目' }

/**
 * 不搜索时的默认列表。pinned、recent 是存储里的 id 顺序（不可见的跳过）；每个项目只出现在第一个包含它的分段里。
 * 空分段不返回。
 */
export function defaultSections(opts: { projects: readonly Project[]; recent: readonly string[]; pinned: readonly string[]; dealerAccount: boolean }): SwitchSection[] {
  const all = uniqueById(opts.projects)
  const byId = new Map(all.map((p) => [p.id, p]))
  const used = new Set<string>()
  const take = (ids: readonly string[], limit = Infinity) => {
    const out: Project[] = []
    for (const id of ids) {
      if (out.length >= limit) break
      const p = byId.get(id)
      if (!p || used.has(id)) continue
      used.add(id)
      out.push(p)
    }
    return out
  }
  const out: SwitchSection[] = [
    { key: 'pinned', label: SECTION_LABEL.pinned, rows: take(opts.pinned) },
    { key: 'recent', label: SECTION_LABEL.recent, rows: take(opts.recent, RECENT_SHOWN) },
  ]
  if (opts.dealerAccount) out.push({ key: 'all', label: SECTION_LABEL.all, rows: take(all.map((p) => p.id)) })
  return out.filter((s) => s.rows.length)
}
