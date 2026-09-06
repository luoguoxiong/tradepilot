import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

import App from './app.vue'
import { setUnauthorizedHandler } from './api/http'
import { i18n } from './locales'
import { queryClient } from './query/client'
import { router } from './router'
import { useAuthStore } from './stores/auth'
import './styles/index.scss'

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
  app.use(ElementPlus)

  // 40101 → 清会话回登录页（03 §4，http ↔ store 解耦注册）
  setUnauthorizedHandler(() => useAuthStore().forceLogout())

  app.mount('#app')
}

void bootstrap()
