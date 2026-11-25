// @vitest-environment jsdom
// 默认城市和本地存储（按账号隔离）
import { beforeEach, describe, expect, it } from 'vitest'
import { cityKeyOf, readCity, writeCity } from '..'

beforeEach(() => localStorage.clear())

describe('城市选择的存储', () => {
  it('没选过就是无锡；未登录也是无锡', () => {
    expect(readCity('user:a').code).toBe('320200')
    expect(readCity(null).code).toBe('320200')
  })

  it('选过的城市下次读到；键带账号维度', () => {
    expect(writeCity('user:a', '110000')).toBe(true)
    expect(localStorage.getItem('hjc-weather-city:user:a')).toBe(JSON.stringify({ code: '110000' }))
    expect(cityKeyOf('user:a')).toBe('hjc-weather-city:user:a')
    expect(readCity('user:a')).toEqual({ code: '110000', name: '北京市' })
  })

  it('按账号隔离：A 选的城市 B 看不到，B 选了也不影响 A', () => {
    writeCity('user:a', '310000')
    expect(readCity('user:b').code).toBe('320200')
    writeCity('user:b', '532900')
    expect(readCity('user:a').code).toBe('310000')
    expect(readCity('user:b')).toEqual({ code: '532900', name: '大理白族自治州', queryBy: 'name' })
    expect(readCity('mock:a').code).toBe('320200')
  })

  it('存储损坏、结构不对、编码不在城市文件里，都回退无锡', () => {
    for (const raw of ['{', 'null', '"320500"', '[]', '{"code":110100}', '{"code":"110100"}', '{"code":"999999"}', '{}']) {
      localStorage.setItem(cityKeyOf('user:a'), raw)
      expect(readCity('user:a').code, raw).toBe('320200')
    }
  })

  it('不在城市文件里的编码、未登录都不写', () => {
    expect(writeCity('user:a', '110100')).toBe(false)
    expect(writeCity(null, '110000')).toBe(false)
    expect(localStorage.length).toBe(0)
  })
})
