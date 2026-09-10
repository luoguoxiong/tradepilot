<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  createAiModel,
  deleteAiModel,
  fetchAiModels,
  selectAiModel,
  updateAiModel,
} from '@/api/resources/settings'
import { handleApiError } from '@/api/error-handler'
import type {
  AiModel,
  AiModelCatalog,
  AiModelType,
  CreateAiModelReq,
  UpdateAiModelReq,
} from '@/api/types/settings'
import EmptyState from '@/components/business/EmptyState.vue'
import AiModelForm from '@/features/settings/components/AiModelForm.vue'
import { useDictStore } from '@/stores/dict'

/**
 * AI 模型配置（16 FR-10 扩展）：
 * - 三 Tab 管理「大语言模型 / 向量模型 / 搜索供应商」三类台账，每类可维护多个；
 * - 每个类型至多一个「当前生效」模型，作为整个服务该类型的默认值；
 * - 凭据仅提交不回显，服务端加密存储。
 */
const { t } = useI18n()
const dict = useDictStore()

const loading = ref(false)
const catalog = ref<AiModelCatalog>({
  models: [],
  selection: { llm: null, embedding: null, search: null },
})
const activeType = ref<AiModelType>('llm')

const dialogVisible = ref(false)
const editing = ref<AiModel | null>(null)
const submitting = ref(false)
const selectingId = ref<string | null>(null)

const models = computed(() => catalog.value.models.filter((m) => m.type === activeType.value))
const formType = computed<AiModelType>(() => editing.value?.type ?? activeType.value)

async function load() {
  loading.value = true
  try {
    catalog.value = await fetchAiModels()
  } catch (error) {
    handleApiError(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  editing.value = null
  dialogVisible.value = true
}

function openEdit(row: AiModel) {
  editing.value = row
  dialogVisible.value = true
}

async function onSubmit(req: CreateAiModelReq | UpdateAiModelReq) {
  submitting.value = true
  try {
    if (editing.value) {
      await updateAiModel(editing.value.id, req as UpdateAiModelReq)
      ElMessage.success(t('settings.modelUpdated'))
    } else {
      await createAiModel(req as CreateAiModelReq)
      ElMessage.success(t('settings.modelCreated'))
    }
    dialogVisible.value = false
    await load()
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

async function onSelect(row: AiModel) {
  if (row.isSelected) return
  selectingId.value = row.id
  try {
    catalog.value = await selectAiModel({ type: row.type, modelId: row.id })
    ElMessage.success(t('settings.setModelSuccess'))
  } catch (error) {
    handleApiError(error)
  } finally {
    selectingId.value = null
  }
}

async function onDelete(row: AiModel) {
  const confirmed = await ElMessageBox.confirm(
    t('settings.deleteModelConfirm', { name: row.name }),
    {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteAiModel(row.id)
    ElMessage.success(t('settings.modelDeleted'))
    await load()
  } catch (error) {
    handleApiError(error)
  }
}
</script>

<template>
  <div v-loading="loading" class="ai-models">
    <el-alert
      class="ai-models__alert"
      type="info"
      :title="t('settings.aiModelsHint')"
      :closable="false"
      show-icon
    />

    <el-tabs v-model="activeType" class="ai-models__tabs">
      <el-tab-pane :label="t('settings.tabLlm')" name="llm" />
      <el-tab-pane :label="t('settings.tabEmbedding')" name="embedding" />
      <el-tab-pane :label="t('settings.tabSearch')" name="search" />
    </el-tabs>

    <div class="ai-models__toolbar">
      <span class="ai-models__hint">
        {{
          activeType === 'llm'
            ? t('settings.aiModelsLlmHint')
            : activeType === 'embedding'
              ? t('settings.aiModelsEmbeddingHint')
              : t('settings.aiModelsSearchHint')
        }}
      </span>
      <el-button type="primary" @click="openCreate">{{ t('settings.addModel') }}</el-button>
    </div>

    <el-table :data="models" stripe>
      <el-table-column :label="t('settings.modelName')" min-width="150">
        <template #default="{ row }">
          <span class="ai-models__name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.modelProvider')" min-width="120">
        <template #default="{ row }">{{ dict.label('aiModelProvider', row.provider) }}</template>
      </el-table-column>
      <el-table-column
        :label="
          activeType === 'search' ? t('settings.modelBaseUrl') : t('settings.modelIdentifier')
        "
        min-width="220"
      >
        <template #default="{ row }">
          <div class="ai-models__model">
            {{ activeType === 'search' ? (row.baseUrl ?? '—') : row.model }}
          </div>
          <div v-if="activeType !== 'search' && row.baseUrl" class="ai-models__base-url">
            {{ row.baseUrl }}
          </div>
        </template>
      </el-table-column>
      <el-table-column
        v-if="activeType !== 'search'"
        :label="
          activeType === 'embedding'
            ? t('settings.modelDimensions')
            : t('settings.modelTemperature')
        "
        width="120"
      >
        <template #default="{ row }">
          {{ row.type === 'embedding' ? (row.dimensions ?? '—') : row.temperature }}
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.modelApiKey')" width="110">
        <template #default="{ row }">
          <el-tag :type="row.hasApiKey ? 'success' : 'info'" size="small" effect="plain">
            {{ row.hasApiKey ? t('settings.modelApiKeySet') : t('settings.modelApiKeyUnset') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.modelCurrent')" width="120">
        <template #default="{ row }">
          <el-tag v-if="row.isSelected" type="success" size="small" effect="light">
            {{ t('settings.currentTag') }}
          </el-tag>
          <el-button
            v-else
            link
            size="small"
            :loading="selectingId === row.id"
            @click="onSelect(row)"
          >
            {{ t('settings.setAsCurrent') }}
          </el-button>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.actions')" width="140" fixed="right">
        <template #default="{ row }">
          <el-button link size="small" @click="openEdit(row)">{{ t('common.edit') }}</el-button>
          <el-button link size="small" type="danger" @click="onDelete(row)">
            {{ t('common.delete') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState />
      </template>
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="editing ? t('settings.editModel') : t('settings.addModel')"
      width="680px"
      destroy-on-close
    >
      <AiModelForm :type="formType" :model="editing" :submitting="submitting" @submit="onSubmit" />
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.ai-models {
  &__alert {
    margin-bottom: calc(var(--tp-spacing-base) * 4);
  }

  &__tabs {
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__hint {
    color: var(--tp-text-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  &__name {
    font-weight: 500;
  }

  &__model {
    font-family: monospace;
  }

  &__base-url {
    color: var(--tp-text-secondary);
    font-size: 12px;
  }
}
</style>
