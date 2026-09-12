<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import { fetchNotificationSettings, updateNotificationSettings } from '@/api/resources/settings'
import { handleApiError } from '@/api/error-handler'
import type { NotificationSettings } from '@/api/types/settings'
import { useFormLeaveGuard } from '@/composables/useFormLeaveGuard'

/**
 * 通知设置（16 FR-09 / §2.8，P0）：3 类事件 × 站内/邮件渠道开关，保存即时生效。
 * 站内 = 01 徽标轮询；邮件 = 复用 FR-05 通道，审批超时提醒收件人为经理（12 §7.2）。
 */
const { t } = useI18n()

const loading = ref(false)
const saving = ref(false)

const EVENTS = ['approval_pending', 'risk_alert', 'task_failed'] as const

const form = reactive<NotificationSettings>({
  events: {
    approval_pending: { site: true, email: true },
    risk_alert: { site: true, email: true },
    task_failed: { site: true, email: false },
  },
})

// 02 §6 表单离开拦截：加载完成后开关变更即置脏，保存成功复位
const loaded = ref(false)
const dirty = ref(false)
watch(
  form,
  () => {
    if (loaded.value && !saving.value) dirty.value = true
  },
  { deep: true },
)
useFormLeaveGuard({ isDirty: () => dirty.value })

onMounted(async () => {
  loading.value = true
  try {
    const settings = await fetchNotificationSettings()
    Object.assign(form.events, settings.events)
    loaded.value = true
  } catch (error) {
    handleApiError(error)
  } finally {
    loading.value = false
  }
})

async function save() {
  saving.value = true
  try {
    await updateNotificationSettings({ events: form.events })
    dirty.value = false
    ElMessage.success(t('settings.savedNow'))
  } catch (error) {
    handleApiError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-form v-loading="loading" class="notifications" label-width="200px" @submit.prevent>
    <div class="notifications__head">
      <span></span>
      <span>{{ t('settings.channelSite') }}</span>
      <span>{{ t('settings.channelEmail') }}</span>
    </div>
    <div v-for="event in EVENTS" :key="event" class="notifications__row">
      <span>{{ t(`settings.event.${event}`) }}</span>
      <el-switch v-model="form.events[event].site" />
      <el-switch v-model="form.events[event].email" />
    </div>
    <el-form-item>
      <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
    </el-form-item>
  </el-form>
</template>

<style scoped lang="scss">
.notifications {
  max-width: 560px;

  &__head,
  &__row {
    display: grid;
    grid-template-columns: 1fr 100px 100px;
    align-items: center;
    gap: calc(var(--tp-spacing-base) * 2);
  }

  &__head {
    margin-bottom: calc(var(--tp-spacing-base) * 2);
    color: var(--tp-text-secondary);
  }

  &__row {
    padding: calc(var(--tp-spacing-base) * 2) 0;
    border-bottom: 1px solid var(--tp-border-color);
  }
}
</style>
