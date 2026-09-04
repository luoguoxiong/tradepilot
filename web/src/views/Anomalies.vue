<script setup lang="ts">
/**
 * /anomalies 异常看板：
 * 每日工作入口——按类型聚合展示待办异常（交期临近/逾期/定金未到/长期停滞），一键跳转订单处理
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type Anomaly, type AnomalyType } from '../api/client'

const router = useRouter()
const anomalies = ref<Anomaly[]>([])
const loading = ref(false)

const TYPE_META: Record<AnomalyType, { label: string; level: 'high' | 'medium' | 'low' }> = {
  overdue: { label: '交期逾期', level: 'high' },
  due_soon: { label: '交期临近', level: 'medium' },
  deposit_pending: { label: '定金未到', level: 'medium' },
  stalled: { label: '长期停滞', level: 'low' }
}

const counts = computed(() => {
  const c: Record<AnomalyType, number> = { overdue: 0, due_soon: 0, deposit_pending: 0, stalled: 0 }
  anomalies.value.forEach((a) => { c[a.type]++ })
  return c
})

/** 按级别排序分组展示（高→中→低） */
const grouped = computed(() => {
  const order: AnomalyType[] = ['overdue', 'due_soon', 'deposit_pending', 'stalled']
  return order
    .map((t) => ({ type: t, items: anomalies.value.filter((a) => a.type === t) }))
    .filter((g) => g.items.length > 0)
})

async function load(): Promise<void> {
  loading.value = true
  try {
    anomalies.value = await api.listAnomalies()
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <h2 class="page-title">异常看板</h2>
    <p class="page-sub">系统实时检测的待办异常，点击「去处理」进入订单详情</p>

    <!-- KPI 卡 -->
    <div class="anomaly-grid">
      <div v-for="(meta, type) in TYPE_META" :key="type" class="anomaly-card" :class="meta.level">
        <h3>{{ meta.label }}</h3>
        <div class="count">{{ counts[type] }}</div>
      </div>
      <div v-if="!anomalies.length" class="anomaly-card ok">
        <h3>今日无待办</h3>
        <div class="count">✓</div>
      </div>
    </div>

    <!-- 分组列表 -->
    <el-empty v-if="!anomalies.length && !loading" description="所有订单进展正常" />

    <div v-for="group in grouped" :key="group.type" class="anomaly-group">
      <h3 class="group-title">
        {{ TYPE_META[group.type].label }}
        <el-tag :type="TYPE_META[group.type].level === 'high' ? 'danger' : TYPE_META[group.type].level === 'medium' ? 'warning' : 'info'" size="small">
          {{ group.items.length }}
        </el-tag>
      </h3>
      <el-table :data="group.items" size="default">
        <el-table-column prop="order_no" label="订单号" width="150" />
        <el-table-column prop="customer_name" label="客户" min-width="140" show-overflow-tooltip />
        <el-table-column label="金额" width="130">
          <template #default="{ row }">{{ row.currency }} {{ Number(row.total_amount).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column prop="delivery_date" label="交期" width="120" />
        <el-table-column prop="message" label="异常说明" min-width="260" show-overflow-tooltip />
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="router.push(`/orders/${row.order_id}`)">去处理</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.page-title { margin: 8px 0 4px; font-size: 20px; }
.page-sub { color: #6b7280; font-size: 13px; margin-bottom: 8px; }
.anomaly-group { margin-top: 18px; }
.group-title { font-size: 15px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
</style>
