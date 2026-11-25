import { MODE_UNCHANGED } from '@/api/ctrl'
// 默认下发函数走 S4 统一写入口：writeCtrl(203) → requestWrite('ctrl-203') → guard.ts。
// fetch 用假后端替换，不连任何真实接口。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '@/api/auth'
import { decodeReply, encodeMessage } from '@/api/ctrl'
import { setConfig } from '@/api/config'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '@/api/http'
import { clearTokens, writeTokens } from '@/api/tokens'
import { fakeBackend, json } from '@/api/__tests__/helpers'
import { createUnifiedController, defaultSender } from '../machine'
import { bindUnifiedControl } from '../hooks'
import type { UnifiedContext } from '../rules'

// S6a 之后 projectId 是后端实体 id、projectCode 是 240829001 这种 code：白名单按 code，请求体用 id
const CTX: UnifiedContext = { projectId: '66cfd7959fb60d63c917fd0a', projectCode: '240829001', appCode: 1, online: true }
const ok = () => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success: true }) })

beforeEach(() => {
  __resetHttpForTests(); clearTokens()
  writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
  setCurrentUserId('u1')
})
afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

describe('默认下发经统一写入口', () => {
  it('打到 /ctrl/unified-ctrl-set，Query 不改的字段编码后为 -1，只发一次', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok })
    const ctl = createUnifiedController({ getContext: () => CTX, readBack: async () => ({}), toEcho: () => ({ roomTemp: 25.5, roomSwitch: 1 }), log: () => {} })
    ctl.request({ roomTemp: 25.5 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success' })
    expect(be.calls).toHaveLength(1)
    const body = be.calls[0].body as { project_id: string; user_id: string; body: string }
    expect(be.calls[0].url).toBe('/api/ctrl/unified-ctrl-set')
    expect(body.project_id).toBe(CTX.projectId)
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: -1, systemMode: MODE_UNCHANGED, roomSwitch: -1, roomTemp: 25.5 })
  })

  it('写防护拦截（writeMode=off / code 不在名单 / 名单为空 / 名单里写的是 id）→ not-sent，没有任何请求', async () => {
    for (const cfg of [{ writeMode: 'off' as const }, { writeProjectCodes: ['260911001'] }, { writeProjectCodes: [] }, { writeProjectCodes: [CTX.projectId] }]) {
      setConfig({ apiBase: '/api', apiEnv: 'test', ...cfg })
      const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok })
      const ctl = createUnifiedController({ getContext: () => CTX, readBack: async () => ({}), toEcho: () => ({ roomTemp: 25.5, roomSwitch: 1 }), log: () => {} })
      ctl.request({ roomSwitch: 1 })
      expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'not-sent' })
      expect(be.calls).toHaveLength(0)
    }
  })

  it('写防护拦截时日志只有代码，没有文案和完整项目 id', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test', writeProjectCodes: ['260911001'] })
    fakeBackend({})
    const logs: unknown[] = []
    const ctl = createUnifiedController({ getContext: () => CTX, readBack: async () => ({}), toEcho: () => ({}), log: (e) => logs.push(e) })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'not-sent', error: expect.stringContaining('项目不在下发名单内') })
    const text = JSON.stringify(logs)
    expect(text).toContain('NOT_SENT')
    expect(text).toContain('write_blocked')
    expect(text).not.toContain('项目不在下发名单内')
    expect(text).not.toContain(CTX.projectId)
  })

  it('项目 code 缺失或为空（上下文数据不全）→ not-sent，没有任何请求', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    for (const projectCode of ['', undefined as unknown as string]) {
      const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok })
      await expect(defaultSender({ id: CTX.projectId, code: projectCode }, { systemSwitch: 1, systemMode: MODE_UNCHANGED, roomSwitch: -1, roomTemp: -1 })).rejects.toMatchObject({ kind: 'write_blocked' })
      expect(be.calls).toHaveLength(0)
    }
  })

  it('生产环境默认拦截', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'prod' })
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok })
    await expect(defaultSender({ id: CTX.projectId, code: CTX.projectCode }, { systemSwitch: 1, systemMode: MODE_UNCHANGED, roomSwitch: -1, roomTemp: -1 })).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('控制屏 success=false → rejected，不重发', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': () => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success: false, msg: '控制屏忙' }) }) })
    const ctl = createUnifiedController({ getContext: () => CTX, readBack: async () => ({}), toEcho: () => ({}), log: () => {} })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'rejected', error: expect.stringContaining('控制屏忙') })
    expect(be.calls).toHaveLength(1)
  })
})

describe('bindUnifiedControl（hook 的依赖绑定）', () => {
  const base = { readBack: async () => 1, toEcho: () => ({ roomSwitch: 1 }), log: () => {} }

  it('确认时用的是最新注入的项目信息与函数', async () => {
    const send1 = vi.fn(async () => ({ success: true, msg: '' }))
    const send2 = vi.fn(async () => ({ success: true, msg: '' }))
    const { ctl, update } = bindUnifiedControl({ ...base, context: CTX, send: send1 })
    ctl.request({ roomSwitch: 1 })
    update({ ...base, context: { ...CTX, online: false }, send: send2 })
    expect(await ctl.confirm()).toMatchObject({ status: 'idle', errors: ['项目离线，不能下发'] })
    update({ ...base, context: CTX, send: send2 })
    ctl.request({ roomSwitch: 1 })
    await ctl.confirm()
    expect(send1).not.toHaveBeenCalled()
    expect(send2).toHaveBeenCalledTimes(1)
  })

  it('下发前读取期间切换项目（code 变了）：立即终止回 idle，读取完成后也不下发', async () => {
    let release!: (v: number) => void
    const send = vi.fn(async () => ({ success: true, msg: '' }))
    const readBack = vi.fn(() => new Promise<number>((r) => { release = r }))
    const { ctl, update } = bindUnifiedControl({ ...base, readBack, context: CTX, send })
    ctl.request({ roomSwitch: 1 })
    const p = ctl.confirm()
    update({ ...base, readBack, context: { ...CTX, projectId: 'p-test-0911-000001', projectCode: '260911001' }, send })
    expect(ctl.getState()).toMatchObject({ status: 'idle' })
    release(1)
    await p
    expect(send).not.toHaveBeenCalled()
  })

  it('卸载（unmount）后读取完成也不下发；项目没变的重渲染不终止', async () => {
    let release!: (v: number) => void
    const send = vi.fn(async () => ({ success: true, msg: '' }))
    const readBack = vi.fn(() => new Promise<number>((r) => { release = r }))
    const b = bindUnifiedControl({ ...base, readBack, context: CTX, send })
    b.ctl.request({ roomSwitch: 1 })
    const p = b.ctl.confirm()
    b.update({ ...base, readBack, context: { ...CTX }, send }) // 同一项目的新对象
    expect(b.ctl.getState()).toMatchObject({ status: 'sending' })
    b.unmount()
    expect(b.ctl.getState()).toMatchObject({ status: 'idle' })
    release(1)
    await p
    expect(send).not.toHaveBeenCalled()
  })
})
