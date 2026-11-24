// 登录、当前用户、退出。登录态与页面的对接在 S5 做；这里只提供接口函数。
import { request } from './http'
import { clearTokens, readTokens, tokensFromResponse, writeTokens } from './tokens'

export interface MeUser {
  id: string
  name?: string
  mobile?: string
  parent_id?: string
  role_id?: string
  /** 1 经销商；0 平台用户（0 可能不传，缺失按平台用户处理） */
  type?: number
}
export interface MeResponse { user_entity?: MeUser; permission_paths?: string[] }

/** /me 的 type 判断身份：只有 1 是经销商，缺失或 0 都是平台用户 */
export const isDealer = (u: Pick<MeUser, 'type'> | null | undefined) => u?.type === 1

let currentUserId = ''
/** ctrl 同步消息要带 user_id（服务端目前不校验），取 /me 的 user_entity.id */
export const getCurrentUserId = () => currentUserId
export const setCurrentUserId = (id: string) => { currentUserId = id }

/** POST /auth/login。恒境云按负责人答复传 isdp=true */
export async function login(mobile: string, password: string, opts: { remember?: boolean; isdp?: boolean } = {}) {
  const r = await request<{ access_token?: string; refresh_token?: string; expires_in?: number }>('/auth/login', {
    auth: false,
    body: { mobile, password, isdp: opts.isdp ?? true },
  })
  const t = tokensFromResponse(r)
  writeTokens(t, opts.remember ?? false)
  return t
}

/** GET /me。结果只放内存 */
export async function me(signal?: AbortSignal) {
  const r = await request<MeResponse>('/me', { method: 'GET', signal })
  if (r.user_entity?.id) setCurrentUserId(r.user_entity.id)
  return r
}

/** 网关按 permission_paths（/v1/... 路由模板，含 {id}）拦截；这里做同样的匹配，只用于显示 */
export function can(paths: readonly string[], route: string): boolean {
  const norm = (p: string) => (p.startsWith('/v1/') ? p : '/v1' + (p.startsWith('/') ? p : '/' + p))
  const target = norm(route).split('/')
  return paths.some((p) => {
    const segs = norm(p).split('/')
    return segs.length === target.length && segs.every((s, i) => s === target[i] || /^\{.+\}$/.test(s))
  })
}

/** POST /auth/invalidate；不论成败都清本地登录态 */
export async function logout() {
  try {
    if (readTokens()) await request('/auth/invalidate', { body: { user_id: currentUserId } })
  } catch { /* 退出时忽略 */ } finally {
    clearTokens()
    currentUserId = ''
  }
}
