import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
// Element Plus 按需导入（06 §2）：模板组件由 unplugin-vue-components 解析；
// 全局指令（v-loading）与反馈类 API（Message/MessageBox/Notification）样式手动引入
import { ElLoading } from 'element-plus'
import 'element-plus/es/components/loading/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/notification/style/css'

import App from './app.vue'
import { setUnauthorizedHandler } from './api/http'
import { vPermission } from './directives/v-permission'
import { bindNotifyRouter } from './features/approvals/composables/notifyWaitingApproval'
import { i18n } from './locales'
import { queryClient } from './query/client'
import { router } from './router'
import { useAuthStore } from './stores/auth'
import './styles/index.scss'
import { initWebVitals } from './utils/web-vitals'

async function bootstrap() {
  // MSW Mock 先行：后端未就绪模块可独立开发（06 §5.3）
  if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === 'true') {
    const { worker } = await import('@/mocks/browser')
    await worker.start({ onUnhandledRequest: 'bypass' })
  }

  const app = createApp(App)

  app.use(createPinia())
  app.use(i18n)
  app.use(router)
  app.use(VueQueryPlugin, { queryClient })
  // v-loading 全局指令（模板组件按需注册见 vite.config Components 插件）
  app.use(ElLoading)
  // 元素级权限裁剪（05 §3.1）
  app.directive('permission', vPermission)

  // 40101 → 清会话回登录页（03 §4，http ↔ store 解耦注册）
  setUnauthorizedHandler(() => useAuthStore().forceLogout())

  // waiting_approval 全局通知深链路由绑定（M5 决策 10）
  bindNotifyRouter(router)

  app.mount('#app')

  // Web Vitals 实测上报（05 §5；仅生产构建生效）
  initWebVitals()
}

void bootstrap()
