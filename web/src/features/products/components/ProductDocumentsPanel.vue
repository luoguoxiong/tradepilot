<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus'
import { UploadFilled, WarningFilled } from '@element-plus/icons-vue'

import { deleteProductDocument, uploadProductDocument } from '@/api/resources/products'
import { handleApiError } from '@/api/error-handler'
import { useDictStore } from '@/stores/dict'
import { formatRelative } from '@/utils/date'
import type { ProductDocType, ProductDocumentItem } from '@/api/types/products'

/**
 * ProductDocumentsPanel 资料页签（FR-08，08 §1.5）：
 * 上传（multipart: file + docType）→ 自动归档知识中心「产品」分类并索引；
 * 列表展示 indexed 状态（父级轮询详情至终态）；删除级联软删知识文档（仅经理/管理员）。
 */
const props = withDefaults(
  defineProps<{
    productId: string
    documents: ProductDocumentItem[]
    canManage?: boolean
  }>(),
  { canManage: false },
)

const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const dict = useDictStore()

/** 08 §1.5 四类附件；白名单与后端 PRODUCT_FILE_TYPES 一致 */
const ACCEPT_EXTS = ['pdf', 'docx', 'md', 'txt']

const docType = ref<ProductDocType>('catalog')
const uploading = ref(false)

const docTypeOptions = computed(() =>
  dict
    .options('productDocType')
    .map((o) => ({ value: o.value as ProductDocType, label: t(o.labelKey) })),
)

async function onUploadRequest(options: UploadRequestOptions) {
  const file = options.file as File
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ACCEPT_EXTS.includes(ext)) {
    ElMessage.error(t('products.docUploadAccept'))
    return
  }
  uploading.value = true
  try {
    await uploadProductDocument(props.productId, file, docType.value)
    ElMessage.success(t('products.docUploadSuccess'))
    emit('changed')
  } catch (error) {
    handleApiError(error)
  } finally {
    uploading.value = false
  }
}

async function onDelete(doc: ProductDocumentItem) {
  try {
    await ElMessageBox.confirm(
      t('products.docDeleteConfirm', { name: doc.fileName }),
      t('products.docDeleteTitle'),
      {
        type: 'warning',
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
      },
    )
  } catch {
    return
  }
  try {
    await deleteProductDocument(props.productId, doc.fileId)
    ElMessage.success(t('products.docDeleted'))
    emit('changed')
  } catch (error) {
    handleApiError(error)
  }
}
</script>

<template>
  <div class="product-docs">
    <div class="product-docs__toolbar">
      <span class="product-docs__label">{{ t('products.docType') }}</span>
      <el-select v-model="docType" class="product-docs__select">
        <el-option
          v-for="option in docTypeOptions"
          :key="option.value"
          :value="option.value"
          :label="option.label"
        />
      </el-select>
      <el-upload
        :show-file-list="false"
        :http-request="onUploadRequest"
        :accept="ACCEPT_EXTS.map((e) => `.${e}`).join(',')"
        multiple
      >
        <el-button type="primary" :loading="uploading">
          <el-icon><UploadFilled /></el-icon>
          {{ uploading ? t('products.docUploading') : t('products.docUpload') }}
        </el-button>
      </el-upload>
    </div>

    <el-table :data="props.documents" row-key="fileId" stripe>
      <el-table-column prop="fileName" :label="t('products.docColName')" min-width="240" />
      <el-table-column prop="docType" :label="t('products.docColType')" width="130">
        <template #default="{ row }">{{ dict.label('productDocType', row.docType) }}</template>
      </el-table-column>
      <el-table-column prop="size" :label="t('products.docColSize')" width="110">
        <template #default="{ row }">{{ row.size ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="indexed" :label="t('products.docColIndexed')" width="130">
        <template #default="{ row }">
          <span :style="{ color: row.indexed ? 'var(--ai-working)' : 'var(--ai-scheduled)' }">
            {{ row.indexed ? t('products.docIndexed') : t('products.docIndexing') }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="uploadedAt" :label="t('products.docColUploadedAt')" width="160">
        <template #default="{ row }">{{ formatRelative(row.uploadedAt) }}</template>
      </el-table-column>
      <el-table-column
        v-if="props.canManage"
        :label="t('products.docColActions')"
        width="90"
        fixed="right"
      >
        <template #default="{ row }">
          <el-button link type="danger" size="small" @click="onDelete(row)">
            {{ t('products.docDelete') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div class="product-docs__empty">
          <el-icon><WarningFilled /></el-icon>
          <span>{{ t('products.docEmpty') }}</span>
        </div>
      </template>
    </el-table>
  </div>
</template>

<style scoped lang="scss">
.product-docs {
  &__toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  &__label {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__select {
    width: 140px;
  }

  &__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--tp-text-tertiary);
  }
}
</style>
