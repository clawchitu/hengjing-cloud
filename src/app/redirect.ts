// 登录后回到哪里：只接受站内的绝对路径，登录页本身、协议相对地址（//evil）和反斜杠写法一律回首页。
export function safeFrom(from: unknown): string | null {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || /[\\\u0000-\u001f]/.test(from)) return null
  const path = from.split(/[?#]/)[0]
  if (path === '/login' || path.startsWith('/login/')) return null
  return from
}

/** 守卫跳登录页时记下的原路径和当时的账号（session userKey） */
export interface LoginFrom { from?: unknown; fromUser?: unknown }

/**
 * 登录后跳到哪里：原路径不安全 → 首页；原路径是别的账号留下的（同一浏览器换账号，S13 走查 P7）→ 首页，
 * 新账号从首页开始；同一个账号重新登录（会话过期等）→ 回原路径。没记账号的照旧回原路径
 */
export function afterLogin(state: LoginFrom | null | undefined, userKey: string | null): string {
  const from = safeFrom(state?.from)
  if (!from) return '/home'
  const u = state?.fromUser
  if (typeof u === 'string' && u && u !== userKey) return '/home'
  return from
}
