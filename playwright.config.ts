import { defineConfig } from '@playwright/test'

// 截图在固定的 Playwright 官方镜像里生成和比对（本机用 npm run e2e 会起容器，CI 同镜像）。
export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  // threshold: 0 = 逐像素颜色严格比较（默认 0.2 会放过整片换底色）；
  // maxDiffPixels: 0 = 不允许任何像素差异。基线与比对都在同一镜像里做，渲染逐像素一致。
  expect: { toHaveScreenshot: { threshold: 0, maxDiffPixels: 0, animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    // 确定性光栅化：CI 曾在圆角裁剪（头像、卡片圆角）边缘出现 3–10 个抗锯齿像素抖动，
    // 根因是多线程/GPU/部分光栅化路径不固定。固定为单线程软件光栅化，不靠放宽阈值。
    launchOptions: {
      args: [
        '--disable-gpu',
        '--disable-gpu-rasterization',
        '--disable-partial-raster',
        '--num-raster-threads=1',
        '--disable-skia-runtime-opts',
        '--force-color-profile=srgb',
        '--disable-lcd-text',
      ],
    },
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
