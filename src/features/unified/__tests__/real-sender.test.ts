// 真实下发链路：createUnifiedBatch → 默认写入口 defaultBatchSender → sendUnifiedCtrls（unified-ctrls-send）→ encodeWrite（最后防线）→ requestWrite → fetch，
// 之后按 batch_id 轮询 unified-ctrls-records（后端 11/26 08:43：统一控制改走批量接口，203 不写记录）。
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

  const sendOk = () => json({ batch_id: 'B1', total: 1 })
  const rec = (result: unknown, message = '') => () => json({ records: [{ id: 'r1', batch_id: 'B1', project_id: P.id, project_code: P.code, result, message }], total: '1' })
  const run = async (routes: Parameters<typeof fakeBackend>[0], snap = { rooms: 2, roomSwitch: 1, roomTemp: 26 }) => {
    const be = fakeBackend(routes)
    const batch = createUnifiedBatch({ getProjects: () => [P], send: defaultBatchSender, log: () => {}, readBack: async () => snap })
    expect(batch.prepare([P.id], { systemSwitch: 0 }).phase).toBe('confirming')
    return { be, done: await batch.start() }
  }

  it('系统开关「关闭」（0 是明确改动）：只发 unified-ctrls-send 一次（不调 203），请求体只有 project_ids、body，线上解码 systemSwitch=0，其余不变；记录成功 → 已下发', async () => {
    const { be, done } = await run({ '/ctrl/unified-ctrls-send': sendOk, '/ctrl/unified-ctrls-records': rec(2) })
    expect(done.rows[0].replyOk).toBe(true)
    expect(be.callsTo('/ctrl/unified-ctrl-set')).toHaveLength(0)
    const calls = be.callsTo('/ctrl/unified-ctrls-send')
    expect(calls).toHaveLength(1)
    const body = calls[0].body as { project_ids: string[]; body: string }
    expect(Object.keys(body).sort()).toEqual(['body', 'project_ids'])
    expect(body.project_ids).toEqual([P.id])
    expect(decodeReply(pb.UnifiedCtrlSetQuerySchema, body.body)).toEqual({ systemSwitch: 0, systemMode: 0, roomSwitch: -1, roomTemp: -1 })
    // 记录按这次的 batch_id 查
    expect(be.callsTo('/ctrl/unified-ctrls-records')[0].body).toEqual({ batch_id: 'B1' })
    // 系统开关没有回读：记录成功也只到「无法核对」，不报已生效
    expect(done.rows[0].status).toBe('unverifiable')
  })

  it('记录「失败」→ 失败（明确被拒），明细带记录的 message', async () => {
    const { done } = await run({ '/ctrl/unified-ctrls-send': sendOk, '/ctrl/unified-ctrls-records': rec(3, '控制屏忙') })
    expect(done.rows[0].status).toBe('failure')
    expect(done.rows[0].replyOk).toBe(false)
    expect(JSON.stringify(done.rows[0].state)).toContain('执行记录：失败（控制屏忙）')
  })

  it.each([
    ['记录「超时」', { '/ctrl/unified-ctrls-send': sendOk, '/ctrl/unified-ctrls-records': rec(4) }, '执行记录为「超时」'],
    ['记录查询 403', { '/ctrl/unified-ctrls-send': sendOk }, '无执行记录查询权限'],
    ['send 200 但没有 batch_id（不查记录）', { '/ctrl/unified-ctrls-send': () => json({ total: 1 }) }, '未返回批次号'],
  ])('%s → 结果未知（不是失败、不是未下发）', async (_n, routes, note) => {
    const { be, done } = await run(routes as Parameters<typeof fakeBackend>[0])
    expect(done.rows[0].status).toBe('unknown')
    expect(JSON.stringify(done.rows[0].state)).toContain(note)
    expect(be.callsTo('/ctrl/unified-ctrls-send')).toHaveLength(1)
  })
})
