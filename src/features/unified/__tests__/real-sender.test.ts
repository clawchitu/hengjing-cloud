// 真实下发链路：createUnifiedBatch → 默认写入口 defaultBatchSender → writeCtrl(203) → encodeWrite（最后防线）→ requestWrite → fetch。
// 只把 fetch 换成假后端（src/api/__tests__/helpers.ts），回读注入假的；不连任何真实后端。
// 钉住：用户明确选的 0（系统开关关）经过「明确字段」登记一路传到线上，不会被最后防线误拒。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentUserId } from '@/api/auth'
import { setConfig } from '@/api/config'
import { decodeReply, encodeMessage } from '@/api/ctrl'
import * as pb from '@/api/gen/ctrl200_pb.js'
import { __resetHttpForTests } from '@/api/http'
import { clearTokens, writeTokens } from '@/api/tokens'
import { __resetWriteLockForTests } from '@/api/writeLock'
import { fakeBackend, json } from '@/api/__tests__/helpers'
import { createUnifiedBatch, defaultBatchSender, type BatchProject } from '../batch'

const P: BatchProject = { id: '66cfd7959fb60d63c917fd0a', code: '240829001', name: '项目240829001', programCode: 1, online: true }

describe('统一控制真实下发链路（defaultBatchSender + 假后端）', () => {
  beforeEach(() => {
    __resetHttpForTests(); clearTokens()
    writeTokens({ accessToken: `h.${btoa(JSON.stringify({ sub: 'u1' }))}.s`, refreshToken: 'R1', expiresAt: Date.now() + 3600_000 })
    setCurrentUserId('u1')
    setConfig({ apiBase: '/api', apiEnv: 'test' })
    __resetWriteLockForTests(() => ({ user: 'u', gen: 1 }))
  })
  afterEach(() => { vi.unstubAllGlobals(); setConfig(null) })

  it('系统开关「关闭」（0 是明确改动）：请求发出，线上解码 systemSwitch=0，其余（含运行模式）为 -1', async () => {
    const be = fakeBackend({ '/ctrl/unified-ctrl-set': () => json({ body: encodeMessage(pb.UnifiedCtrlSetReplySchema, { success: true }) }) })
    const batch = createUnifiedBatch({
      getProjects: () => [P], send: defaultBatchSender, log: () => {},
      readBack: async () => ({ rooms: 2, roomSwitch: 1, roomTemp: 26 }),
    })
    expect(batch.prepare([P.id], { systemSwitch: 0 }).phase).toBe('confirming')
    const done = await batch.start()
    expect(done.rows[0].replyOk).toBe(true)
    const calls = be.callsTo('/ctrl/unified-ctrl-set')
    expect(calls).toHaveLength(1)
    const body = calls[0].body as { project_id: string; body: string }
    expect(body.project_id).toBe(P.id)
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: 0, systemMode: -1, roomSwitch: -1, roomTemp: -1 })
  })
})
