<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import ActivityTimeline from '@/components/business/ActivityTimeline.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import { getCustomerActivities } from '@/api/resources/customers'
import type { ActivityItem, ActivityType } from '@/api/types/customers'
import type { PageResp } from '@/api/types/common'
import { qk } from '@/query/keys'
import { listQueryOptions } from '@/query/options'
import { DEFAULT_TIMEZONE } from '@/utils/date'
import { ENUMS } from '@/utils/enum-map'

/**
 * ActivitiesPanel Activities 页签（04 §1.5，与 /activities 同口径）：
 * 客户维度活动时间线 + type 筛选 + 分页；条目跳转（refType+refId）随对应业务模块 P1 启用。
 */
const props = withDefaults(defineProps<{ entityId: string; timezone?: string }>(), {
  timezone: DEFAULT_TIMEZONE,
})

const { t } = useI18n()

const typeFilter = ref<ActivityType | ''>('')
const page = ref(1)
const pageSize = 10

const filters = computed(() => ({
  page: page.value,
  pageSize,
  type: typeFilter.value || undefined,
}))

const activitiesQuery = useQuery<PageResp<ActivityItem>>({
  queryKey: computed(() => qk.customer360.activities(props.entityId, filters.value)),
  queryFn: () => getCustomerActivities(props.entityId, filters.value as never),
  ...listQueryOptions(),
})

watch(
  () => props.entityId,
  () => {
    page.value = 1
    typeFilter.value = ''
  },
)

const list = computed(() => activitiesQuery.data.value?.list ?? [])
const total = computed(() => activitiesQuery.data.value?.total ?? 0)

const typeOptions = ENUMS.activityType.map((o) => ({ value: o.value, label: t(o.labelKey) }))
</script>

<template>
  <div class="activities-panel">
    <div class="activities-panel__toolbar">
      <el-select
        v-model="typeFilter"
        clearable
        :placeholder="t('crm.activityType')"
        style="width: 180px"
        @change="page = 1"
      >
        <el-option
          v-for="opt in typeOptions"
          :key="opt.value"
          :value="opt.value"
          :label="opt.label"
        />
      </el-select>
    </div>

    <ActivityTimeline
      :items="list"
      :loading="activitiesQuery.isLoading.value"
      :timezone="timezone"
    />

    <div v-if="!list.length && !activitiesQuery.isLoading.value" class="activities-panel__empty">
      <EmptyState :title="t('c360.activitiesEmpty')" />
    </div>

    <el-pagination
      v-if="total > pageSize"
      class="activities-panel__pager"
      layout="prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="page"
      @current-change="page = $event"
    />
  </div>
</template>

<style scoped lang="scss">
.activities-panel {
  &__toolbar {
    margin-bottom: 16px;
  }

  &__pager {
    margin-top: 14px;
    justify-content: flex-end;
  }

  &__empty {
    padding: 24px 0;
  }
}
</style>
