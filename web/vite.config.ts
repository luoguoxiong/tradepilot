import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_PROXY_TARGET || 'http://localhost:8080',
          changeOrigin: true,
          // SSE 代理需关闭响应缓冲（技术方案 01 §5.2）
          configure(proxy) {
            proxy.on('proxyRes', (proxyRes) => {
              proxyRes.headers.connection = 'keep-alive'
            })
          },
        },
      },
    },
    build: {
      sourcemap: mode === 'staging',
      rollupOptions: {
        output: {
          // vendor 分包（01 §5.2）：tiptap 仅 inbox/approvals 懒加载入口消费，独立 chunk 控制单包体积
          manualChunks: {
            'element-plus': ['element-plus'],
            tiptap: ['@tiptap/vue-3', '@tiptap/starter-kit', '@tiptap/extensions', '@tiptap/pm'],
          },
        },
      },
    },
  }
})
