import { computed } from 'vue'
import { useWindowSize } from '@vueuse/core'

import { useAppStore } from '@/stores/app'

/**
 * 侧边栏有效折叠态（04 §4 响应式约定）：手动开关与 1280px 自动折叠取并集。
 * Aside 容器宽度、菜单 collapse、Header 折叠图标必须共用同一口径，
 * 避免「菜单已折叠但容器仍占 240px」的宽度错位。
 */
const { width: windowWidth } = useWindowSize()

export function useSiderCollapsed() {
  const appStore = useAppStore()

  const siderCollapsed = computed(() => appStore.siderCollapsed || windowWidth.value < 1280)

  return { siderCollapsed }
}
