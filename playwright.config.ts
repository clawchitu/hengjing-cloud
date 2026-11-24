import { defineConfig } from '@playwright/test'

// 截图在固定的 Playwright 官方镜像里生成和比对（本机用 npm run e2e 会起容器，CI 同镜像）。
export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  // threshold: 0 = 逐像素颜色严格比较（默认 0.2 会放过整片换底色）；
  // 只用 maxDiffPixels 给极少量抗锯齿像素留余地。基线与比对都在同一镜像里做。
  expect: { toHaveScreenshot: { threshold: 0, maxDiffPixels: 50, animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
