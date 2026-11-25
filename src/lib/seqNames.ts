// 界面只显示名称、不显示 id（S13 走查，负责人 11/25 定的全站规则）。同一列表里有同名项时，第 2 个起在名称后加「 (2)」「 (3)」区分。

/** 按列表顺序给同名项编号：key → 显示名 */
export function seqNames<T>(items: readonly T[], name: (t: T) => string, key: (t: T) => string): Map<string, string> {
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const t of items) {
    const k = key(t)
    if (out.has(k)) continue
    const n = name(t)
    const i = (seen.get(n) ?? 0) + 1
    seen.set(n, i)
    out.set(k, i > 1 ? `${n} (${i})` : n)
  }
  return out
}
