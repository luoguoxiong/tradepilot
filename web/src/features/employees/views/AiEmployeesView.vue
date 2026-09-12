<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import TaskWorkspace from '@/features/lead-gen/components/TaskWorkspace.vue'
import EmployeeCreateWizard from '@/features/employees/components/EmployeeCreateWizard.vue'
import {
  getEmployeeRoles,
  getEmployees,
  pauseEmployee,
  resumeEmployee,
} from '@/api/resources/employees'
import type { EmployeeCard } from '@/api/types/employees'
import { staleTime } from '@/query/options'
import { qk } from '@/query/keys'
import { usePermission } from '@/composables/usePermission'
import { useDictStore } from '@/stores/dict'

/**
 * 02-AI数字员工中心（六卡片墙，02 PRD §2.1）：
 * - D4：外贸经理/跟单员工 P0 同口径占位——卡片展示、入口禁用（idle + statusDetail）；
 * - D5：卡片渲染 currentTask 轻量对象（任务名/状态/进度），无 14 依赖；
 * - 任务详情抽屉复用 TaskWorkspace（SSE 流 + 降级轮询）；
 * - 创建向导仅 admin/manager（v-permission + usePermission 双层裁剪）。
 */
const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()
const { canManage } = usePermission()
const dict = useDictStore()

const employeesQuery = useQuery({
  queryKey: qk.employees.list(),
  queryFn: getEmployees,
  staleTime: staleTime.LIST,
  refetchInterval: 15_000, // 状态/KPI 有实时性（mock 由每次请求重放派生）
})

const rolesQuery = useQuery({
  queryKey: qk.employeeRoles,
  queryFn: getEmployeeRoles,
  staleTime: staleTime.DICT,
})

const cards = computed<EmployeeCard[]>(() => employeesQuery.data.value?.items ?? [])

const ROLE_ICONS: Record<string, string> = {
  lead_hunter: '🤖',
  customer_researcher: '🔍',
  sales: '💼',
  follow_up: '📧',
  merchandiser: '📦',
  manager: '👔',
}

// ===== 任务详情抽屉 =====
const drawerTaskId = ref<string | null>(null)
const drawerTitle = ref('')

function openTaskDrawer(card: EmployeeCard) {
  if (!card.currentTask) return
  drawerTaskId.value = card.currentTask.taskId
  drawerTitle.value = `${card.name} · ${card.currentTask.title}`
}

/** 抽屉关闭置空任务 id（destroy-on-close 卸载 TaskWorkspace 并停流） */
function onDrawerVisibility(visible: unknown) {
  if (!visible) {
    drawerTaskId.value = null
    drawerTitle.value = ''
  }
}

// ===== 创建向导 =====
const wizardVisible = ref(false)

function onCreated() {
  void queryClient.invalidateQueries({ queryKey: qk.employees.all })
}

function enterWorkspace(card: EmployeeCard) {
  if (!card.workspacePath) return
  void router.push(card.workspacePath)
}

// ===== 暂停 / 恢复（02 §3.4，仅 admin/manager） =====
const busyEmployeeId = ref<string | null>(null)

/** 有执行中任务 → 展示「暂停」；否则展示「恢复」（后端幂等，返回 0 亦安全） */
const isWorking = (card: EmployeeCard) =>
  card.status === 'working' || card.currentTask?.status === 'running'

async function onPause(card: EmployeeCard) {
  busyEmployeeId.value = card.employeeId
  try {
    const { pausedTasks } = await pauseEmployee(card.employeeId)
    ElMessage.success(t('employees.pauseDone', { n: pausedTasks }))
    await queryClient.invalidateQueries({ queryKey: qk.employees.all })
  } finally {
    busyEmployeeId.value = null
  }
}

async function onResume(card: EmployeeCard) {
  busyEmployeeId.value = card.employeeId
  try {
    const { resumedTasks } = await resumeEmployee(card.employeeId)
    ElMessage.success(t('employees.resumeDone', { n: resumedTasks }))
    await queryClient.invalidateQueries({ queryKey: qk.employees.all })
  } finally {
    busyEmployeeId.value = null
  }
}
</script>

<template>
  <div class="ai-employees">
    <div class="ai-employees__header">
      <div>
        <h3 class="ai-employees__title">{{ t('employees.title') }}</h3>
        <span class="ai-employees__legend">{{ t('employees.statusLegend') }}</span>
      </div>
      <el-button v-permission="['admin', 'manager']" type="primary" @click="wizardVisible = true">
        + {{ t('employees.create') }}
      </el-button>
    </div>

    <div v-loading="employeesQuery.isLoading.value">
      <EmptyState v-if="cards.length === 0" />
      <div v-else class="ai-employees__grid">
        <el-card
          v-for="card in cards"
          :key="card.employeeId"
          shadow="never"
          class="ai-employees__card"
        >
          <div class="ai-employees__card-head">
            <span class="ai-employees__card-icon">{{ ROLE_ICONS[card.role] ?? '🤖' }}</span>
            <div class="ai-employees__card-name">
              <span>{{ card.name }}</span>
              <span class="ai-employees__card-role">{{
                dict.label('employeeRole', card.role)
              }}</span>
            </div>
            <AiStatusTag group="employeeStatus" :value="card.status" :detail="card.statusDetail" />
          </div>

          <!-- 今日产出 -->
          <div class="ai-employees__stats">
            <template v-if="card.todayStats.length">
              <span v-for="stat in card.todayStats" :key="stat.label" class="ai-employees__stat">
                {{ stat.label }}
                <strong>{{ stat.count }}</strong>
                {{ stat.unit }}
              </span>
            </template>
            <span v-else class="ai-employees__stat is-empty">—</span>
          </div>

          <!-- 当前任务（D5 轻量对象） -->
          <div class="ai-employees__task">
            <template v-if="card.currentTask">
              <div class="ai-employees__task-row">
                <span class="ai-employees__task-title">🎯 {{ card.currentTask.title }}</span>
                <el-button link type="primary" size="small" @click="openTaskDrawer(card)">
                  {{ t('employees.viewTaskLog') }}
                </el-button>
              </div>
              <el-progress
                :percentage="card.currentTask.progressPct"
                :stroke-width="6"
                :status="card.currentTask.status === 'failed' ? 'exception' : undefined"
              />
            </template>
            <span v-else class="ai-employees__task-empty">{{ t('employees.noCurrentTask') }}</span>
          </div>

          <!-- KPI（D4：占位卡片随模块启用后展示） -->
          <div v-if="card.kpi" class="ai-employees__kpi">
            <div class="ai-employees__kpi-row">
              <span class="ai-employees__kpi-label">{{ t('employees.kpi') }}</span>
              <span class="ai-employees__kpi-num">
                {{ card.kpi.achieved }} / {{ card.kpi.target }}
              </span>
            </div>
            <el-progress :percentage="card.kpi.progressPct" :stroke-width="6" />
          </div>
          <div v-else class="ai-employees__kpi is-placeholder">
            {{ t('employees.kpiPlaceholder') }}
          </div>

          <div class="ai-employees__card-footer">
            <template v-if="canManage">
              <el-button
                v-if="isWorking(card)"
                link
                type="warning"
                size="small"
                :loading="busyEmployeeId === card.employeeId"
                @click="onPause(card)"
              >
                {{ t('employees.pause') }}
              </el-button>
              <el-button
                v-else
                link
                type="primary"
                size="small"
                :loading="busyEmployeeId === card.employeeId"
                @click="onResume(card)"
              >
                {{ t('employees.resume') }}
              </el-button>
            </template>
            <el-tooltip
              :content="t('employees.comingSoonTip')"
              :disabled="Boolean(card.workspacePath)"
              placement="top"
            >
              <span>
                <el-button
                  link
                  type="primary"
                  :disabled="!card.workspacePath"
                  @click="enterWorkspace(card)"
                >
                  {{ t('employees.enterWorkspace') }} →
                </el-button>
              </span>
            </el-tooltip>
          </div>
        </el-card>
      </div>
    </div>

    <!-- 任务详情抽屉：复用 TaskWorkspace（02 §3.3 完整任务列表/重试随 14 P1） -->
    <el-drawer
      :model-value="Boolean(drawerTaskId)"
      :title="drawerTitle || t('employees.taskDrawerTitle')"
      size="560px"
      destroy-on-close
      @update:model-value="onDrawerVisibility"
    >
      <TaskWorkspace
        v-if="drawerTaskId"
        :key="drawerTaskId"
        :task-id="drawerTaskId"
        :log-height="420"
        :invalidate-on-done="[qk.employees.all]"
      />
    </el-drawer>

    <EmployeeCreateWizard
      v-if="canManage"
      :visible="wizardVisible"
      :roles="rolesQuery.data.value ?? []"
      @update:visible="wizardVisible = $event"
      @created="onCreated"
    />
  </div>
</template>

<style scoped lang="scss">
.ai-employees {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  &__title {
    margin: 0;
    font-size: 18px;
    color: var(--tp-text-primary);
  }

  &__legend {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
  }

  &__card-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  &__card-icon {
    font-size: 26px;
  }

  &__card-name {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__card-role {
    font-size: 12px;
    font-weight: 400;
    color: var(--tp-text-tertiary);
  }

  &__stats {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
    min-height: 20px;
  }

  &__stat {
    font-size: 13px;
    color: var(--tp-text-secondary);

    strong {
      color: var(--tp-text-primary);
    }

    &.is-empty {
      color: var(--tp-text-tertiary);
    }
  }

  &__task {
    padding: 10px;
    margin-bottom: 12px;
    border-radius: var(--tp-radius-base, 8px);
    background: var(--tp-bg-secondary, #fafafa);
  }

  &__task-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  &__task-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--tp-text-primary);
  }

  &__task-empty {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__kpi {
    margin-bottom: 12px;

    &.is-placeholder {
      font-size: 12px;
      color: var(--tp-text-tertiary);
    }
  }

  &__kpi-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  &__kpi-label {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__kpi-num {
    font-size: 13px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__card-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
}
</style>
