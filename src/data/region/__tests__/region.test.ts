import { describe, expect, it } from 'vitest'
import { loadRegionNames, parseRegions, regionText } from '..'
import { REGION_DATA } from '../regions.data'
import { toProject } from '../../org/map'

// 测试环境 /projects 433 个项目里出现过的全部 22 种 customer_region（11/25 实测）
const REAL = {
  '320000/320500/320506': '苏州市 吴中区', '110000/110100/110101': '北京市 东城区', '320000/320200/320206': '无锡市 惠山区',
  '310000/310100/310101': '上海市 黄浦区', '110000/110100/110108': '北京市 海淀区', '320000/320500': '苏州市',
  '110000/110100/110105': '北京市 朝阳区', '320000/320400/320402': '常州市 天宁区', '320000/320100/320102': '南京市 玄武区',
  '130000/130100/130102': '石家庄市 长安区', '120000/120100/120101': '天津市 和平区', '130000/130200/130202': '唐山市 路南区',
  '120000/120100': '天津市', '120000/120100/120118': '天津市 静海区', '130000/130300/130303': '秦皇岛市 山海关区',
  '130000/130300/130304': '秦皇岛市 北戴河区', '150000/150300/150304': '乌海市 乌达区', '140000/140400/140404': '长治市 上党区',
  '320000': '江苏省', '320000/320200': '无锡市', '340000/340100/340123': '合肥市 肥西县', '320000/320400/320404': '常州市 钟楼区',
}

const names = await loadRegionNames()

describe('regionText（区划码 → 区域文字）', () => {
  it('省、市、区县三级', () => {
    expect(regionText('320000', names)).toBe('江苏省')
    expect(regionText('320000/320200', names)).toBe('无锡市')
    expect(regionText('320000/320200/320281', names)).toBe('无锡市 江阴市')
    // 只给最细一级也行；12 位统计码取前 6 位
    expect(regionText('320506', names)).toBe('苏州市 吴中区')
    expect(regionText('320506000000', names)).toBe('苏州市 吴中区')
    expect(regionText(' 320000 / 320500 ', names)).toBe('苏州市')
  })

  it('直辖市和省直辖县级市：地级占位名换成省级名', () => {
    expect(regionText('110000', names)).toBe('北京市')
    expect(regionText('110000/110100', names)).toBe('北京市')
    expect(regionText('500000/500200/500229', names)).toBe('重庆市 城口县')
    expect(regionText('420000/429000/429004', names)).toBe('湖北省 仙桃市')
    // 不设区县的地级市
    expect(regionText('440000/441900', names)).toBe('东莞市')
  })

  it('查不到、格式不对、上下级对不上：原值加「（未知）」', () => {
    expect(regionText('320000/320500/320599', names)).toBe('320000/320500/320599（未知）')
    expect(regionText('990000', names)).toBe('990000（未知）')
    expect(regionText('320000/320500/110101', names)).toBe('320000/320500/110101（未知）')
    expect(regionText('江苏省', names)).toBe('江苏省（未知）')
    expect(regionText('3205', names)).toBe('3205（未知）')
  })

  it('空值返回空串；名称表没加载时原样返回码', () => {
    for (const v of [undefined, null, '', '  ', {}]) expect(regionText(v, names)).toBe('')
    expect(regionText('320000/320500', null)).toBe('320000/320500')
  })

  it('测试环境实测出现的全部区划码都能转成文字', () => {
    for (const [code, text] of Object.entries(REAL)) expect(regionText(code, names), code).toBe(text)
  })

  it('toProject 用 customer_region 生成 area', () => {
    expect(toProject({ id: 'a', customer_region: '320000/320500/320506' }, names).area).toBe('苏州市 吴中区')
    expect(toProject({ id: 'b' }, names).area).toBe('')
    expect(toProject({ id: 'c', customer_region: '320000/320500/320506' }).area).toBe('320000/320500/320506')
  })
})

describe('名称表', () => {
  it('解析格式：省 | 地级 : 区县', () => {
    const m = parseRegions('32江苏省|05苏州市:06吴中区,07相城区|02无锡市\n11北京市|01市辖区:01东城区')
    expect([...m]).toEqual([
      ['320000', '江苏省'], ['320500', '苏州市'], ['320506', '吴中区'], ['320507', '相城区'], ['320200', '无锡市'],
      ['110000', '北京市'], ['110100', '市辖区'], ['110101', '东城区'],
    ])
  })

  it('三级齐全、码唯一、体积在预算内', () => {
    const codes = [...names.keys()]
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true)
    expect(codes.filter((c) => c.endsWith('0000')).length).toBe(31)
    expect(codes.length).toBe(31 + 342 + 2974)
    expect(new Set(codes).size).toBe(codes.length)
    expect(REGION_DATA.length).toBeLessThan(25_000) // 字符数（UTF-8 约 46 KB）
  })
})
