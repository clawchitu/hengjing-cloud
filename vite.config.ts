import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// 开发服务器把 /api/* 转发到测试环境（浏览器直连会被 CORS 拦）。/api/login 是演示版 Worker 的
// 登录接口，不转发。VITE_PROXY_TARGET 可改目标。
const TEST_API = 'https://test.cosyhome.com.cn:9443/v1'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const target = env.VITE_PROXY_TARGET || TEST_API
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // 供 src/api/config.ts 判断 /api 实际指向哪个环境；构建产物里为空串（按生产处理）
    define: { __HJC_DEV_PROXY_TARGET__: JSON.stringify(command === 'serve' ? target : '') },
    server: {
      proxy: {
        '^/api/(?!login$)': { target, changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/api/, '') },
      },
    },
    // vite preview（截图测试用）不转发任何请求
    preview: { proxy: {} },
  }
})
