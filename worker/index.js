// Static SPA behind a shared-password gate (HTTP Basic auth, user "cosyhome").
// Password lives in the BASIC_PASS secret (source of truth: macOS Keychain "hvac-demo-basic").
const enc = new TextEncoder()
function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
function authorized(req, env) {
  const h = req.headers.get('Authorization') || ''
  if (!h.startsWith('Basic ') || !env.BASIC_PASS) return false
  let decoded = ''
  try { decoded = atob(h.slice(6)) } catch { return false }
  const i = decoded.indexOf(':')
  return i > 0 && safeEqual(decoded.slice(0, i), 'cosyhome') && safeEqual(decoded.slice(i + 1), env.BASIC_PASS)
}
export default {
  async fetch(req, env) {
    if (!authorized(req, env)) {
      return new Response('需要登录 / Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="hengjing-cloud demo", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    const res = await env.ASSETS.fetch(req)
    const out = new Response(res.body, res)
    out.headers.set('X-Robots-Tag', 'noindex, nofollow')
    out.headers.set('Cache-Control', new URL(req.url).pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    return out
  },
}
