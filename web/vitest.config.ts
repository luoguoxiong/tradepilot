import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// 独立于 vite.config（后者为按 mode 的工厂函数），仅复用 @ 别名；
// 组件单测（InsightCard 等）需 vue 插件以编译 SFC。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
    globals: false,
  },
})
