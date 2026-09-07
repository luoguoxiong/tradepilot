<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, Expand, Fold, Search } from '@element-plus/icons-vue'
import { useDebounceFn } from '@vueuse/core'

import { useSiderCollapsed } from '@/composables/useSiderCollapsed'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { useNotifyStore } from '@/stores/notify'

/**
 * 全局 Header（02 §1.1）：全局搜索（300ms 防抖）+ 通知铃（待审数徽标）+
 * 折叠开关 + Logo/企业名 + 语言切换 + 用户菜单。
 */
const router = useRouter()
const { t, locale } = useI18n()
const appStore = useAppStore()
const authStore = useAuthStore()
const notifyStore = useNotifyStore()
const { siderCollapsed } = useSiderCollapsed()

const orgName = computed(() => authStore.org?.name ?? '')
const roleLabel = computed(() => authStore.user?.role ?? '')
const siderIcon = computed(() => (siderCollapsed.value ? Expand : Fold))

// ===== 全局搜索：300ms 防抖（02 §1.1）；聚合结果页随 M3/M4 各模块数据接入后交付 =====
const keyword = ref('')
const onSearch = useDebounceFn((value: string) => {
  if (!value.trim()) return
  ElMessage.info(t('common.searchWip'))
}, 300)

// ===== 通知铃：待审数徽标（notifyStore 15s 轮询）=====
const pendingCount = computed(() => notifyStore.pendingCount)

function goApprovals() {
  router.push('/approvals')
}

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

    <div class="global-header__center">
      <el-input
        v-model="keyword"
        class="global-header__search"
        :placeholder="t('common.searchPlaceholder')"
        :prefix-icon="Search"
        clearable
        @input="onSearch"
      />
    </div>

    <div class="global-header__right">
      <el-dropdown trigger="click" @command="goApprovals">
        <span class="global-header__bell">
          <el-badge :value="pendingCount" :hidden="pendingCount === 0" :max="99">
            <el-icon :size="18"><Bell /></el-icon>
          </el-badge>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item disabled>
              {{ t('notify.pendingApprovals') }}
            </el-dropdown-item>
            <el-dropdown-item
              v-for="tab in notifyStore.tabs"
              :key="tab.type"
              divided
              @click="goApprovals"
            >
              <span class="global-header__tab-row">
                <span>{{ t(`enums.approvalTab.${tab.type}`) }}</span>
                <el-tag size="small" type="warning" effect="plain">{{ tab.count }}</el-tag>
              </span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

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

  &__center {
    flex: 1;
    display: flex;
    justify-content: center;
    padding: 0 calc(var(--tp-spacing-base) * 6);
  }

  &__search {
    max-width: 360px;
  }

  &__logo {
    font-size: 16px;
    font-weight: 700;
  }

  &__bell {
    display: flex;
    align-items: center;
    cursor: pointer;
    color: var(--tp-text-secondary);
  }

  &__tab-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    min-width: 140px;
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
