<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { ElMessageBox } from 'element-plus'

import type { ApprovalItem, ApprovalType } from '@/api/types/approvals'
import { fetchApprovalSummary, fetchApprovals } from '@/api/resources/approvals'
import { qk } from '@/query/keys'

import { notifyEmailSent, useApprovalDispose } from '../composables/useApprovalDispose'
import ApprovalCard from '../components/ApprovalCard.vue'
import ApprovalDetailDrawer from '../components/ApprovalDetailDrawer.vue'
import EditApproveDialog from '../components/EditApproveDialog.vue'

defineOptions({ name: 'ApprovalsView' })

/**
 * 12 AI 审核中心主视图（12 §2/§3）：
 * - Tab 待审数来源 summary（all/email_send/customer_delete，D10：Tab 只渲染服务端返回类型）；
 * - 待审/已处置分段 + 分页卡片列表；三态处置入口 + 详情抽屉 + 编辑后批准；
 * - 06 waiting_approval 态「去审核中心」深链 ?approvalId=xxx 自动打开详情。
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { approve, reject } = useApprovalDispose()

// ===== Tab 与状态过滤 =====
const activeType = ref<ApprovalType | 'all'>('all')
const statusFilter = ref<'pending' | 'processed'>('pending')
const pageNum = ref(1)

const summaryQuery = useQuery({
  queryKey: qk.approvals.summary(),
  queryFn: fetchApprovalSummary,
  staleTime: 5_000,
  refetchInterval: 15_000,
})

/** D10：Tab 按服务端返回渲染（只含 P0 两类型 + all） */
const tabs = computed(() => summaryQuery.data.value?.tabs ?? [])

const listFilters = computed(() => ({
  // 12 §3.2：「全部」Tab 不传 type（后端枚举无 all 语义，缺省即全量）
  type: activeType.value === 'all' ? undefined : activeType.value,
  status: statusFilter.value,
  page: pageNum.value,
  pageSize: 20,
}))

const listQuery = useQuery({
  queryKey: computed(() => qk.approvals.list(listFilters.value)),
  queryFn: () => fetchApprovals(listFilters.value),
})

const items = computed(() => listQuery.data.value?.items ?? [])
const total = computed(() => listQuery.data.value?.total ?? 0)

function onTabChange(): void {
  pageNum.value = 1
  statusFilter.value = 'pending'
}

// ===== 详情抽屉（深链 ?approvalId=xxx） =====
const drawerVisible = ref(false)
const selected = ref<ApprovalItem | null>(null)

function openDetail(item: ApprovalItem): void {
  selected.value = item
  drawerVisible.value = true
}

/** 深链：列表加载后按 query.approvalId 打开并清参（keep-alive 恢复不重复弹） */
onMounted(() => {
  const approvalId = typeof route.query.approvalId === 'string' ? route.query.approvalId : ''
  if (!approvalId) return
  const target = items.value.find((a) => a.approvalId === approvalId)
  if (target) {
    openDetail(target)
    void router.replace({ path: '/approvals' })
  }
})

// ===== 卡片三态处置 =====
const editVisible = ref(false)
const editTarget = ref<ApprovalItem | null>(null)
const editDialogRef = ref<InstanceType<typeof EditApproveDialog> | null>(null)

async function onApprove(item: ApprovalItem): Promise<void> {
  const okResult = await approve(item.approvalId, { action: 'approve' })
  if (!okResult) return
  if (item.approvalType === 'email_send') notifyEmailSent(t)
  drawerVisible.value = false
}

function onEditApprove(item: ApprovalItem): void {
  editTarget.value = item
  editVisible.value = true
}

async function onEditApproveConfirm(approvalId: string, emailContent: string): Promise<void> {
  const okResult = await approve(approvalId, {
    action: 'edited_approved',
    editedContent: { aiProposal: { emailContent } },
  })
  editDialogRef.value?.onSettled()
  if (okResult) {
    editVisible.value = false
    drawerVisible.value = false
  }
}

/** 拒绝：reason 必填（12 §3.4），弹窗收集理由回流 AI 员工反馈闭环 */
async function onReject(item: ApprovalItem): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      t('approvals.rejectReasonTip'),
      t('approvals.reject'),
      {
        type: 'warning',
        inputPlaceholder: t('approvals.rejectReasonPlaceholder'),
        inputValidator: (input: string) =>
          input.trim().length > 0 ? true : t('approvals.rejectReasonRequired'),
        confirmButtonText: t('approvals.reject'),
        cancelButtonText: t('common.cancel'),
      },
    )
    const okResult = await reject(item.approvalId, value.trim())
    if (okResult) drawerVisible.value = false
  } catch {
    /* 用户取消 */
  }
}

// 深链详情中处置后，列表由 useApprovalDispose 统一失效；watch 深链参数变化（跨页跳转）
watch(
  () => route.query.approvalId,
  (approvalId) => {
    if (typeof approvalId !== 'string' || !approvalId || !items.value.length) return
    const target = items.value.find((a) => a.approvalId === approvalId)
    if (target) {
      openDetail(target)
      void router.replace({ path: '/approvals' })
    }
  },
)
</script>

<template>
  <div class="approvals" data-testid="approvals-view">
    <div class="approvals__toolbar">
      <el-tabs v-model="activeType" class="approvals__tabs" @tab-change="onTabChange">
        <el-tab-pane
          v-for="tab in tabs"
          :key="tab.type"
          :name="tab.type"
          :label="`${t(`approvals.tab.${tab.type}`)}${tab.count > 0 ? ` (${tab.count})` : ''}`"
        />
      </el-tabs>

      <el-segmented
        v-model="statusFilter"
        :options="[
          { label: t('approvals.pending'), value: 'pending' },
          { label: t('approvals.processed'), value: 'processed' },
        ]"
        size="small"
        class="approvals__status"
      />
    </div>

    <div v-loading="listQuery.isLoading.value" class="approvals__scroll">
      <template v-if="items.length">
        <ApprovalCard
          v-for="item in items"
          :key="item.approvalId"
          :approval="item"
          data-testid="approval-card"
          @approve="onApprove"
          @edit-approve="onEditApprove"
          @reject="onReject"
          @open="openDetail"
        />
        <div class="approvals__pagination">
          <el-pagination
            v-model:current-page="pageNum"
            layout="prev, pager, next"
            :total="total"
            :page-size="20"
            background
          />
        </div>
      </template>
      <el-empty
        v-else-if="!listQuery.isLoading.value"
        :description="
          statusFilter === 'pending' ? t('approvals.emptyPending') : t('approvals.emptyProcessed')
        "
        :image-size="88"
      />
    </div>

    <ApprovalDetailDrawer v-model="drawerVisible" :approval="selected" />

    <EditApproveDialog
      ref="editDialogRef"
      v-model="editVisible"
      :approval="editTarget"
      @confirm="onEditApproveConfirm"
    />
  </div>
</template>

<style scoped lang="scss">
.approvals {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;

  &__toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  &__tabs {
    flex: 1;

    :deep(.el-tabs__header) {
      margin-bottom: 0;
    }
  }

  &__status {
    flex-shrink: 0;
    margin-top: 4px;
  }

  &__scroll {
    flex: 1;
    min-height: 0;
    padding-top: 12px;
    overflow-y: auto;
  }

  &__pagination {
    display: flex;
    justify-content: center;
    padding: 12px 0;
  }
}
</style>
