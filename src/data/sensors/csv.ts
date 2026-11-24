// 导出 CSV 的工具（纯函数）：单元格转义、公式前缀防护、文件名清理。

/** 文本、数字，或带固定小数位的数字（按数值输出，不做公式防护） */
export type CsvCell = string | number | { num: number; digits: number }

/**
 * 单元格：数字（含 { num, digits }）原样输出，负数仍是数值、不加前缀；文本以 = + - @ 制表符 回车 开头时前面加 '，防止 Excel 当公式执行；
 * 含逗号、双引号、换行（\n 或单独的 \r）时加引号并把引号加倍。
 */
export function csvCell(v: CsvCell): string {
  if (typeof v === 'object') return Number.isFinite(v.num) ? v.num.toFixed(v.digits) : ''
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 多行 → CSV 文本（带 BOM，Excel 直接打开不乱码；CRLF 换行） */
export const toCsv = (lines: readonly (readonly CsvCell[])[]) => '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n')

/** 文件名：去掉路径分隔符、Windows 保留字符、控制字符，压缩空白，限制长度（不含扩展名） */
export function safeFileName(base: string, ext: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  return `${[...(clean || '导出')].slice(0, max).join('')}.${ext}`
}
