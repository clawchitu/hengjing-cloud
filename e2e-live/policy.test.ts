// H1 放行规则的单元测试（npm test 里跑，不连任何服务器）
import { describe, expect, it } from 'vitest'
import { CTRL, WRITE_CTRL } from '../src/api/ctrl'
import { isWritePath, WRITE_ROUTES } from '../src/api/guard'
import { CTRL_READ_PATHS, decide as decideAt, READ_ALLOW, TARGET_ORIGINS, WRITE_PATHS } from './policy'

const SITE_ORIGIN = TARGET_ORIGINS.demo
const api = (p: string) => `${SITE_ORIGIN}/api${p}`
const decide = (m: string, u: string, o: { allowLogin?: boolean } = {}) => decideAt(m, u, { origin: SITE_ORIGIN, ...o })

describe('H1 放行规则', () => {
  it('写路由表与源码一致：201/203/204/206 + unified-ctrls-send', () => {
    expect([...WRITE_CTRL]).toEqual([201, 203, 204, 206])
    expect(WRITE_PATHS).toEqual([
      '/ctrl/project-room-switch-set',
      '/ctrl/room-temperature-set',
      '/ctrl/running-ctrl-set',
      '/ctrl/unified-ctrl-set',
      '/ctrl/unified-ctrls-send',
    ])
    for (const p of Object.values(WRITE_ROUTES)) expect(WRITE_PATHS).toContain(p)
  })

  it('ctrl 读路由取自 CTRL 去掉 WRITE_CTRL：200/202/205/207/208/209/210', () => {
    expect(CTRL_READ_PATHS).toEqual([200, 202, 205, 207, 208, 209, 210].map((t) => `/ctrl/${CTRL[t as keyof typeof CTRL].route}`))
  })

  it('白名单与写路由交集为空，且没有一条被 guard.ts 认作写路径', () => {
    const paths = READ_ALLOW.map((e) => e.split(' ')[1])
    expect(paths.filter((p) => WRITE_PATHS.includes(p))).toEqual([])
    expect(paths.filter((p) => isWritePath(p))).toEqual([])
  })

  it('每条写路由都被 abort（含大小写、/v1 前缀、结尾斜杠、查询串、GET 变体）', () => {
    for (const p of WRITE_PATHS) {
      for (const u of [p, p.toUpperCase(), '/v1' + p, p + '/', p + '?x=1']) {
        for (const m of ['POST', 'GET', 'PUT']) expect(decide(m, api(u)).action, `${m} ${u}`).toBe('abort')
      }
    }
    // guard.ts 兜底规则：将来新增的 *-set / *-send 也拦
    expect(decide('POST', api('/ctrl/some-new-set')).action).toBe('abort')
    expect(decide('POST', api('/ctrl/trans-ctrl-message')).action).toBe('abort')
  })

  it('续期、作废令牌一律 abort；登录只在 setup 放行', () => {
    expect(decide('POST', api('/auth/refresh')).action).toBe('abort')
    expect(decide('POST', api('/auth/refresh'), { allowLogin: true }).action).toBe('abort')
    expect(decide('POST', api('/auth/invalidate'), { allowLogin: true }).action).toBe('abort')
    expect(decide('POST', api('/auth/login')).action).toBe('abort')
    expect(decide('POST', api('/auth/login'), { allowLogin: true }).action).toBe('allow')
    expect(decide('GET', api('/auth/login'), { allowLogin: true }).action).toBe('abort')
  })

  it('白名单内的读请求放行，方法或路径不完全一致就拦', () => {
    for (const e of READ_ALLOW) {
      const [m, p] = e.split(' ')
      expect(decide(m, api(p)).action, e).toBe('allow')
    }
    expect(decide('POST', api('/me')).action).toBe('abort')
    expect(decide('GET', api('/ctrl/projects')).action).toBe('abort')
    expect(decide('POST', api('/ctrl/projects/')).action).toBe('abort')
    expect(decide('POST', api('/ctrl/projects?x=1')).action).toBe('abort')
    expect(decide('POST', api('/ctrl/unified-ctrls-records')).action).toBe('abort')
    expect(decide('POST', api('/weather24')).action).toBe('abort')
  })

  it('点击上报只 abort、不算违规', () => {
    expect(decide('POST', api('/project/click/66cfd7959fb60d63c917fd0a'))).toEqual({ action: 'abort-silent', reason: expect.any(String) })
    expect(decide('POST', api('/project/click/../me')).action).toBe('abort')
  })

  it('Cloudflare 访问统计只 abort、不算违规；同域其他非 GET 仍是违规', () => {
    expect(decide('GET', 'https://static.cloudflareinsights.com/beacon.min.js/v1').action).toBe('abort-silent')
    expect(decide('POST', 'https://static.cloudflareinsights.com/beacon.min.js').action).toBe('abort')
    expect(decide('POST', `${SITE_ORIGIN}/cdn-cgi/rum`).action).toBe('abort-silent')
    expect(decide('POST', `${SITE_ORIGIN}/cdn-cgi/other`).action).toBe('abort')
  })

  it('非测试站一律拦；测试站静态资源只放行 GET / HEAD', () => {
    expect(decide('GET', 'https://test.cosyhome.com.cn:9443/v1/me').action).toBe('abort')
    expect(decide('POST', 'https://control.cosyhome.com.cn/v1/ctrl/projects').action).toBe('abort')
    expect(decide('GET', 'http://hvac-demo.haoqianglyu.com/').action).toBe('abort')
    expect(decide('GET', `${SITE_ORIGIN}/assets/index.js`).action).toBe('allow')
    expect(decide('HEAD', `${SITE_ORIGIN}/config.js`).action).toBe('allow')
    expect(decide('POST', `${SITE_ORIGIN}/login`).action).toBe('abort')
  })

  it('本机目标：只认 localhost:5174；未登记的被测站点整体拒绝', () => {
    const local = TARGET_ORIGINS.local
    expect(decideAt('GET', `${local}/src/main.tsx`, { origin: local }).action).toBe('allow')
    expect(decideAt('GET', `${local}/api/me`, { origin: local }).action).toBe('allow')
    expect(decideAt('POST', `${local}/api/ctrl/room-temperature-set`, { origin: local }).action).toBe('abort')
    expect(decideAt('GET', `${SITE_ORIGIN}/api/me`, { origin: local }).action).toBe('abort')
    expect(decideAt('GET', 'https://control.cosyhome.com.cn/', { origin: 'https://control.cosyhome.com.cn' }).action).toBe('abort')
    expect(decideAt('GET', 'http://localhost:5173/api/me', { origin: 'http://localhost:5173' }).action).toBe('abort')
  })
})
