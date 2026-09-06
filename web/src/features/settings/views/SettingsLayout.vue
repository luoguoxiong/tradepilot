<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

/**
 * 系统设置二级布局（16 FR-01~12）：左侧子导航 + 内容区。
 * 子路由不进全局 Sider（meta.menu 不设置），设置内导航承载 12 个子模块。
 */
const route = useRoute()
const { t } = useI18n()

const NAV = [
  { path: '/settings/org', titleKey: 'settings.orgInfo' },
  { path: '/settings/members', titleKey: 'settings.members' },
  { path: '/settings/mailboxes', titleKey: 'settings.mailboxes' },
  { path: '/settings/approval-rules', titleKey: 'settings.approvalRules' },
  { path: '/settings/notifications', titleKey: 'settings.notifications' },
  { path: '/settings/ai-employees', titleKey: 'settings.aiEmployees' },
  { path: '/settings/crm-integration', titleKey: 'settings.crmIntegration', p1: true },
  { path: '/settings/pricing-rules', titleKey: 'settings.pricingRules', p1: true },
  { path: '/settings/ai-models', titleKey: 'settings.aiModels', p1: true },
  { path: '/settings/api-keys', titleKey: 'settings.apiKeys', p1: true },
]

const title = computed(() => {
  const current = NAV.find((item) => route.path.startsWith(item.path))
  return current ? t(current.titleKey) : ''
})
</script>

<template>
  <div class="settings-layout">
    <aside class="settings-layout__nav">
      <el-menu :default-active="route.path" router>
        <el-menu-item v-for="item in NAV" :key="item.path" :index="item.path">
          <span>{{ t(item.titleKey) }}</span>
          <el-tag
            v-if="item.p1"
            size="small"
            type="info"
            effect="plain"
            class="settings-layout__tag"
          >
            {{ t('common.comingSoon') }}
          </el-tag>
        </el-menu-item>
      </el-menu>
    </aside>
    <section class="settings-layout__content">
      <h2 class="settings-layout__title">{{ title }}</h2>
      <router-view />
    </section>
  </div>
</template>

<style scoped lang="scss">
.settings-layout {
  display: flex;
  gap: calc(var(--tp-spacing-base) * 6);
  min-height: 100%;

  &__nav {
    width: 220px;
    flex-shrink: 0;

    :deep(.el-menu) {
      border-right: none;
    }
  }

  &__content {
    flex: 1;
    min-width: 0;
    padding: calc(var(--tp-spacing-base) * 4) calc(var(--tp-spacing-base) * 6);
    background: var(--tp-bg-container);
    border-radius: var(--tp-border-radius-base);
  }

  &__title {
    margin: 0 0 calc(var(--tp-spacing-base) * 5);
    font-size: 16px;
    font-weight: 600;
  }

  &__tag {
    margin-left: 8px;
  }
}
</style>
