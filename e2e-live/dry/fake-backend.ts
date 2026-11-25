import { createServer } from 'node:http'
// 演练用的假后端（npm run e2e:live:dry）：不连测试服，验证 H1 用例、闸门和断言本身。
// 本机 vite 开发代理指向这里（127.0.0.1:5199）；数据形状照 docs/api/实测记录-1124.md，ctrl 回包用 src/api/ctrl.ts 编码。
// 经销商令牌没有 /stat、/frequent 权限，走前端回退分支。结束时打印收到的路由（应只有只读白名单里的）。
import { CTRL, encodeMessage } from '../../src/api/ctrl'

export const FAKE_PORT = 5199
const P = { a: '66cfd7959fb60d63c917fd0a', b: '66cfd7959fb60d63c917fd0b', off: '66cfd7959fb60d63c917fd0c', hidden: '66cfd7959fb60d63c917fd0d' }
const ALLP = ['/v1/me', '/v1/ctrl/projects', '/v1/integrated-projects', '/v1/integrated-projects/stat', '/v1/projects/frequent', '/v1/project/click/{id}', '/v1/distributors', '/v1/apps',
  ...Object.values(CTRL).map((d) => `/v1/ctrl/${d.route}`)]
const now = Date.now()
const ctrl: Record<string, () => string> = {
  'air-sensor-get': () => encodeMessage(CTRL[207].reply, { data: [{ name: 'KC2', id: 2042830592, temperature: 25.5, humidity: 55, pm25: 5, co2: 580, dewPoint: 15.8, isConnected: true }, { name: 'KC3', id: 2042830593, temperature: 65536, humidity: 65536, pm25: 65536, co2: 65536, dewPoint: 65536, isConnected: true }] }),
  'air-sensor-data-hour-get': () => encodeMessage(CTRL[208].reply, { data: [0, 1, 2].map((i) => ({ id: 1, date: Math.floor((now - i * 3600_000) / 3600_000) * 3600_000, hour: 1, temperature: 24 + i, humidity: 50, dewPoint: 13, co2: 500, pm25: 5 })) }),
  'room-temperature-data-get': () => encodeMessage(CTRL[200].reply, { data: [
    { id: 406658286, name: '房间11', temperature: 22, humidity: 60, dewPoint: 13.9, setTemp: 21.5, windSpeed: 3, eco: 0, switch: 0, mode: 0, endModes: [{ optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 }], isConnected: true },
    { id: 406658287, name: '房间12', temperature: 23, setTemp: 22, switch: 1, endModes: [{ optionName: '风盘', type: 0, isSelected: true, isChange: true, switch: 1 }], isConnected: false },
  ] }),
  'room-temperature-data-hour-get': () => '',
  'device-summary-get': () => encodeMessage(CTRL[205].reply, { data: [{ deviceName: 'HUB', model: '485', address: '1', connStatus: 1 }, { deviceName: 'KC2', model: 'x', address: '2', connStatus: 1 }, { deviceName: 'CS10', model: 'y', address: '3' }] }),
}
export default async function setup() {
  const log: string[] = []
  const srv = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const path = req.url!.split('?')[0]
      log.push(`${req.method} ${path}`)
      const dealer = (req.headers.authorization ?? '').includes('td')
      const j = (o: unknown, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (path === '/auth/login') { const m = JSON.parse(b).mobile; return j({ access_token: m === 'deal' ? 'td' : 'tp', refresh_token: 'r', expires_in: 7200 }) }
      if (path === '/me') return j({ user_entity: { id: dealer ? 'ud' : 'up', type: dealer ? 1 : 0, name: dealer ? '经销商' : '平台' }, permission_paths: dealer ? ALLP.filter((p) => !/stat|frequent/.test(p)) : ALLP })
      if (path === '/ctrl/projects') return j({ project_entities: [
        { id: P.a, name: '测试项目0829', code: '240829001', app_code: '1', online: true, control_screen_id: 'cs1' },
        { id: P.b, name: '独立空气系统测试', code: '260911001', app_code: '12', online: true, control_screen_id: 'cs1' },
        { id: P.off, name: '科希家办公室', code: '221031001', app_code: '1', control_screen_id: 'cs2' },
        { id: P.hidden, name: '隐藏项目', code: '999999001', app_code: '1' },
      ] })
      if (path === '/integrated-projects') return j({ entities: [{ id: 'g1', name: '五恒集成项目', code: '1', project_ids: [P.a, P.off] }, { id: 'g2', name: '单机版', code: '3', distributor_id: 'd1', project_ids: [P.a, P.b] }] })
      if (path === '/integrated-projects/stat') return j({ total: '2', project_total: '3', project_online: '2' })
      if (path === '/projects/frequent') return j({ project_entities: [{ id: P.b }, { id: P.hidden }, { id: P.a }] })
      if (path === '/distributors') return j({ distributor_entities: [{ id: 'd1', name: '科希家研发苏州main', abbreviation: '苏州main' }] })
      if (path === '/apps') return j({ app_entities: [] })
      const m = /^\/ctrl\/(.+)$/.exec(path)
      if (m && ctrl[m[1]]) return j({ body: ctrl[m[1]]() })
      j({ code: 5, message: 'fake: ' + path }, 500)
    })
  }).listen(FAKE_PORT, '127.0.0.1')
  return async () => { srv.close(); console.log('假后端收到的路由：\n' + [...new Set(log)].join('\n')) }
}
