import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      vue(),
      // Element Plus 按需导入（06 §2）：模板 el-* 组件自动按需注册 + 样式逐组件引入。
      // dts:false：不生成 components.d.ts——否则 el-table 插槽 row 类型化为 DefaultRow，
      // 全部列表视图 26 处回调签名报错；el-* 模板类型保持按需导入前的无类型语义
      Components({ resolvers: [ElementPlusResolver()], dts: false }),
    ],
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
          // vendor 分包（01 §5.2）：函数式按模块 id 归组——@tiptap/pm 无 "." 导出，
          // 对象式 manualChunks 会解析失败。
          // element-plus 不强制单 chunk：按需导入后仍 ~95% 组件被 P0 使用，若整体打包进
          // vendor 会进入首屏（门禁 300KB 超标）；自然分包让 el-table/date-picker 等仅
          // 列表路由使用的组件随路由 chunk 懒加载，共享部分由 rollup 上提 entry。
          manualChunks(id) {
            if (id.includes('@tiptap')) return 'tiptap'
          },
        },
      },
    },
  }
})
