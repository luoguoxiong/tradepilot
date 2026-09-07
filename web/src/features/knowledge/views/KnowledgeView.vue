<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'
import { WarningFilled } from '@element-plus/icons-vue'
import type { UploadRequestOptions } from 'element-plus'

import {
  deleteKnowledgeDocument,
  getKnowledgeDocuments,
  getKnowledgeStats,
  retryKnowledgeIndexing,
  uploadKnowledgeDocuments,
} from '@/api/resources/knowledge'
import type { KnowledgeCategory, KnowledgeDocument } from '@/api/types/knowledge'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { usePermission } from '@/composables/usePermission'
import { useDictStore } from '@/stores/dict'
import { formatRelative } from '@/utils/date'
import { ApiError } from '@/api/http'
import SearchPreviewDialog from '../components/SearchPreviewDialog.vue'

defineOptions({ name: 'KnowledgeView' })

/**
 * 11 知识中心（FR-01~06，04 §3.6）：
 * - 分类 Tab + 状态列（failed 显示重试，仅经理/管理员）；
 * - 批量上传 → indexing 态 → 列表轮询 3s 至终态；
 * - 软删二次确认注明「历史引用保留回溯信息」，删除后列表即时失效；
 * - 检索预览（AI 引用测试）：noResult 明示禁止编造。
 */
const { t } = useI18n()
const queryClient = useQueryClient()
const dict = useDictStore()
const { canManage } = usePermission()

const category = ref<KnowledgeCategory | 'all'>('all')
const keyword = ref<string | undefined>(undefined)

const listFilters = computed(() => ({
  category: category.value,
  keyword: keyword.value,
  page: 1,
  pageSize: 20,
}))

const listQuery = useQuery({
  queryKey: computed(() => qk.knowledge.list(listFilters.value)),
  queryFn: () => getKnowledgeDocuments(listFilters.value),
  staleTime: staleTime.LIST,
  // 索引轮询：列表存在 indexing 行时 3s 轮询，至终态自动停（04 §3.6）
  refetchInterval: (query) =>
    query.state.data?.list.some((doc: KnowledgeDocument) => doc.status === 'indexing')
      ? 3_000
      : false,
})

const statsQuery = useQuery({
  queryKey: qk.knowledge.stats(),
  queryFn: getKnowledgeStats,
  staleTime: staleTime.DETAIL,
})

const docs = computed<KnowledgeDocument[]>(() => listQuery.data.value?.list ?? [])
const total = computed(() => listQuery.data.value?.total ?? 0)
const stats = computed(() => statsQuery.data.value)

const tabs = computed(() => [
  { key: 'all' as const, label: t('followUp.tabAll') },
  { key: 'product' as const, label: t('enums.knowledgeCategory.product') },
  { key: 'company' as const, label: t('enums.knowledgeCategory.company') },
  { key: 'sales' as const, label: t('enums.knowledgeCategory.sales') },
  { key: 'customer' as const, label: t('enums.knowledgeCategory.customer') },
  { key: 'faq' as const, label: t('enums.knowledgeCategory.faq') },
])

function invalidateAll() {
  void queryClient.invalidateQueries({ queryKey: qk.knowledge.all })
}

// ===== 批量上传（multipart，逐文件一条；42201 逐项反馈）=====
const uploadCategory = ref<KnowledgeCategory>('product')
const uploading = ref(false)

const ACCEPT_EXTS = ['pdf', 'docx', 'md', 'txt']

async function onUploadRequest(options: UploadRequestOptions) {
  const file = options.file as File
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ACCEPT_EXTS.includes(ext)) {
    ElMessage.error(t('knowledge.uploadAccept'))
    return
  }
  uploading.value = true
  try {
    const results = await uploadKnowledgeDocuments([file], uploadCategory.value)
    ElMessage.success(t('knowledge.uploadSuccess', { count: results.length }))
    invalidateAll()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiError ? error.message : t('common.operationFailed'),
    )
  } finally {
    uploading.value = false
  }
}

// ===== 重试索引（failed → indexing，仅经理/管理员）=====
async function onRetry(doc: KnowledgeDocument) {
  try {
    await retryKnowledgeIndexing(doc.docId)
    ElMessage.success(t('enums.knowledgeDocStatus.indexing'))
    invalidateAll()
  } catch (error) {
    ElMessage.error((error as Error).message || t('common.operationFailed'))
  }
}

// ===== 软删（二次确认注明留痕语义，11 §3.4）=====
async function onDelete(doc: KnowledgeDocument) {
  try {
    await ElMessageBox.confirm(
      t('knowledge.deleteConfirm', { name: doc.fileName }),
      t('knowledge.deleteTitle'),
      { type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel') },
    )
  } catch {
    return
  }
  try {
    await deleteKnowledgeDocument(doc.docId)
    ElMessage.success(t('knowledge.deleted'))
    invalidateAll()
  } catch (error) {
    ElMessage.error((error as Error).message || t('common.operationFailed'))
  }
}

// ===== 检索预览 =====
const searchVisible = ref(false)
</script>

<template>
  <div class="knowledge">
    <div class="knowledge__header">
      <div>
        <h3 class="knowledge__title">{{ t('menu.knowledge') }}</h3>
        <span v-if="stats" class="knowledge__hint">
          {{ t('knowledge.documentsCount') }}: {{ stats.documentsCount }} ·
          {{ t('knowledge.chunksCount') }}: {{ stats.chunksCount }} ·
          {{ t('knowledge.lastIndexedAt') }}: {{ formatRelative(stats.lastIndexedAt) }}
        </span>
      </div>
      <div class="knowledge__actions">
        <el-button @click="searchVisible = true">{{ t('knowledge.searchTitle') }}</el-button>
        <el-upload
          :show-file-list="false"
          :http-request="onUploadRequest"
          :accept="ACCEPT_EXTS.map((e) => `.${e}`).join(',')"
          multiple
        >
          <el-button type="primary" :loading="uploading">
            {{ uploading ? t('knowledge.uploading') : `+ ${t('knowledge.upload')}` }}
          </el-button>
        </el-upload>
      </div>
    </div>

    <el-tabs v-model="category" class="knowledge__tabs">
      <el-tab-pane v-for="tab in tabs" :key="tab.key" :name="tab.key" :label="tab.label" />
    </el-tabs>

    <div class="knowledge__toolbar">
      <el-input
        v-model="keyword"
        :placeholder="t('proTable.keyword')"
        clearable
        style="width: 220px"
        @clear="keyword = undefined"
      />
    </div>

    <el-table v-loading="listQuery.isLoading.value" :data="docs" row-key="docId" stripe>
      <el-table-column prop="fileName" :label="t('knowledge.colFile')" min-width="220" />
      <el-table-column prop="category" :label="t('knowledge.colCategory')" width="100">
        <template #default="{ row }">
          <span
            class="knowledge__category"
            :style="{ color: dict.color('knowledgeCategory', row.category) }"
          >
            {{ dict.label('knowledgeCategory', row.category) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="status" :label="t('knowledge.colStatus')" width="140">
        <template #default="{ row }">
          <div class="knowledge__status">
            <span :style="{ color: dict.color('knowledgeDocStatus', row.status) }">
              {{ dict.label('knowledgeDocStatus', row.status) }}
            </span>
            <el-tooltip
              v-if="row.status === 'failed' && row.error"
              :content="t('knowledge.errorTip', { error: row.error })"
              placement="top"
            >
              <el-icon class="knowledge__error-icon"><WarningFilled /></el-icon>
            </el-tooltip>
            <el-button
              v-if="row.status === 'failed' && canManage"
              link
              type="primary"
              size="small"
              @click="onRetry(row)"
            >
              {{ t('knowledge.retry') }}
            </el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="size" :label="t('knowledge.colSize')" width="90" />
      <el-table-column prop="fileType" :label="t('knowledge.colFormat')" width="80">
        <template #default="{ row }">{{ row.fileType?.toUpperCase() ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="uploadedAt" :label="t('knowledge.colUploadedAt')" width="160">
        <template #default="{ row }">{{ formatRelative(row.uploadedAt) }}</template>
      </el-table-column>
      <el-table-column prop="updatedBy" :label="t('knowledge.colUpdatedBy')" width="110" />
      <el-table-column
        v-if="canManage"
        :label="t('knowledge.colActions')"
        width="90"
        fixed="right"
      >
        <template #default="{ row }">
          <el-button link type="danger" size="small" @click="onDelete(row)">
            {{ t('knowledge.delete') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>{{ t('common.empty') }}</template>
    </el-table>

    <div class="knowledge__pager">
      <el-pagination
        :page-size="20"
        :total="total"
        layout="total, prev, pager, next"
        :background="true"
      />
    </div>

    <SearchPreviewDialog v-model:visible="searchVisible" />
  </div>
</template>

<style scoped lang="scss">
.knowledge {
  &__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__hint {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__tabs {
    margin-top: 8px;

    :deep(.el-tabs__header) {
      margin-bottom: 8px;
    }
  }

  &__toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 8px;
  }

  &__category {
    font-weight: 500;
  }

  &__status {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  &__error-icon {
    color: var(--ai-risk);
    cursor: help;
  }

  &__pager {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }
}
</style>
