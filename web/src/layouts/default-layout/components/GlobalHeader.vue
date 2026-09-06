<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Expand, Fold } from '@element-plus/icons-vue'

import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'

/** 全局 Header（02 §1.1）：折叠开关 + Logo/企业名 + 语言切换 + 用户菜单；全局搜索/通知铃在 M2 接入 */
const { t, locale } = useI18n()
const appStore = useAppStore()
const authStore = useAuthStore()

const orgName = computed(() => authStore.org?.name ?? '')
const roleLabel = computed(() => authStore.user?.role ?? '')
const siderIcon = computed(() => (appStore.siderCollapsed ? Expand : Fold))

async function onLogout() {
  await ElMessageBox.confirm(t('common.logout') + '?', {
    confirmButtonText: t('common.confirm'),
    cancelButtonText: t('common.cancel'),
    type: 'warning',
  })
  await authStore.logout()
  ElMessage.success(t('common.logout'))
}

function onSwitchLang(lang: 'zh-CN' | 'en') {
  appStore.setLocale(lang)
  locale.value = lang
}
</script>

<template>
  <div class="global-header">
    <div class="global-header__left">
      <el-button link @click="appStore.toggleSider()">
        <el-icon :size="18">
          <component :is="siderIcon" />
        </el-icon>
      </el-button>
      <span class="global-header__logo">🤖 TradePilot AI</span>
      <el-tag v-if="orgName" size="small" effect="plain">{{ orgName }}</el-tag>
    </div>

    <div class="global-header__right">
      <el-dropdown trigger="click" @command="onSwitchLang">
        <span class="global-header__lang">{{ locale === 'zh-CN' ? '中文' : 'English' }}</span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="zh-CN">中文</el-dropdown-item>
            <el-dropdown-item command="en">English</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-dropdown trigger="click">
        <span class="global-header__user">
          <el-avatar :size="28">{{ authStore.user?.name?.slice(0, 1) ?? '?' }}</el-avatar>
          <span class="global-header__username">{{ authStore.user?.name }}</span>
          <el-tag size="small" type="info" effect="plain">{{ roleLabel }}</el-tag>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="logout" @click="onLogout">{{
              t('common.logout')
            }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<style scoped lang="scss">
.global-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  padding: 0 calc(var(--tp-spacing-base) * 4);

  &__left,
  &__right {
    display: flex;
    align-items: center;
    gap: calc(var(--tp-spacing-base) * 3);
  }

  &__logo {
    font-size: 16px;
    font-weight: 700;
  }

  &__lang {
    cursor: pointer;
    color: var(--tp-text-secondary);
  }

  &__user {
    display: flex;
    align-items: center;
    gap: calc(var(--tp-spacing-base) * 2);
    cursor: pointer;
  }

  &__username {
    color: var(--tp-text-primary);
  }
}
</style>
