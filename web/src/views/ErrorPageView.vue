<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const errorType = computed(() => route.meta.errorType ?? '404')

const title = computed(() =>
  errorType.value === '403' ? t('errors.forbiddenTitle') : t('errors.notFoundTitle'),
)
const desc = computed(() =>
  errorType.value === '403' ? t('errors.forbiddenDesc') : t('errors.notFoundDesc'),
)
const icon = computed(() => (errorType.value === '403' ? 'info' : 'warning'))

function backHome() {
  router.replace('/dashboard')
}
</script>

<template>
  <div class="error-page">
    <el-result :icon="icon" :title="title" :sub-title="desc">
      <template #extra>
        <el-button type="primary" @click="backHome">{{ t('errors.backHome') }}</el-button>
      </template>
    </el-result>
  </div>
</template>

<style scoped lang="scss">
.error-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}
</style>
