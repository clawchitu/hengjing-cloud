// 交付包自检（scripts/build-prod.sh 调用）：在隔离的 vm 里执行 config.js，按实际字段值检查生产配置。
// 用法：node scripts/check-config.mjs <config.js> <允许的 apiBase>...
// 不满足任一条即退出码 1：apiBase 在白名单里、apiEnv=prod、dataSource=real、writeMode=off、
// writeProjectCodes 为空数组，且没有其他字段。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const [file, ...allowedBases] = process.argv.slice(2)
if (!file || !allowedBases.length) {
  console.error('用法：node scripts/check-config.mjs <config.js> <允许的 apiBase>...')
  process.exit(2)
}

const sandbox = { window: {} }
try {
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 1000 })
} catch (e) {
  console.error(`config.js 执行失败：${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

const cfg = sandbox.window.__HJC_CONFIG__
const errors = []
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
  errors.push('没有设置 window.__HJC_CONFIG__ 对象')
} else {
  const expected = ['apiBase', 'apiEnv', 'dataSource', 'writeMode', 'writeProjectCodes']
  const extra = Object.keys(cfg).filter((k) => !expected.includes(k))
  if (extra.length) errors.push(`多出字段：${extra.join(', ')}`)
  if (!allowedBases.includes(cfg.apiBase)) errors.push(`apiBase 不在白名单里：${JSON.stringify(cfg.apiBase)}`)
  if (cfg.apiEnv !== 'prod') errors.push(`apiEnv 应为 'prod'：${JSON.stringify(cfg.apiEnv)}`)
  if (cfg.dataSource !== 'real') errors.push(`dataSource 应为 'real'：${JSON.stringify(cfg.dataSource)}`)
  if (cfg.writeMode !== 'off') errors.push(`writeMode 应为 'off'：${JSON.stringify(cfg.writeMode)}`)
  if (!Array.isArray(cfg.writeProjectCodes) || cfg.writeProjectCodes.length !== 0) {
    errors.push(`writeProjectCodes 应为空数组：${JSON.stringify(cfg.writeProjectCodes)}`)
  }
}

if (errors.length) {
  for (const e of errors) console.error(`config.js：${e}`)
  process.exit(1)
}
console.log(`config.js 检查通过：apiBase=${cfg.apiBase}，writeMode=off，下发白名单为空，dataSource=real`)
