<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 统一空态（04 §2.2）：无数据 / 无权限 / 降级占位三种形态。
 */
const props = withDefaults(
  defineProps<{
    type?: 'empty' | 'noPermission' | 'fallback'
    title?: string
    description?: string
  }>(),
  { type: 'empty', title: undefined, description: undefined },
)

const { t } = useI18n()

const defaultText = computed(() => {
  switch (props.type) {
    case 'noPermission':
      return t('common.noPermission')
    case 'fallback':
      return t('placeholder.title')
    default:
      return t('common.empty')
  }
})
</script>

<template>
  <el-empty :description="props.title ?? defaultText">
    <template v-if="props.description" #description>
      <div class="empty-state">
        <p class="empty-state__title">{{ props.title ?? defaultText }}</p>
        <p class="empty-state__desc">{{ props.description }}</p>
      </div>
    </template>
    <slot />
  </el-empty>
</template>

<style scoped lang="scss">
.empty-state {
  &__title {
    margin: 0;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__desc {
    margin: 8px 0 0;
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }
}
</style>
