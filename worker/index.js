// Static SPA. The in-app login page posts to /api/login, checked here against two demo accounts:
//   cosyhome → role "dealer" (经销商), password = BASIC_PASS secret (source of truth: macOS Keychain "hvac-demo-basic"/cosyhome)
//   hjadmin  → role "admin"  (管理员), password = ADMIN_PASS secret (source of truth: macOS Keychain "hvac-demo-admin"/hjadmin)
// Owner's ask 10/28: single in-app login, no browser Basic-auth prompt. Roles added 11/3 (v2).
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
export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/api/login') {
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
    const res = await env.ASSETS.fetch(req)
    const out = new Response(res.body, res)
    out.headers.set('X-Robots-Tag', 'noindex, nofollow')
    out.headers.set('Cache-Control', new URL(req.url).pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    return out
  },
}
