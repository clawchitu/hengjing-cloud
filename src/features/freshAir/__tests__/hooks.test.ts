// @vitest-environment jsdom
// 新风 hooks 走真实 React 渲染（StrictMode）和真实数据源，后端是假后端（不连任何真实后端），回包用实测原文
import { StrictMode, createElement, type ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '@/api/auth'
import { setConfig } from '@/api/config'
import { __resetHttpForTests } from '@/api/http'
import { createQueryClient } from '@/api/query'
import { clearTokens, writeTokens } from '@/api/tokens'
import { fakeBackend, json } from '@/api/__tests__/helpers'
import { putNewer, useFreshRead, useSettings, useUnits } from '../hooks'
import { TEXT_UNSUPPORTED } from '../model'
import { ID_240829001, ID_260911001, R202_240829001, R202_260911001, R210_240829001, R210_260911001 } from './fixtures'

const perm = vi.hoisted(() => ({ allowed: new Set<string>(['/v1/ctrl/fresh-dehumidifier-get', '/v1/ctrl/running-ctrl-get']) }))
vi.mock('@/data/session', () => ({ can: (r: string) => perm.allowed.has(r) }))

const P12 = { id: '6aa3a0ade8f3372b86b15b05', online: true, programCode: 12 }
const P1 = { id: '66cfd7959fb60d63c917fd0a', online: true, programCode: 1 }
const R202 = '/ctrl/fresh-dehumidifier-get'
const R210 = '/ctrl/running-ctrl-get'

let qc: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, createElement(QueryClientProvider, { client: qc }, children))
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

beforeEach(() => {
  __resetHttpForTests()
  writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
  setCurrentUserId('u1')
  setConfig({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
  qc = createQueryClient()
  perm.allowed = new Set(['/v1/ctrl/fresh-dehumidifier-get', '/v1/ctrl/running-ctrl-get'])
})
afterEach(() => { qc.clear(); vi.unstubAllGlobals(); setConfig(null); clearTokens() })

describe('useUnits（202）', () => {
  it('没有项目、项目离线：不发请求', async () => {
    const be = fakeBackend({ [R202]: () => json({ body: R202_260911001 }) })
    const a = renderHook(() => useUnits(null), { wrapper })
    const b = renderHook(() => useUnits({ ...P12, online: false }), { wrapper })
    await flush()
    expect(a.result.current.kind).toBe('no-project')
    expect(b.result.current.kind).toBe('offline')
    expect(be.calls).toHaveLength(0)
  })
  it('没有权限：forbidden，不发请求', async () => {
    perm.allowed.delete('/v1/ctrl/fresh-dehumidifier-get')
    const be = fakeBackend({ [R202]: () => json({ body: R202_260911001 }) })
    const { result } = renderHook(() => useUnits(P12), { wrapper })
    await flush()
    expect(result.current.kind).toBe('forbidden')
    expect(be.calls).toHaveLength(0)
  })
  it('真实回包 → ready', async () => {
    fakeBackend({ [R202]: () => json({ body: R202_260911001 }) })
    const { result } = renderHook(() => useUnits(P12), { wrapper })
    await waitFor(() => expect(result.current.kind).toBe('ready'))
    expect(result.current).toMatchObject({ units: [{ deviceId: ID_260911001, connected: true }] })
  })
  it('有数据后控制屏 503：旧数据作废，返回 unavailable；恢复后回到 ready', async () => {
    let mode = 'ok'
    fakeBackend({ [R202]: () => (mode === 'ok' ? json({ body: R202_260911001 }) : json({ code: 14, message: '控制屏消息发送失败' }, 503)) })
    const { result } = renderHook(() => useUnits(P12), { wrapper })
    await waitFor(() => expect(result.current.kind).toBe('ready'))
    mode = '503'
    await act(async () => { if (result.current.kind === 'ready') result.current.retry() })
    await waitFor(() => expect(result.current.kind).toBe('unavailable'))
    mode = 'ok'
    await act(async () => { if (result.current.kind === 'unavailable') result.current.retry() })
    await waitFor(() => expect(result.current.kind).toBe('ready'))
  })
  it('首次 500（重试 1 次仍失败）→ error；空列表 → empty', async () => {
    const be = fakeBackend({ [R202]: () => json({ code: 13, message: 'x' }, 500) })
    const { result } = renderHook(() => useUnits(P12), { wrapper })
    await waitFor(() => expect(result.current.kind).toBe('error'), { timeout: 3000 })
    expect(be.callsTo(R202)).toHaveLength(2)
    fakeBackend({ [R202]: () => json({ body: '' }) })
    const e = renderHook(() => useUnits(P1), { wrapper })
    await waitFor(() => expect(e.result.current.kind).toBe('empty'))
  })
})

describe('useSettings（210）', () => {
  const unit = { deviceId: ID_260911001, connected: true }
  it('app_code 12：真实回包 → ready，字段带标注', async () => {
    const be = fakeBackend({ [R210]: () => json({ body: R210_260911001 }) })
    const { result } = renderHook(() => useSettings(P12, unit), { wrapper })
    await waitFor(() => expect(result.current.kind).toBe('ready'))
    expect(result.current).toMatchObject({ settings: { fields: { humiditySet: { state: 'unsettable' }, dewPoint: { state: 'settable', value: 13 } }, writeBlock: null } })
    expect(be.callsTo(R210)).toHaveLength(1)
  })
  it('非 12 项目不发 210；离线项目、设备未连接、设备 id 无效、无权限都不发', async () => {
    const be = fakeBackend({ [R210]: () => json({ body: R210_260911001 }) })
    const views = [
      renderHook(() => useSettings(P1, { deviceId: ID_240829001, connected: true }), { wrapper }),
      renderHook(() => useSettings({ ...P12, online: false }, unit), { wrapper }),
      renderHook(() => useSettings(P12, { deviceId: ID_260911001, connected: false }), { wrapper }),
      renderHook(() => useSettings(P12, { deviceId: null, connected: true }), { wrapper }),
      renderHook(() => useSettings(null, unit), { wrapper }),
    ]
    await flush()
    expect(views.map((v) => v.result.current.kind)).toEqual(['not-applicable', 'offline', 'device-offline', 'no-device', 'no-project'])
    perm.allowed.delete('/v1/ctrl/running-ctrl-get')
    const f = renderHook(() => useSettings(P12, unit), { wrapper })
    await flush()
    expect(f.result.current.kind).toBe('forbidden')
    expect(be.calls).toHaveLength(0)
  })
  it('「该软件类型不支持此控制」→ unsupported（该项目不支持新风控制），不重试、不算故障', async () => {
    const be = fakeBackend({ [R210]: () => json({ body: R210_240829001 }) })
    const { result } = renderHook(() => useSettings(P12, { deviceId: ID_240829001, connected: true }), { wrapper })
    await waitFor(() => expect(result.current.kind).toBe('unsupported'))
    expect(result.current).toEqual({ kind: 'unsupported', message: TEXT_UNSUPPORTED, detail: '该软件类型不支持此控制' })
    await flush()
    expect(be.callsTo(R210)).toHaveLength(1)
  })
  it('503 → unavailable；回包设备不符 → error', async () => {
    fakeBackend({ [R210]: () => json({ code: 14, message: '控制屏消息发送失败' }, 503) })
    const a = renderHook(() => useSettings(P12, unit), { wrapper })
    await waitFor(() => expect(a.result.current.kind).toBe('unavailable'))
    fakeBackend({ [R210]: () => json({ body: R210_260911001 }) })
    const b = renderHook(() => useSettings(P12, { deviceId: 42, connected: true }), { wrapper })
    await waitFor(() => expect(b.result.current.kind).toBe('error'))
  })
})

describe('useFreshRead（210 新读）', () => {
  it('defer 不写缓存，apply 后写入；旧序号不覆盖新序号', async () => {
    fakeBackend({ [R210]: () => json({ body: R210_260911001 }) })
    const { result } = renderHook(() => useFreshRead(P12), { wrapper })
    const key = ['ctrl', 210, P12.id, { deviceId: ID_260911001 }]
    const first = await result.current(ID_260911001, undefined, { defer: true })
    const second = await result.current(ID_260911001, undefined, { defer: true })
    expect(first.kind).toBe('ok')
    expect(qc.getQueryData(key)).toBeUndefined()
    expect(first.latest()).toBe(false)
    expect(second.latest()).toBe(true)
    second.apply()
    const seq = (qc.getQueryData(key) as { seq: number }).seq
    first.apply()
    expect((qc.getQueryData(key) as { seq: number }).seq).toBe(seq)
  })
  it('设备 id 无效：抛错，不发请求', async () => {
    const be = fakeBackend({ [R210]: () => json({ body: R210_260911001 }) })
    const { result } = renderHook(() => useFreshRead(P12), { wrapper })
    await expect(result.current(null)).rejects.toThrow('没有有效的新风设备 id')
    await expect(result.current(0)).rejects.toThrow()
    expect(be.calls).toHaveLength(0)
  })
  it('putNewer', () => {
    expect(putNewer({ seq: 5 }, { seq: 3 })).toEqual({ seq: 5 })
    expect(putNewer({ seq: 3 }, { seq: 5 })).toEqual({ seq: 5 })
    expect(putNewer(undefined, { seq: 1 })).toEqual({ seq: 1 })
  })
})
