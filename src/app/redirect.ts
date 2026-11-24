// 登录后回到哪里：只接受站内的绝对路径，登录页本身、协议相对地址（//evil）和反斜杠写法一律回首页。
export function safeFrom(from: unknown): string | null {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || /[\\\u0000-\u001f]/.test(from)) return null
  const path = from.split(/[?#]/)[0]
  if (path === '/login' || path.startsWith('/login/')) return null
  return from
}
