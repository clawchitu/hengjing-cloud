import { defineConfig } from '@playwright/test'
import type { Role } from './e2e-live/harness'
import { LOCAL_PROXY_TARGET, ORIGIN, TARGET } from './e2e-live/target'

// H1：真实测试服只读 e2e（e2e-strategy.md 第 4 层）。不参与 npm run e2e 和 CI 的截图比对。
// 运行说明见 docs/H1-测试服只读e2e.md。npm run e2e:live（默认本机开发服务器）；H1_TARGET=demo 改为测试站 hvac-demo。
//
// 单次登录：setup 项目每个账号登录一次并存 storageState，platform / dealer 两个项目依赖它、复用登录态；
// 全程不续期（闸门拦 /auth/refresh）。retries 必须为 0：重试 setup 就是第二次登录。
// 不截图、不录视频、不录 trace：登录页上有账号，trace 里有请求头（令牌）。失败证据是去敏的 network.txt 附件（JSON 报告里）。
export default defineConfig<{ role: Role }>({
  testDir: './e2e-live',
  testMatch: /\.(spec|setup)\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // 令牌有效期 2 小时；整次运行限 30 分钟，远低于有效期，确保不需要续期
  globalTimeout: 30 * 60_000,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  globalTeardown: './e2e-live/teardown.ts',
  // 不用 HTML 报告：它把 fill 等步骤的参数原文写进报告（已实测）。JSON 报告不含步骤参数，附件 network.txt 只有方法和路径
  reporter: [['list'], ['json', { outputFile: 'playwright-report-live/results.json' }]],
  outputDir: 'test-results-live',
  use: {
    baseURL: ORIGIN,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    { name: 'platform', testMatch: /\.spec\.ts$/, dependencies: ['setup'], use: { role: 'platform', storageState: 'e2e-live/.auth/platform.json' } },
    { name: 'dealer', testMatch: /\.spec\.ts$/, dependencies: ['setup'], use: { role: 'dealer', storageState: 'e2e-live/.auth/dealer.json' } },
  ],
  // 本机目标：vite 开发服务器，/api 经开发代理固定转发到测试服。不复用已有服务器（端口上可能是配置不同的开发服务器）
  webServer: TARGET === 'local' ? {
    command: 'npx vite --port 5174 --strictPort',
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_PROXY_TARGET: LOCAL_PROXY_TARGET, VITE_API_BASE: '/api', VITE_API_ENV: 'test', VITE_DATA_SOURCE: 'real', VITE_WRITE_MODE: 'off' },
  } : undefined,
})
