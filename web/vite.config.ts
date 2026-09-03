import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Vite 配置：dev 服务器将 /api 代理到本地 Fastify 服务（端口 8787）
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787', // 用 127.0.0.1 避免 localhost 解析到 IPv6 ::1 导致代理连不上
        changeOrigin: true
      }
    }
  }
})
