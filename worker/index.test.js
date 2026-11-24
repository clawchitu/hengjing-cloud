import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { upstreamUrl, UPSTREAM_TIMEOUT_MS } from './index.js'

const UP = 'https://test.cosyhome.com.cn:9443/v1'
const SITE = 'https://hvac-demo.haoqianglyu.com'
const realEnv = (extra = {}) => ({ DATA_SOURCE: 'real', API_UPSTREAM: UP, ASSETS: assets(), ...extra })
const mockEnv = (extra = {}) => ({ DATA_SOURCE: 'mock', BASIC_PASS: 'b-pass', ADMIN_PASS: 'a-pass', ASSETS: assets(), ...extra })

function assets() {
  return { fetch: vi.fn(async () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })) }
}

/** 替换全局 fetch，记录发给上游的请求 */
function stubUpstream(respond = () => new Response('{"ok":1}', { status: 200, headers: { 'Content-Type': 'application/json' } })) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (target, init) => {
    calls.push({ url: String(target), init, body: init.body ? await new Response(init.body).text() : undefined })
    return respond(target, init)
  }))
  return calls
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('路径改写', () => {
  it('/api/auth/login → 上游 /v1/auth/login，保留查询串', () => {
    expect(upstreamUrl(UP, new URL(SITE + '/api/auth/login')).href).toBe(UP + '/auth/login')
    expect(upstreamUrl(UP, new URL(SITE + '/api/me?x=1&y=2')).href).toBe(UP + '/me?x=1&y=2')
    expect(upstreamUrl(UP, new URL(SITE + '/api/ctrl/projects')).href).toBe(UP + '/ctrl/projects')
  })

  it('越出上游 /v1/ 前缀、编码分隔符、反斜杠一律拒绝', () => {
    for (const p of ['/api', '/api/', '/api/%2e%2e/admin', '/api/%2E%2E/%2e%2e/x', '/api/.%2e/x',
      '/api/%2F..%2F..%2Fadmin', '/api/..%2fadmin', '/api/%5c..%5cx', '/api/me%2Fx', '/api/a%2Eb', '/api/a%5Cb']) {
      expect(upstreamUrl(UP, new URL(SITE + p)), p).toBeNull()
    }
    // //evil.com 拼在上游路径后面仍是上游主机
    expect(upstreamUrl(UP, new URL(SITE + '/api//evil.com/x')).origin).toBe('https://test.cosyhome.com.cn:9443')
  })

  it('转发请求：方法、Authorization、Content-Type、请求体原样，其他头不转', async () => {
    const calls = stubUpstream()
    const body = JSON.stringify({ mobile: '1', password: 'p', isdp: true })
    const res = await worker.fetch(new Request(SITE + '/api/auth/login', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer t0k', Cookie: 'a=b', Origin: SITE, 'X-Other': '1' },
    }), realEnv())
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const [c] = calls
    expect(c.url).toBe(UP + '/auth/login')
    expect(c.init.method).toBe('POST')
    expect(c.init.redirect).toBe('manual')
    expect(c.init.signal).toBeInstanceOf(AbortSignal)
    expect(c.body).toBe(body)
    const h = c.init.headers
    expect(h.get('authorization')).toBe('Bearer t0k')
    expect(h.get('content-type')).toBe('application/json')
    expect(h.get('accept')).toBeNull()
    expect(h.get('cookie')).toBeNull()
    expect(h.get('origin')).toBeNull()
    expect(h.get('x-other')).toBeNull()
  })

  it('GET 不带请求体', async () => {
    const calls = stubUpstream()
    await worker.fetch(new Request(SITE + '/api/me', { headers: { Authorization: 'Bearer t' } }), realEnv())
    expect(calls[0].url).toBe(UP + '/me')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()
  })
})

describe('方法与编码路径', () => {
  it('编码分隔符的请求 404，不发请求', async () => {
    for (const p of ['/api/%2F..%2F..%2Fadmin', '/api/..%2fadmin', '/api/%5c..%5cx']) {
      const calls = stubUpstream()
      expect((await worker.fetch(new Request(SITE + p), realEnv())).status, p).toBe(404)
      expect(calls).toHaveLength(0)
    }
  })

  it('除 GET / HEAD / POST 外一律 405，不发请求', async () => {
    for (const m of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const calls = stubUpstream()
      const res = await worker.fetch(new Request(SITE + '/api/me', { method: m }), realEnv())
      expect(res.status, m).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD, POST')
      expect(calls).toHaveLength(0)
    }
  })

  it('HEAD 转发且不带请求体', async () => {
    const calls = stubUpstream(() => new Response(null, { status: 200 }))
    const res = await worker.fetch(new Request(SITE + '/api/me', { method: 'HEAD' }), realEnv())
    expect(res.status).toBe(200)
    expect(calls[0].init.method).toBe('HEAD')
    expect(calls[0].init.body).toBeUndefined()
  })

  it('上游 3xx 透传状态码，但不带 Location', async () => {
    stubUpstream(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }))
    const res = await worker.fetch(new Request(SITE + '/api/me'), realEnv())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('非 /api 路径不转发', () => {
  for (const p of ['/', '/login', '/apix', '/api-docs', '/assets/a.js', '/v1/me']) {
    it(p, async () => {
      const calls = stubUpstream()
      const env = realEnv()
      const res = await worker.fetch(new Request(SITE + p), env)
      expect(calls).toHaveLength(0)
      expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
      expect(res.status).toBe(200)
    })
  }

  it('演示站（mock）的 /api/* 不转发；/api/login 走演示账号', async () => {
    const calls = stubUpstream()
    const env = mockEnv()
    expect((await worker.fetch(new Request(SITE + '/api/me'), env)).status).toBe(404)
    const ok = await worker.fetch(new Request(SITE + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'hjadmin', password: 'a-pass' }) }), env)
    expect(await ok.json()).toEqual({ ok: true, role: 'admin', username: 'hjadmin' })
    const bad = await worker.fetch(new Request(SITE + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'hjadmin', password: 'x' }) }), env)
    expect(bad.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('真实接口站没有演示账号：/api/login 转发给上游，不校验演示密码', async () => {
    const calls = stubUpstream(() => new Response('{"code":5}', { status: 404 }))
    const res = await worker.fetch(new Request(SITE + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'hjadmin', password: 'a-pass' }) }), realEnv({ ADMIN_PASS: 'a-pass' }))
    expect(res.status).toBe(404)
    expect(calls[0].url).toBe(UP + '/login')
  })

  it('未配置 DATA_SOURCE 按演示站处理，不转发', async () => {
    const calls = stubUpstream()
    await worker.fetch(new Request(SITE + '/api/me'), { API_UPSTREAM: UP, ASSETS: assets() })
    expect(calls).toHaveLength(0)
  })
})

describe('上游响应与错误', () => {
  for (const [status, body] of [[401, '{"code":16,"message":"token expired"}'], [403, '{"code":7,"message":"token err"}'], [500, '{"code":13,"message":"经销商未配置集成功能"}'], [503, '{"code":14}'], [504, '{"code":4}']]) {
    it(`上游 ${status} 原样透传状态码和响应体`, async () => {
      stubUpstream(() => new Response(body, { status, headers: { 'Content-Type': 'application/json' } }))
      const res = await worker.fetch(new Request(SITE + '/api/me', { headers: { Authorization: 'Bearer t' } }), realEnv())
      expect(res.status).toBe(status)
      expect(await res.text()).toBe(body)
      expect(res.headers.get('content-type')).toBe('application/json')
    })
  }

  it('去掉 Set-Cookie、CORS 头、Location、指纹头，加 no-store、nosniff、CSP sandbox', async () => {
    stubUpstream(() => new Response('<html>x</html>', { status: 404, headers: { 'Content-Type': 'text/html', 'Set-Cookie': 's=1', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true', Location: 'https://evil/', Server: 'nginx/1.2', 'X-Powered-By': 'Go' } }))
    const res = await worker.fetch(new Request(SITE + '/api/me'), realEnv())
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('server')).toBeNull()
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
  })

  it('上游超时 → 504；连接失败 → 502', async () => {
    stubUpstream(() => { throw new DOMException('timeout', 'TimeoutError') })
    expect((await worker.fetch(new Request(SITE + '/api/me'), realEnv())).status).toBe(504)
    stubUpstream(() => { throw new TypeError('network') })
    const bad = await worker.fetch(new Request(SITE + '/api/me'), realEnv())
    expect(bad.status).toBe(502)
    // 不带 gRPC 码，前端不会误判为 14 控制屏未连接
    expect((await bad.json()).code).toBeUndefined()
    expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(12_000)
  })
})

describe('防开放代理与跨站', () => {
  it('API_UPSTREAM 不在允许列表 → 500，不发请求', async () => {
    for (const up of ['https://evil.example/v1', 'https://int.cosyhome.com.cn/v1', undefined, UP + '/']) {
      const calls = stubUpstream()
      const res = await worker.fetch(new Request(SITE + '/api/me'), realEnv({ API_UPSTREAM: up }))
      expect(res.status).toBe(500)
      expect(calls).toHaveLength(0)
    }
  })

  it('跨站 Origin / Sec-Fetch-Site 拒绝；同源放行；不带任何 CORS 头', async () => {
    const calls = stubUpstream()
    const cross = await worker.fetch(new Request(SITE + '/api/me', { headers: { Origin: 'https://evil.example' } }), realEnv())
    expect(cross.status).toBe(403)
    const sameSite = await worker.fetch(new Request(SITE + '/api/me', { headers: { 'Sec-Fetch-Site': 'same-site' } }), realEnv())
    expect(sameSite.status).toBe(403)
    const pre = await worker.fetch(new Request(SITE + '/api/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }), realEnv())
    expect(pre.status).toBe(405)
    expect(pre.headers.get('access-control-allow-origin')).toBeNull()
    expect(calls).toHaveLength(0)
    const same = await worker.fetch(new Request(SITE + '/api/me', { headers: { Origin: SITE, 'Sec-Fetch-Site': 'same-origin' } }), realEnv())
    expect(same.status).toBe(200)
    expect(same.headers.get('access-control-allow-origin')).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

describe('/config.js', () => {
  it('真实接口站生成 real + test 配置，不写白名单', async () => {
    const env = realEnv()
    const res = await worker.fetch(new Request(SITE + '/config.js'), env)
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    const cfg = JSON.parse(text.replace(/^window\.__HJC_CONFIG__ = /, ''))
    expect(cfg).toEqual({ apiBase: '/api', apiEnv: 'test', dataSource: 'real' })
    expect(text).not.toContain('writeProjectCodes')
  })

  it('演示站生成 mock 配置（不受构建变量影响）', async () => {
    const env = mockEnv()
    const text = await (await worker.fetch(new Request(SITE + '/config.js'), env)).text()
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
    expect(JSON.parse(text.replace(/^window\.__HJC_CONFIG__ = /, ''))).toEqual({ dataSource: 'mock' })
  })
})
