<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import type { UploadFile, UploadFiles, UploadRawFile } from 'element-plus'

import { uploadKnowledgeDocuments } from '@/api/resources/knowledge'
import type { KnowledgeCategory } from '@/api/types/knowledge'
import { handleApiError } from '@/api/error-handler'
import { useDictStore } from '@/stores/dict'
import { qk } from '@/query/keys'

/**
 * 06 会话详情「存入知识库」（11 FR-07）：
 * 在会话上下文内把邮件附件存入企业知识库，转存来源 source='email_attachment'，分类人工选（默认「客户」）。
 * P0 边界：邮件同步不落附件（email-sync「本版仅文本正文入库」），故由销售在会话内选择本地对应文件转存；
 * 邮件附件自动落对象存储 + 一键转存列 P1（需 07 附件链路）。
 */
const props = defineProps<{ visible: boolean; companyName?: string }>()
const emit = defineEmits<{ 'update:visible': [v: boolean] }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const dict = useDictStore()

/** 与 11 §3.1 / 知识中心同规则（后端白名单兜底 42201） */
const ACCEPT_EXTS = ['pdf', 'docx', 'md', 'txt']
const MAX_SIZE = 50 * 1024 * 1024

const category = ref<KnowledgeCategory>('customer')
const fileList = ref<UploadFile[]>([])
const uploading = ref(false)

const categoryOptions = computed(() =>
  dict
    .options('knowledgeCategory')
    .map((option) => ({ value: option.value, label: t(option.labelKey) })),
)

function reset(): void {
  category.value = 'customer'
  fileList.value = []
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) reset()
  },
)

/** 白名单 + 大小前置校验；不合格文件即时移出列表 */
function onFileChange(file: UploadFile, files: UploadFiles): void {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ACCEPT_EXTS.includes(ext) || (file.size ?? 0) > MAX_SIZE) {
    ElMessage.error(t('knowledge.uploadAccept'))
    fileList.value = files.filter((item) => item.uid !== file.uid)
    return
  }
  fileList.value = files
}

async function onSubmit(): Promise<void> {
  const files = fileList.value
    .map((item) => item.raw)
    .filter((raw): raw is UploadRawFile => raw instanceof File)
  if (files.length === 0) {
    ElMessage.warning(t('inbox.knowledge.noFile'))
    return
  }
  uploading.value = true
  try {
    const results = await uploadKnowledgeDocuments(files, category.value, 'email_attachment')
    ElMessage.success(t('knowledge.uploadSuccess', { count: results.length }))
    // 知识中心列表/统计即时刷新（indexing 态由列表 3s 轮询至终态）
    await queryClient.invalidateQueries({ queryKey: qk.knowledge.all })
    emit('update:visible', false)
  } catch (error) {
    handleApiError(error)
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    :title="t('inbox.knowledge.title')"
    width="520px"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="knowledge-ingest">
      <p v-if="props.companyName" class="knowledge-ingest__context">
        {{ t('inbox.knowledge.context', { company: props.companyName }) }}
      </p>
      <el-alert :title="t('inbox.knowledge.tip')" type="info" :closable="false" show-icon />

      <div class="knowledge-ingest__row">
        <span class="knowledge-ingest__label">{{ t('knowledge.uploadCategoryLabel') }}</span>
        <el-select v-model="category" class="knowledge-ingest__category">
          <el-option
            v-for="option in categoryOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </div>

      <el-upload
        v-model:file-list="fileList"
        class="knowledge-ingest__upload"
        :auto-upload="false"
        multiple
        :accept="ACCEPT_EXTS.map((ext) => `.${ext}`).join(',')"
        :on-change="onFileChange"
      >
        <el-button>{{ t('inbox.knowledge.pickFile') }}</el-button>
        <template #tip>
          <div class="knowledge-ingest__hint">{{ t('knowledge.uploadAccept') }}</div>
        </template>
      </el-upload>
    </div>

    <template #footer>
      <el-button @click="emit('update:visible', false)">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="uploading" @click="onSubmit">
        {{ t('inbox.knowledge.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.knowledge-ingest {
  &__context {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 16px 0 4px;
  }

  &__label {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__category {
    width: 160px;
  }

  &__hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
