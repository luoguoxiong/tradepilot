import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1', // 显式 IPv4，规避本机 localhost 解析到 ::1 的坑
    port: 5173,
    strictPort: true,
    proxy: {
      // 代理到本地 API（用 127.0.0.1 规避 IPv6 解析问题）
      '/api': {
        target: 'http://127.0.0.1:3020',
        changeOrigin: true,
      },
    },
  },
});
