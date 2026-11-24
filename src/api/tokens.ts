// 令牌存取。勾选「记住我」存 localStorage，否则 sessionStorage；只存令牌和过期时间，
// 不存用户名和角色（角色每次从 /me 取，见方案第 2 节）。每次都从存储读取，
// 这样别的标签页刷新令牌后，本页下一次请求自然拿到新值。

export interface Tokens {
  accessToken: string
  refreshToken: string
  /** access_token 过期时刻（毫秒时间戳） */
  expiresAt: number
}

export const TOKEN_KEY = 'hjc-session'

let memory: Tokens | null = null // 没有 Web Storage 的环境（单元测试、node 脚本）
const stores = (): Storage[] => {
  try { return typeof localStorage !== 'undefined' ? [localStorage, sessionStorage] : [] } catch { return [] }
}

const valid = (t: unknown): t is Tokens => {
  const v = t as Tokens | null
  return !!v && typeof v.accessToken === 'string' && typeof v.refreshToken === 'string' && typeof v.expiresAt === 'number'
}

export function readTokens(): Tokens | null {
  const ss = stores()
  if (!ss.length) return memory
  for (const s of ss) {
    const raw = s.getItem(TOKEN_KEY)
    if (!raw) continue
    try { const t = JSON.parse(raw) as unknown; if (valid(t)) return t } catch { /* 损坏的记录当作没有 */ }
  }
  return null
}

/** remember 不传时写回原来所在的存储 */
export function writeTokens(t: Tokens, remember?: boolean) {
  const ss = stores()
  if (!ss.length) { memory = t; return }
  const [local, session] = ss
  const useLocal = remember ?? local.getItem(TOKEN_KEY) !== null
  ;(useLocal ? session : local).removeItem(TOKEN_KEY)
  ;(useLocal ? local : session).setItem(TOKEN_KEY, JSON.stringify(t))
}

export function clearTokens() {
  memory = null
  for (const s of stores()) s.removeItem(TOKEN_KEY)
}

/** 后端 login / refresh 的返回 → Tokens */
export function tokensFromResponse(r: { access_token?: string; refresh_token?: string; expires_in?: number | string }, now = Date.now()): Tokens {
  if (!r.access_token || !r.refresh_token) throw new Error('登录响应缺少令牌')
  const sec = Number(r.expires_in) > 0 ? Number(r.expires_in) : 7200
  return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: now + sec * 1000 }
}
