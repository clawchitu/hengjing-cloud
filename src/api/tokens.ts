// 令牌存取。只存 sessionStorage：关掉浏览器令牌就没了，重新打开要重新登录（负责人要求）。
// sessionStorage 按标签页隔离，新开的标签页向已登录的标签页要令牌、续期结果和退出在标签页之间广播，
// 见 sessionChannel.ts 与 session.ts。只存令牌和过期时间，不存用户名和角色（角色每次从 /me 取，见方案第 2 节）。
// 旧版本存在 localStorage 里的令牌一律清掉、不再读取（purgeLegacyTokens）；
// 账号相关的本地偏好（最近使用、置顶、天气城市等）不在这里，仍留在 localStorage。

import { ApiError, registerSecrets } from './errors'

export interface Tokens {
  accessToken: string
  refreshToken: string
  /** access_token 过期时刻（毫秒时间戳） */
  expiresAt: number
}

export const TOKEN_KEY = 'hjc-session'

let memory: Tokens | null = null // 没有 Web Storage 的环境（单元测试、node 脚本）
const store = (): Storage | null => {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null } catch { return null }
}

export const isTokens = (t: unknown): t is Tokens => {
  const v = t as Tokens | null
  return !!v && typeof v === 'object' && typeof v.accessToken === 'string' && !!v.accessToken
    && typeof v.refreshToken === 'string' && !!v.refreshToken && typeof v.expiresAt === 'number'
}

/** 删掉旧版本留在 localStorage 里的令牌（旧版本「记住我」存在那里，关浏览器也不失效）。应用启动时调用 */
export function purgeLegacyTokens() {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY) } catch { /* 存储不可用 */ }
}

export function readTokens(): Tokens | null {
  const s = store()
  if (!s) return memory
  const raw = s.getItem(TOKEN_KEY)
  if (!raw) return null
  try { const t = JSON.parse(raw) as unknown; return isTokens(t) ? t : null } catch { return null } // 损坏的记录当作没有
}

export function writeTokens(t: Tokens) {
  const s = store()
  if (!s) { memory = t; return }
  s.setItem(TOKEN_KEY, JSON.stringify(t))
}

export function clearTokens() {
  memory = null
  store()?.removeItem(TOKEN_KEY)
  purgeLegacyTokens()
}

/** 后端 login / refresh 的返回 → Tokens */
export function tokensFromResponse(r: { access_token?: string; refresh_token?: string; expires_in?: number | string }, now = Date.now()): Tokens {
  if (!r.access_token || !r.refresh_token) throw new ApiError('server', '登录响应缺少令牌')
  const sec = Number(r.expires_in) > 0 ? Number(r.expires_in) : 7200
  return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: now + sec * 1000 }
}

/** access_token（JWT）里的 sub，用来判断两个令牌是不是同一个用户；解析不了、为空或只有空白返回 null */
export function jwtSub(token: string | null | undefined): string | null {
  try {
    const p = token?.split('.')[1]
    if (!p) return null
    const json = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }
    // 空串、只有空白、不是字符串一律按「没有 sub」
    return typeof json.sub === 'string' && json.sub.trim() ? json.sub : null
  } catch { return null }
}

// 错误信息与日志脱敏时，把当前令牌原文也当作敏感串
registerSecrets(() => {
  const t = readTokens()
  return t ? [t.accessToken, t.refreshToken] : []
})
