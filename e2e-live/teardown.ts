// 运行结束（通过或失败）删掉保存的登录态：storageState 里有访问令牌和刷新令牌，不留在磁盘上。
// 同时删掉 test-results-live/：失败时 Playwright 在那里写 error-context.md（整页快照），不留页面内容。
// 不截图、不录 trace，这个目录里没有别的证据；失败信息看终端和 JSON 报告。
// 不调 /auth/invalidate（会作废同账号在别处的令牌）。
import { rmSync } from 'node:fs'

export default function teardown() {
  rmSync('e2e-live/.auth', { recursive: true, force: true })
  // 泄漏回归（只在演练里）要检查失败现场，保留目录，由 dry/leak-check.mjs 检查后删除
  if (process.env.H1_DRY === '1' && process.env.H1_DRY_KEEP === '1') return
  rmSync('test-results-live', { recursive: true, force: true })
}
