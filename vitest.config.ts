import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 单元测试按常规构建（含演示数据）；交付包剔除演示数据的效果由 scripts/build-prod.sh 的自检验证
  define: { __HJC_MOCK__: 'true' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts', 'worker/**/*.test.js', 'scripts/**/*.test.ts'], environment: 'node', allowOnly: false },
})
