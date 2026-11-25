// 本地城市文件的完整性：对照 11/24 测试服实测覆盖表（docs/api/weather-coverage-1124.json）
import coverageRaw from '../../../../docs/api/weather-coverage-1124.json?raw'
import scriptRaw from '../../../../scripts/gen-weather-cities.mjs?raw'
import dataRaw from '../cities.data.ts?raw'
import { describe, expect, it } from 'vitest'
import { CITY_SOURCE, DEFAULT_CITY_CODE, PROVINCES, defaultCity, findCity, provinceOf, weatherQueryOf } from '..'

const coverage = JSON.parse(coverageRaw) as { cities: { code: string; name: string; verdict: 'adcode' | 'name_only' }[] }
const cities = PROVINCES.flatMap((p) => p.cities)
const MUNICIPALITIES = ['110000', '120000', '310000', '500000']

describe('城市文件', () => {
  it('337 个城市全在，且和实测覆盖表一一对应（码和名称都一致），没有多余、没有重复', () => {
    expect(coverage.cities).toHaveLength(337)
    expect(cities).toHaveLength(337)
    expect(new Set(cities.map((c) => c.code)).size).toBe(337)
    expect(cities.map((c) => [c.code, c.name]).sort()).toEqual(coverage.cities.map((c) => [c.code, c.name]).sort())
  })

  it('31 个省级单位，城市码都是 6 位、前两位与所在省一致', () => {
    expect(PROVINCES).toHaveLength(31)
    for (const p of PROVINCES) for (const c of p.cities) {
      expect(c.code).toMatch(/^\d{6}$/)
      expect(c.code.slice(0, 2)).toBe(p.code.slice(0, 2))
    }
  })

  it('直辖市各只有一条，用省级码；市级码（110100 等）和「市辖区」「县」「省直辖县级」占位都不在', () => {
    for (const code of MUNICIPALITIES) {
      const p = PROVINCES.find((x) => x.code === code)!
      expect(p.cities).toEqual([{ code, name: p.name }])
      expect(findCity(code.slice(0, 2) + '0100')).toBeNull()
    }
    expect(cities.filter((c) => /^(市辖区|县|省直辖县级行政区划|自治区直辖县级行政区划)$/.test(c.name))).toEqual([])
    expect(cities.filter((c) => c.code.endsWith('9000'))).toEqual([])
  })

  it('按名称查询的标记和实测一致：只有大理（532900）带，按名称查', () => {
    const marked = cities.filter((c) => c.queryBy !== undefined)
    expect(marked.map((c) => c.code)).toEqual(coverage.cities.filter((c) => c.verdict === 'name_only').map((c) => c.code))
    expect(marked).toEqual([{ code: '532900', name: '大理白族自治州', queryBy: 'name' }])
  })

  it('默认城市是无锡（320200），在城市文件里', () => {
    expect(DEFAULT_CITY_CODE).toBe('320200')
    expect(defaultCity()).toEqual({ code: '320200', name: '无锡市' })
    expect(provinceOf('320200')?.name).toBe('江苏省')
  })

  it('写明数据来源和 commit，并与生成脚本里固定的 commit 一致', () => {
    const script = scriptRaw
    const data = dataRaw
    expect(CITY_SOURCE.repo).toBe('modood/Administrative-divisions-of-China')
    expect(CITY_SOURCE.commit).toMatch(/^c49d495/)
    expect(script).toContain(`const COMMIT = '${CITY_SOURCE.commit}'`)
    expect(data).toContain(`commit ${CITY_SOURCE.commit}`)
    expect(data).toContain('scripts/gen-weather-cities.mjs')
  })
})

describe('查询参数', () => {
  it('按码查；带 queryBy=name 的按名称查；直辖市用省级码', () => {
    expect(weatherQueryOf(findCity('320200')!)).toBe('320200')
    expect(weatherQueryOf(findCity('532900')!)).toBe('大理白族自治州')
    expect(weatherQueryOf(findCity('110000')!)).toBe('110000')
    // 不写死特例：任何带标记的城市都按名称
    expect(weatherQueryOf({ code: '999900', name: '某城市', queryBy: 'name' })).toBe('某城市')
    expect(weatherQueryOf({ code: '532900', name: '大理白族自治州' })).toBe('532900')
  })

  it('337 个城市逐个：实测 adcode 的按码查，name_only 的按名称查', () => {
    for (const c of coverage.cities) expect(weatherQueryOf(findCity(c.code)!)).toBe(c.verdict === 'adcode' ? c.code : c.name)
  })
})
