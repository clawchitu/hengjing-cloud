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

const CTX: UnifiedContext = { projectId: 'p-test-0829-000001', projectCode: '240829001', appCode: 1, online: true }
const ok = () => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success: true }) })

beforeEach(() => {
  __resetHttpForTests(); clearTokens()
  writeTokens({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
  setCurrentUserId('u1')
})
afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

describe('默认下发经统一写入口', () => {
  it('打到 /ctrl/unified-ctrl-set，Query 不改的字段编码后为 -1，只发一次', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok })
    const ctl = createUnifiedController({ getContext: () => CTX, readBack: async () => ({}), log: () => {} })
    ctl.request({ roomTemp: 25.5 })
    expect(await ctl.confirm()).toMatchObject({ status: 'success' })
    expect(be.calls).toHaveLength(1)
    const body = be.calls[0].body as { project_id: string; user_id: string; body: string }
    expect(be.calls[0].url).toBe('/api/ctrl/unified-ctrl-set')
    expect(body.project_id).toBe(CTX.projectId)
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: -1, systemMode: 0, roomSwitch: -1, roomTemp: 25.5 })
  })

  it('写防护拦截（writeMode=off / 不在名单）→ not-sent，没有任何请求', async () => {
    for (const cfg of [{ writeMode: 'off' as const }, { writeProjectIds: ['someone-else'] }]) {
      setConfig({ apiBase: '/api', apiEnv: 'test', ...cfg })
      const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok })
      const ctl = createUnifiedController({ getContext: () => CTX, readBack: async () => ({}), log: () => {} })
      ctl.request({ roomSwitch: 1 })
      expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'not-sent' })
      expect(be.calls).toHaveLength(0)
    }
  })

  it('生产环境默认拦截', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'prod' })
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': ok })
    await expect(defaultSender(CTX.projectId, { systemSwitch: 1, systemMode: 0, roomSwitch: -1, roomTemp: -1 })).rejects.toMatchObject({ kind: 'write_blocked' })
    expect(be.calls).toHaveLength(0)
  })

  it('控制屏 success=false → rejected，不重发', async () => {
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': () => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success: false, msg: '控制屏忙' }) }) })
    const ctl = createUnifiedController({ getContext: () => CTX, readBack: async () => ({}), log: () => {} })
    ctl.request({ roomSwitch: 1 })
    expect(await ctl.confirm()).toMatchObject({ status: 'failure', outcome: 'rejected', error: expect.stringContaining('控制屏忙') })
    expect(be.calls).toHaveLength(1)
  })
})

describe('bindUnifiedControl（hook 的依赖绑定）', () => {
  it('确认时用的是最新注入的项目信息与函数', async () => {
    const send1 = vi.fn(async () => ({ success: true, msg: '' }))
    const send2 = vi.fn(async () => ({ success: true, msg: '' }))
    const { ctl, update } = bindUnifiedControl({ context: CTX, readBack: async () => 1, send: send1, log: () => {} })
    ctl.request({ roomSwitch: 1 })
    update({ context: { ...CTX, online: false }, readBack: async () => 1, send: send2, log: () => {} })
    expect(await ctl.confirm()).toMatchObject({ status: 'idle', errors: ['项目离线，不能下发'] })
    update({ context: CTX, readBack: async () => 1, send: send2, log: () => {} })
    ctl.request({ roomSwitch: 1 })
    await ctl.confirm()
    expect(send1).not.toHaveBeenCalled()
    expect(send2).toHaveBeenCalledTimes(1)
  })
})
