#!/usr/bin/env node
// 生成首页天气的本地城市文件 src/features/weather/cities.data.ts（省 → 地级市两级）。
//
// 数据来源：modood/Administrative-divisions-of-China 的 dist/provinces.json + dist/cities.json，固定在下面的 COMMIT。
// 用法：
//   node scripts/gen-weather-cities.mjs                 # 从 GitHub 按 COMMIT 下载
//   node scripts/gen-weather-cities.mjs <数据目录>       # 用本地已下载的 provinces.json、cities.json（须是同一 commit）
// 换数据版本时改 COMMIT，重新生成，再跑 npm test（城市文件完整性用例会对照实测覆盖表）。
//
// 规则：
// - 只到地级市。「市辖区」「县」（直辖市下面的占位）和「省直辖县级行政区划」不算地级市，丢掉；
// - 直辖市（下面只有「市辖区」「县」的省级单位）只留一条，用省级码（110000）：实测 110100 等市级码查 /weather 是 500
//   （docs/api/实测记录-1125-新风天气.md 补充一节），省级码能查到；
// - 行政区划码查不到、只能按名称查的城市（scripts/weather-cities.overrides.json 的 queryByName）加 queryBy: 'name'。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT = 'c49d495b40ac73eb1a66f6eeae5f8fd10696f035'
const REPO = 'modood/Administrative-divisions-of-China'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/features/weather/cities.data.ts')
const PLACEHOLDER = /^(市辖区|县|省直辖县级行政区划|自治区直辖县级行政区划)$/

async function load(name, dir) {
  if (dir) return JSON.parse(readFileSync(join(dir, name), 'utf8'))
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/dist/${name}`)
  if (!r.ok) throw new Error(`下载 ${name} 失败：HTTP ${r.status}`)
  return r.json()
}

const dir = process.argv[2]
const provinces = await load('provinces.json', dir)
const cities = await load('cities.json', dir)
const overrides = JSON.parse(readFileSync(join(ROOT, 'scripts/weather-cities.overrides.json'), 'utf8'))
const byName = new Set(overrides.queryByName)

const pad = (c) => c.padEnd(6, '0')
const out = []
for (const p of provinces) {
  const subs = cities.filter((c) => c.provinceCode === p.code)
  if (subs.length === 0) throw new Error(`省份 ${p.name} 没有地级单位`)
  const real = subs.filter((c) => !PLACEHOLDER.test(c.name))
  const municipality = real.length === 0
  const list = municipality ? [{ code: pad(p.code), name: p.name }] : real.map((c) => ({ code: pad(c.code), name: c.name }))
  out.push({ code: pad(p.code), name: p.name, cities: list.map((c) => (byName.has(c.code) ? { ...c, queryBy: 'name' } : c)) })
}
const all = out.flatMap((p) => p.cities.map((c) => c.code))
for (const code of byName) if (!all.includes(code)) throw new Error(`overrides 里的 ${code} 不在城市数据里`)
if (new Set(all).size !== all.length) throw new Error('城市码有重复')

const fmt = (p) => `  { code: '${p.code}', name: '${p.name}', cities: [\n${p.cities.map((c) => `    ${JSON.stringify(c)},`).join('\n')}\n  ] },`
const body = `// 本文件由 scripts/gen-weather-cities.mjs 生成，不要手改；重新生成：node scripts/gen-weather-cities.mjs
// 数据来源：${REPO} dist/provinces.json + dist/cities.json，commit ${COMMIT}
// 省 ${out.length} 个，地级市（直辖市各 1 条，用省级码）${all.length} 个。queryBy: 'name' 表示 /weather 要按名称查。
import type { Province } from './cities'

export const CITY_SOURCE = { repo: '${REPO}', commit: '${COMMIT}' } as const

export const PROVINCES: readonly Province[] = [
${out.map(fmt).join('\n')}
]
`
writeFileSync(OUT, body)
console.log(`已生成 ${OUT}：省 ${out.length} 个，城市 ${all.length} 个`)
