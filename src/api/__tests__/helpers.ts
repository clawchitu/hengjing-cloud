// 测试用的假后端：按路径返回响应，并记录每次请求。不连任何真实后端。
import { vi } from 'vitest'
import { sealWriteBody, type WriteOp } from '../guard'

export interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
type Handler = (call: Call, n: number) => Response | Promise<Response>

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
export const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

export function fakeBackend(routes: Record<string, Handler>) {
  const calls: Call[] = []
  const counts: Record<string, number> = {}
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input, 'http://x').pathname.replace(/^\/api/, '')
    const call: Call = {
      url: input,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    counts[path] = (counts[path] ?? 0) + 1
    const h = routes[path]
    if (!h) return text('no permission', 403)
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return h(call, counts[path])
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, counts, fetchMock, callsTo: (p: string) => calls.filter((c) => c.url.endsWith(p)) }
}

/** 直接测 requestWrite 时用：模拟 encodeWrite 校验过并登记的 body（requestWrite 只发登记过的 body）。默认 'CAE=' = 字段 #1 为 1 */
export function sealedBody(op: WriteOp, body = 'CAE='): string {
  sealWriteBody(op, body)
  return body
}
