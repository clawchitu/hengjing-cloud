// scripts/build-prod.sh 的 API_BASE 白名单与 scripts/check-config.mjs 的字段检查。
// 只跑参数校验（CHECK_ONLY=1），不构建、不打包、不联网。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PROD = 'https://control.cosyhome.com.cn/v1'

function check(apiBase: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, CHECK_ONLY: '1' }
  delete env.API_BASE
  if (apiBase !== undefined) env.API_BASE = apiBase
  return spawnSync('bash', [join(ROOT, 'scripts/build-prod.sh')], { env, encoding: 'utf8' })
}

describe('build-prod.sh API_BASE 白名单', () => {
  it.each([PROD, '/api'])('接受 %s', (v) => {
    const r = check(v)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`API_BASE 校验通过：${v}`)
  })

  it('不设置时用生产地址', () => {
    const r = check(undefined)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`API_BASE 校验通过：${PROD}`)
  })

  it.each([
    ['空串', ''],
    ['空格', ' '],
    ['制表符', '\t'],
    ['前导空白', ` ${PROD}`],
    ['结尾空白', `${PROD} `],
    ['结尾换行', `${PROD}\n`],
    ['中间换行', `${PROD}\nalert(1)`],
    ['/api 带换行', '/api\n'],
    ['单引号', `${PROD}'`],
    ['单引号注入', `/api',writeMode:'on`],
    ['双引号', `"${PROD}"`],
    ['反斜杠', '/api\\'],
    ['其他域名', 'https://evil.example.com/v1'],
    ['测试环境', 'https://test.cosyhome.com.cn:9443/v1'],
    ['后缀伪装域名', 'https://control.cosyhome.com.cn.evil.com/v1'],
    ['userinfo 伪装', 'https://control.cosyhome.com.cn@evil.com/v1'],
    ['子域名', 'https://a.control.cosyhome.com.cn/v1'],
    ['http', 'http://control.cosyhome.com.cn/v1'],
    ['协议相对', '//control.cosyhome.com.cn/v1'],
    ['大写域名', 'https://CONTROL.cosyhome.com.cn/v1'],
    ['显式端口', 'https://control.cosyhome.com.cn:443/v1'],
    ['结尾斜杠', `${PROD}/`],
    ['缺 /v1', 'https://control.cosyhome.com.cn'],
    ['其他路径', 'https://control.cosyhome.com.cn/v2'],
    ['路径穿越 ..', `${PROD}/../admin`],
    ['路径穿越 ./', 'https://control.cosyhome.com.cn/./v1'],
    ['编码穿越', `${PROD}/%2e%2e/admin`],
    ['带查询串', `${PROD}?x=1`],
    ['带片段', `${PROD}#x`],
    ['/api 结尾斜杠', '/api/'],
    ['/api 子路径', '/api/v1'],
    ['/api 穿越', '/api/../v1'],
    ['/api 前缀穿越', '/../api'],
    ['相对路径', 'api'],
    ['/API 大写', '/API'],
    ['javascript:', 'javascript:alert(1)'],
  ])('拒绝%s', (_name, v) => {
    const r = check(v)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('API_BASE 只能是')
    expect(r.stdout).not.toContain('校验通过')
  })
})

describe('check-config.mjs 按实际字段值检查', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hjc-cfg-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const good = { apiBase: PROD, apiEnv: 'prod', dataSource: 'real', writeMode: 'off', writeProjectCodes: [] }
  const run = (src: string) => {
    const f = join(dir, 'config.js')
    writeFileSync(f, src)
    return spawnSync(process.execPath, [join(ROOT, 'scripts/check-config.mjs'), f, PROD, '/api'], { encoding: 'utf8' })
  }
  const cfg = (o: object) => `window.__HJC_CONFIG__ = ${JSON.stringify(o)}`

  it.each([PROD, '/api'])('通过：apiBase=%s', (apiBase) => {
    const r = run(cfg({ ...good, apiBase }))
    expect(r.status, r.stderr).toBe(0)
  })

  it.each([
    ['apiBase 不在白名单', { ...good, apiBase: 'https://test.cosyhome.com.cn:9443/v1' }],
    ['apiBase 结尾斜杠', { ...good, apiBase: `${PROD}/` }],
    ['writeMode on', { ...good, writeMode: 'on' }],
    ['writeMode test-only', { ...good, writeMode: 'test-only' }],
    ['白名单非空', { ...good, writeProjectCodes: ['260911001'] }],
    ['白名单是字符串', { ...good, writeProjectCodes: '' }],
    ['dataSource mock', { ...good, dataSource: 'mock' }],
    ['apiEnv test', { ...good, apiEnv: 'test' }],
    ['多出字段', { ...good, extra: 1 }],
  ])('不通过：%s', (_n, o) => {
    expect(run(cfg(o)).status).toBe(1)
  })

  it('注释里写 writeMode: \'off\' 骗不过（按实际值）', () => {
    const r = run(`// writeMode: 'off', writeProjectCodes: []\n${cfg({ ...good, writeMode: 'on' })}`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('writeMode')
  })

  it('后面的赋值覆盖前面的也按最终值检查', () => {
    expect(run(`${cfg(good)}\nwindow.__HJC_CONFIG__.writeMode = 'on'`).status).toBe(1)
  })

  it('没有设置配置对象', () => {
    expect(run('var x = 1').status).toBe(1)
  })

  it('语法错误', () => {
    expect(run('window.__HJC_CONFIG__ = {').status).toBe(1)
  })
})
