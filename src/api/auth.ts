// 登录、当前用户、退出的接口函数。登录态（状态机、can()、主动续期）见 session.ts。
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

/**
 * POST /auth/login。恒境云一律传 isdp=true（负责人答复；没有集成功能的账号在登录时就被拒，
 * 后端返回 500 code 13，文案原样提示）。
 */
export async function login(mobile: string, password: string, opts: { store?: boolean } = {}) {
  const r = await request<{ access_token?: string; refresh_token?: string; expires_in?: number }>('/auth/login', {
    auth: false,
    body: { mobile, password, isdp: true },
  })
  const t = { ...tokensFromResponse(r), loginAt: Date.now() }
  // store=false：由调用方确认本次登录仍然有效后再写（session.ts）
  if (opts.store !== false) writeTokens(t)
  return t
}

/**
 * GET /me。结果只放内存。
 * accessToken：用指定令牌查（不读存储、不续期）；track=false：不更新 getCurrentUserId()，由调用方决定。
 */
export async function me(opts: { signal?: AbortSignal; accessToken?: string; track?: boolean } = {}) {
  const r = await request<MeResponse>('/me', { method: 'GET', signal: opts.signal, accessToken: opts.accessToken })
  if (opts.track !== false && r.user_entity?.id) setCurrentUserId(r.user_entity.id)
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

/**
 * POST /auth/invalidate；不论成败本地登录态都已清掉。
 * 先取出令牌并立即清本地，再用取出的令牌调 invalidate：退出途中重新登录的新会话不受影响。
 */
export async function logout() {
  const t = readTokens()
  const uid = currentUserId
  clearTokens()
  currentUserId = ''
  if (!t) return
  try {
    await request('/auth/invalidate', { body: { user_id: uid }, accessToken: t.accessToken })
  } catch { /* 退出时忽略 */ }
}
