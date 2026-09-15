<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import type { TeamEfficiencyItem } from '@/api/types/manager'
import { useDictStore } from '@/stores/dict'

/**
 * 13 §1.3 AI 团队效率：全员 6 卡表格（含占位角色 → 「未设目标」）。
 * kpiPct 与 02 员工卡片同源（今日任务计数口径），故两页数字必然一致。
 */
const props = withDefaults(
  defineProps<{
    items: TeamEfficiencyItem[]
    loading?: boolean
  }>(),
  { loading: false },
)

const { t } = useI18n()
const dict = useDictStore()
</script>

<template>
  <el-card shadow="never" class="manager-efficiency">
    <template #header>
      <div class="manager-efficiency__header">
        <span class="manager-efficiency__title">{{ t('manager.efficiency.title') }}</span>
        <span class="manager-efficiency__scope">{{ t('manager.efficiency.todayScope') }}</span>
      </div>
    </template>

    <el-table
      v-loading="props.loading"
      :data="props.items"
      size="small"
      :empty-text="t('common.empty')"
      data-testid="manager-efficiency-table"
    >
      <el-table-column :label="t('manager.efficiency.employee')" min-width="140">
        <template #default="{ row }">
          <div class="manager-efficiency__employee">
            <span class="manager-efficiency__name">{{ row.name }}</span>
            <span class="manager-efficiency__role">{{ dict.label('employeeRole', row.role) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column :label="t('manager.efficiency.metric')" min-width="180">
        <template #default="{ row }">
          <span v-if="!row.metric" class="manager-efficiency__no-target">
            {{ t('manager.efficiency.noTarget') }}
          </span>
          <div v-else class="manager-efficiency__kpi">
            <span class="manager-efficiency__metric">{{ row.metric }}</span>
            <span class="manager-efficiency__count"> {{ row.achieved }} / {{ row.target }} </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column :label="t('manager.efficiency.progress')" width="200">
        <template #default="{ row }">
          <el-progress
            v-if="typeof row.kpiPct === 'number'"
            :percentage="row.kpiPct"
            :stroke-width="10"
            :status="row.kpiPct >= 100 ? 'success' : undefined"
          />
          <span v-else class="manager-efficiency__no-target">—</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped lang="scss">
.manager-efficiency {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__title {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__scope {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__employee {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__name {
    font-weight: 500;
    color: var(--tp-text-primary);
  }

  &__role {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__metric {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: var(--tp-text-secondary);
  }

  &__count {
    font-size: 13px;
    color: var(--tp-text-primary);
  }

  &__no-target {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
