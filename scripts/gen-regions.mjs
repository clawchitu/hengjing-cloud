#!/usr/bin/env node
// 生成行政区划名称表 src/data/region/regions.data.ts（省 → 地级 → 区县三级，只有名称，供「区域」列把区划码转成文字）。
//
// 数据来源：modood/Administrative-divisions-of-China 的 dist/pca-code.json，与 gen-weather-cities.mjs 固定同一个 COMMIT。
// 用法：
//   node scripts/gen-regions.mjs              # 从 GitHub 按 COMMIT 下载
//   node scripts/gen-regions.mjs <数据目录>    # 用本地已下载的 pca-code.json（须是同一 commit）
//
// 精简格式（一个字符串，页面按需 import() 再解析，不进首屏包）：
//   每个省一行：「省码2位 省名」，后面每个地级单位用 | 隔开：「市码后2位 市名」，再用 : 接区县，区县之间用 , 隔开：「区县码后2位 区县名」。
//   例：32江苏省|05苏州市:06吴中区,07相城区|…
//   「市辖区」「县」「省直辖县级行政区划」这类占位名照原样保留，显示时由 regionText() 跳过。
//   东莞、中山、儋州、嘉峪关等不设区县的地级市，pca-code 里下一级是 9 位的乡镇街道码，丢掉（项目区划码只到 6 位）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT = 'c49d495b40ac73eb1a66f6eeae5f8fd10696f035'
const REPO = 'modood/Administrative-divisions-of-China'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/data/region/regions.data.ts')
const SEP = /[|:,\n`$\\]/

async function load(name, dir) {
  if (dir) return JSON.parse(readFileSync(join(dir, name), 'utf8'))
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/dist/${name}`)
  if (!r.ok) throw new Error(`下载 ${name} 失败：HTTP ${r.status}`)
  return r.json()
}

const tree = await load('pca-code.json', process.argv[2])
const tail = (node, len, parent) => {
  if (node.code.length !== len || !node.code.startsWith(parent)) throw new Error(`码 ${node.code} 层级不对（父级 ${parent}）`)
  if (SEP.test(node.name)) throw new Error(`名称 ${node.name} 含分隔符`)
  return node.code.slice(-2) + node.name
}
let nP = 0, nC = 0, nA = 0
const lines = tree.map((p) => {
  nP++
  const cities = (p.children ?? []).map((c) => {
    nC++
    const areas = (c.children ?? []).filter((a) => a.code.length !== 9).map((a) => { nA++; return tail(a, 6, c.code) })
    return tail(c, 4, p.code) + (areas.length ? ':' + areas.join(',') : '')
  })
  return [tail(p, 2, ''), ...cities].join('|')
})
const data = lines.join('\n')
const body = `// 本文件由 scripts/gen-regions.mjs 生成，不要手改；重新生成：node scripts/gen-regions.mjs
// 数据来源：${REPO} dist/pca-code.json，commit ${COMMIT}
// 省级 ${nP} 个，地级 ${nC} 个（含「市辖区」等占位），区县 ${nA} 个。格式见生成脚本开头的说明。
export const REGION_SOURCE = { repo: '${REPO}', commit: '${COMMIT}' } as const

export const REGION_DATA = \`${data}\`
`
writeFileSync(OUT, body)
console.log(`已生成 ${OUT}：省 ${nP}，地级 ${nC}，区县 ${nA}，${Buffer.byteLength(body)} 字节`)
