import { defineConfig } from 'vitest/config'

// 手动联调：npm run test:live（连测试环境，只读；账号来自 macOS 钥匙串）。CI 不运行。
export default defineConfig({
  define: { __HJC_MOCK__: 'true' },
  test: { include: ['scripts/live/**/*.live.ts'], environment: 'node', fileParallelism: false, testTimeout: 60_000 },
})
