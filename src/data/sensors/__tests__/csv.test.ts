// 导出 CSV：转义（逗号、引号、\n、单独的 \r）、公式前缀防护（只对文本）、文件名清理与限长。
import { describe, expect, it } from 'vitest'
import { csvCell, safeFileName, toCsv } from '../csv'

describe('csvCell', () => {
  it('逗号、引号、换行、单独的回车都加引号，引号加倍', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('说"明"')).toBe('"说""明"""')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell('a\rb')).toBe('"a\rb"')
    expect(csvCell('普通')).toBe('普通')
  })

  it('文本以 = + - @ 制表符开头时加 \' 防公式；数字（含负数）原样', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\tx')).toBe("'\tx")
    expect(csvCell(-2.5)).toBe('-2.5')
    expect(csvCell(NaN)).toBe('')
  })

  it('toCsv：BOM + CRLF', () => {
    expect(toCsv([['a', 1], ['b', 2]])).toBe('﻿a,1\r\nb,2')
  })
})

describe('safeFileName', () => {
  it('去掉路径分隔符、保留字符和控制字符，限长', () => {
    expect(safeFileName('统计_a/b\\c:d*e?f"g<h>i|j\u0001k_24小时', 'csv')).toBe('统计_a_b_c_d_e_f_g_h_i_j_k_24小时.csv')
    expect(safeFileName('..', 'csv')).toBe('导出.csv')
    expect(safeFileName('长'.repeat(200), 'csv')).toBe('长'.repeat(80) + '.csv')
  })
})
