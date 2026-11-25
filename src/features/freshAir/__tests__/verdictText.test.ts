// 四态文案只认 docs/分工.md 第 4 节的表：温控（S9，src/pages/Thermostat.tsx 的 VERDICT_TEXT）和新风（S10c，writes.ts 的 VERDICT_TEXT）
// 两份都必须与表一致，防止两处各改各的（抽成公共组件不在 #68 范围）。
import { describe, expect, it } from 'vitest'
import { VERDICT_TEXT } from '../writes'

const raw = (g: Record<string, string>) => Object.values(g)[0]
const DOC = raw(import.meta.glob<string>('/docs/分工.md', { query: '?raw', import: 'default', eager: true }))
const THERMO = raw(import.meta.glob<string>('/src/pages/Thermostat.tsx', { query: '?raw', import: 'default', eager: true }))
const STATE: Record<string, string> = { 已生效: 'applied', 未变化: 'unchanged', 无法核对: 'unverifiable', 结果未知: 'unknown' }

/** 分工第 4 节「界面文案」表：状态 → 文案 */
function docTable(): Record<string, string> {
  const sec = DOC.slice(DOC.indexOf('## 4.'), DOC.indexOf('\n## 5') > 0 ? DOC.indexOf('\n## 5') : undefined)
  const out: Record<string, string> = {}
  for (const m of sec.matchAll(/^\| (已生效|未变化|无法核对|结果未知) \| ([^|]+?) \|$/gm)) out[STATE[m[1]]] = m[2].trim()
  return out
}
/** Thermostat.tsx 里 VERDICT_TEXT 对象字面量的四个值 */
function thermoTable(): Record<string, string> {
  const body = THERMO.match(/const VERDICT_TEXT[^=]*=\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  return Object.fromEntries([...body.matchAll(/(applied|unchanged|unverifiable|unknown):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]))
}

describe('四态文案与分工第 4 节一致', () => {
  it('读到了分工表的四行', () => {
    expect(Object.keys(docTable()).sort()).toEqual(['applied', 'unchanged', 'unknown', 'unverifiable'])
  })
  it('新风 VERDICT_TEXT 等于表', () => {
    expect({ ...VERDICT_TEXT }).toEqual(docTable())
  })
  it('温控 VERDICT_TEXT 等于表', () => {
    expect(thermoTable()).toEqual(docTable())
  })
})
