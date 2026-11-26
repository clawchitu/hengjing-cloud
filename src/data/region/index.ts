// 行政区划码 → 名称（省 / 地级 / 区县三级，GB/T 2260 的 6 位码）。
// 名称表 regions.data.ts 由 scripts/gen-regions.mjs 生成（约 46 KB，gzip 约 20 KB），
// 只在取真实项目列表时 import() 按需加载、解析一次，不进首屏包；演示数据不加载它。
import type { RegionNames } from './text'

export { regionText, type RegionNames } from './text'

/** 解析生成脚本的精简格式（见 scripts/gen-regions.mjs 开头）为「6 位码 → 名称」 */
export function parseRegions(data: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of data.split('\n')) {
    if (!line) continue
    const [prov, ...cities] = line.split('|')
    const pc = prov.slice(0, 2)
    m.set(pc + '0000', prov.slice(2))
    for (const c of cities) {
      const [head, areas] = c.split(':')
      const cc = pc + head.slice(0, 2)
      m.set(cc + '00', head.slice(2))
      if (areas) for (const a of areas.split(',')) m.set(cc + a.slice(0, 2), a.slice(2))
    }
  }
  return m
}

let pending: Promise<RegionNames> | null = null
/** 加载并解析名称表（只加载一次；失败后下次调用重试） */
export function loadRegionNames(): Promise<RegionNames> {
  pending ??= import('./regions.data').then((d) => parseRegions(d.REGION_DATA)).catch((e: unknown) => { pending = null; throw e })
  return pending
}
