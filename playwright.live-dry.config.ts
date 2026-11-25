import { defineConfig } from '@playwright/test'
import live from './playwright.live.config'
import { FAKE_PORT } from './e2e-live/dry/fake-backend'
import type { Role } from './e2e-live/harness'

// H1 演练（npm run e2e:live:dry）：同一套用例和闸门，本机开发代理改指向假后端，不连测试服、不用真实账号。
// 只用来验证用例和闸门本身；不能替代真实运行。
if (process.env.H1_TARGET && process.env.H1_TARGET !== 'local') throw new Error('演练只能用本机目标')
// 假账号，覆盖环境里可能有的真实账号（真实账号绝不发给假后端，也不读钥匙串）
Object.assign(process.env, { H1_PLATFORM_ACCOUNT: 'plat', H1_PLATFORM_PASSWORD: 'x', H1_DEALER_ACCOUNT: 'deal', H1_DEALER_PASSWORD: 'x' })
export default defineConfig<{ role: Role }>({
  ...live,
  globalSetup: './e2e-live/dry/fake-backend.ts',
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_PROXY_TARGET: `http://127.0.0.1:${FAKE_PORT}`, VITE_API_BASE: '/api', VITE_API_ENV: 'test', VITE_DATA_SOURCE: 'real', VITE_WRITE_MODE: 'off',
    },
  },
})
