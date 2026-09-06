import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

// 独立于 vite.config（后者为按 mode 的工厂函数），仅复用 @ 别名
export default defineConfig({
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
