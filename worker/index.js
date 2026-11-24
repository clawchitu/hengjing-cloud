// 恒境云 Cloudflare Worker：静态资源（SPA）+ 按站点模式处理 /api。
//
// 两个站共用这份代码，由 wrangler.toml 的 DATA_SOURCE 区分（见 docs/plan-v1.md 7.1）：
//   real（hvac-demo）：/api/* 转发到固定上游 API_UPSTREAM（只允许测试环境），/config.js 由这里生成
//                      （dataSource=real、apiEnv=test）。没有演示账号。
//   mock（hvac-mock）：演示数据版。/api/login 校验两个演示账号，不转发任何请求：
//     cosyhome → role "dealer"（经销商），密码 = BASIC_PASS 密钥（钥匙串 "hvac-demo-basic"）
//     hjadmin  → role "admin"（管理员），密码 = ADMIN_PASS 密钥（钥匙串 "hvac-demo-admin"）
//
// 转发规则：只允许 GET / HEAD / POST；只转 Authorization / Content-Type 和请求体；路径里有编码过的分隔符
// （%2F %5C %2E）或反斜杠一律拒绝；不跟随重定向；去掉上游的 Set-Cookie、CORS 头、Location 和指纹头，
// 加 nosniff 与 CSP sandbox；超时返回 504。不记录请求体、令牌或上游错误详情。

/** 允许的上游（不接受任意目标，防开放代理）。键是 API_UPSTREAM 的取值，值是对应环境 */
export const ALLOWED_UPSTREAMS = Object.freeze({ 'https://test.cosyhome.com.cn:9443/v1': 'test' })
/** 上游超时：比前端最长的 ctrl 超时（12 秒）多留余量，让前端先超时、提示一致 */
export const UPSTREAM_TIMEOUT_MS = 20_000
const FORWARD_HEADERS = ['authorization', 'content-type']
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST'])
/** 上游响应里不交给浏览器的头 */
const DROP_RESPONSE_HEADERS = ['set-cookie', 'location', 'server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'via']
/** 代理响应统一加的头：上游错误页即使是 text/html 也不会在本站执行 */
const PROXY_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'X-Robots-Tag': 'noindex, nofollow',
}

const ACCOUNTS = [
  { username: 'cosyhome', secret: 'BASIC_PASS', role: 'dealer' },
  { username: 'hjadmin', secret: 'ADMIN_PASS', role: 'admin' },
]
const enc = new TextEncoder()
function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { ...PROXY_RESPONSE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
})

const isApiPath = (p) => p === '/api' || p.startsWith('/api/')

/** 跨站请求一律拒绝（同源前端不会触发；令牌在 Authorization 头里，这只是多一层防护） */
function crossSite(req, url) {
  const site = req.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.get('Origin')
  return !!origin && origin !== url.origin
}

/** 把 /api/xxx?q 改写成 上游/xxx?q；越出上游路径前缀时返回 null */
export function upstreamUrl(upstream, url) {
  const rest = url.pathname.slice('/api'.length)
  if (!rest.startsWith('/') || rest === '/') return null
  // 上游或其前置网关可能先解码再规范化路径，编码过的分隔符和点一律不放行
  if (/%2f|%5c|%2e|\\/i.test(rest)) return null
  const base = new URL(upstream)
  const target = new URL(base.href + rest + url.search)
  const prefix = base.pathname.replace(/\/+$/, '') + '/'
  if (target.origin !== base.origin || !target.pathname.startsWith(prefix)) return null
  return target
}

export async function proxy(req, env, url) {
  const upstream = env.API_UPSTREAM
  if (!Object.hasOwn(ALLOWED_UPSTREAMS, upstream)) return json(500, { code: 13, message: '代理上游未配置' })
  if (!ALLOWED_METHODS.has(req.method)) return json(405, { code: 12, message: '不支持的请求方法' }, { Allow: 'GET, HEAD, POST' })
  if (crossSite(req, url)) return json(403, { code: 7, message: '拒绝跨站请求' })
  const target = upstreamUrl(upstream, url)
  if (!target) return json(404, { code: 5, message: '接口不存在' })

  const headers = new Headers()
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h)
    if (v !== null) headers.set(h, v)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let res
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError')
    // 502 不带 gRPC 码：请求体可能已经到了上游，前端按「网络中断、结果未知」处理（不能当作 14 控制屏未连接）
    return timeout ? json(504, { code: 4, message: '后端响应超时' }) : json(502, { message: '后端连接失败' })
  }
  // 状态码和响应体原样透传（包括上游的 4xx / 5xx）
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
  // 上游 3xx 的 Location 指向上游域名，不交给浏览器跟随
  for (const k of DROP_RESPONSE_HEADERS) out.headers.delete(k)
  for (const k of [...out.headers.keys()]) if (k.startsWith('access-control-')) out.headers.delete(k)
  for (const [k, v] of Object.entries(PROXY_RESPONSE_HEADERS)) out.headers.set(k, v)
  return out
}

async function demoLogin(req, env) {
  if (req.method !== 'POST') return new Response('method', { status: 405 })
  let b = {}
  try { b = await req.json() } catch {}
  const u = String(b.username || ''), pw = String(b.password || '')
  let hit = null
  for (const a of ACCOUNTS) {
    const ok = !!env[a.secret] && safeEqual(u, a.username) && safeEqual(pw, env[a.secret])
    if (ok) hit = a
  }
  const ok = !!hit
  return new Response(JSON.stringify(ok ? { ok, role: hit.role, username: hit.username } : { ok }), { status: ok ? 200 : 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

/** 运行时配置（覆盖 dist/config.js），数据源与 Worker 模式保持一致。写防护白名单不在这里写，沿用前端默认值 */
function configJs(env, real) {
  const cfg = real
    ? { apiBase: '/api', apiEnv: ALLOWED_UPSTREAMS[env.API_UPSTREAM] ?? 'prod', dataSource: 'real' }
    : { dataSource: 'mock' }
  return new Response(`window.__HJC_CONFIG__ = ${JSON.stringify(cfg)}\n`, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  })
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const real = env.DATA_SOURCE === 'real'
    if (isApiPath(url.pathname)) {
      if (real) return proxy(req, env, url)
      if (url.pathname === '/api/login') return demoLogin(req, env)
      return json(404, { code: 5, message: '演示版不提供该接口' })
    }
    if (url.pathname === '/config.js') return configJs(env, real)
    const res = await env.ASSETS.fetch(req)
    const out = new Response(res.body, res)
    out.headers.set('X-Robots-Tag', 'noindex, nofollow')
    out.headers.set('Cache-Control', url.pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    return out
  },
}
