// Static SPA. The in-app login page posts to /api/login, checked here against user "cosyhome"
// and the BASIC_PASS secret (source of truth: macOS Keychain "hvac-demo-basic"/cosyhome). Owner's ask 10/28: single in-app login, no browser Basic-auth prompt.
const enc = new TextEncoder()
function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/api/login') {
      if (req.method !== 'POST') return new Response('method', { status: 405 })
      let b = {}
      try { b = await req.json() } catch {}
      const ok = !!env.BASIC_PASS && safeEqual(String(b.username || ''), 'cosyhome') && safeEqual(String(b.password || ''), env.BASIC_PASS)
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    }
    const res = await env.ASSETS.fetch(req)
    const out = new Response(res.body, res)
    out.headers.set('X-Robots-Tag', 'noindex, nofollow')
    out.headers.set('Cache-Control', new URL(req.url).pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    return out
  },
}
