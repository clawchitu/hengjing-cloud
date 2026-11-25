// 写路径守护（docs/plan-s10-s7.md S10c 测试要点）：新风功能里除了 source.ts 的 writeCtrl(204) 没有别的写调用；页面不直接调写入口；
// 204 只经 buildRunningCtrlSet 组装（edit.ts 的 build204）。按源码文本检查，防止以后绕过统一写入口或另起一处组装。
import { describe, expect, it } from 'vitest'

/** 去掉注释后的源码（注释里提到写入口不算调用） */
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
const RAW = import.meta.glob<string>('../*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })
const SOURCES = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k.replace('../', ''), strip(v)]))
const files = Object.keys(SOURCES).sort()
const src = (f: string) => SOURCES[f]
const page = strip(Object.values(import.meta.glob<string>('../../../pages/FreshAir.tsx', { query: '?raw', import: 'default', eager: true }))[0])
const WRITE_CALL = /\b(writeCtrl|requestWrite|sendUnifiedCtrls|fetch)\s*\(/g

describe('新风写路径', () => {
  it('读到了功能目录的源码（守护本身有效）', () => {
    expect(files).toEqual(expect.arrayContaining(['edit.ts', 'hooks.ts', 'lockVerify.ts', 'model.ts', 'source.ts', 'writes.ts']))
    expect(page).toMatch(/export default function FreshAir/)
  })
  it('写调用只有 source.ts 里一处 writeCtrl(204)', () => {
    const hits = files.flatMap((f) => [...src(f).matchAll(WRITE_CALL)].map((m) => `${f}:${m[1]}`))
    expect(hits).toEqual(['source.ts:writeCtrl'])
    expect(src('source.ts')).toMatch(/writeCtrl\(204, project, query, \{ beforeSend \}\)/)
  })
  it('204 只由 edit.ts 的 build204 经 buildRunningCtrlSet 组装', () => {
    const hits = files.filter((f) => /buildRunningCtrlSet\(/.test(src(f)))
    expect(hits).toEqual(['edit.ts'])
  })
  it('页面不直接调写入口，下发只经 runFreshAirSet', () => {
    expect(page.match(WRITE_CALL)).toBeNull()
    expect(page).not.toMatch(/setRunning\(/)
    expect(page).toMatch(/runFreshAirSet\(/)
  })
})
