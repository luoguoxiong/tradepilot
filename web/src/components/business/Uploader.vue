<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import {
  CircleCheckFilled,
  CircleCloseFilled,
  RefreshRight,
  UploadFilled,
} from '@element-plus/icons-vue'

import { http } from '@/api/http'

/**
 * Uploader 文件上传（04 §2.2）：多文件、并发 3、失败重试、进度条。
 * 知识中心 / 产品资料 / 初始化向导共用；上传端点由 props 指定（multipart）。
 */
export interface UploadItem {
  uid: number
  name: string
  size: number
  percentage: number
  status: 'pending' | 'uploading' | 'success' | 'error'
  error?: string
  response?: unknown
  /** 源 File 引用（组件内失败重试用） */
  __file: File
}

const props = withDefaults(
  defineProps<{
    /** 上传端点（POST multipart/form-data，字段名 file） */
    action: string
    accept?: string
    maxConcurrency?: number
  }>(),
  { accept: undefined, maxConcurrency: 3 },
)

const emit = defineEmits<{
  change: [items: UploadItem[]]
  allSuccess: [items: UploadItem[]]
}>()

const { t } = useI18n()

const inputRef = ref<HTMLInputElement>()
const dragOver = ref(false)
const items = reactive<UploadItem[]>([])

let uid = 0
let activeCount = 0

function notifyChange() {
  emit('change', [...items])
  if (items.length > 0 && items.every((item) => item.status === 'success')) {
    emit('allSuccess', [...items])
  }
}

function pump() {
  while (activeCount < props.maxConcurrency) {
    const next = items.find((item) => item.status === 'pending')
    if (!next) return
    upload(next)
  }
}

function upload(item: UploadItem) {
  const file = item.__file
  activeCount += 1
  item.status = 'uploading'
  item.percentage = 0

  const form = new FormData()
  form.append('file', file, file.name)

  http
    .post(props.action, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (event) => {
        if (event.total) {
          item.percentage = Math.round((event.loaded / event.total) * 100)
        }
      },
    })
    .then((response) => {
      item.status = 'success'
      item.percentage = 100
      item.response = response.data?.data
    })
    .catch((error: Error) => {
      item.status = 'error'
      item.error = error.message
    })
    .finally(() => {
      activeCount -= 1
      notifyChange()
      pump()
    })
}

function onPick(files: FileList | null) {
  if (!files?.length) return
  for (const file of Array.from(files)) {
    items.push({
      uid: ++uid,
      name: file.name,
      size: file.size,
      percentage: 0,
      status: 'pending',
      __file: file,
    })
  }
  notifyChange()
  pump()
}

function onInputChange(event: Event) {
  onPick((event.target as HTMLInputElement).files)
  ;(event.target as HTMLInputElement).value = ''
}

function onDrop(event: DragEvent) {
  dragOver.value = false
  onPick(event.dataTransfer?.files ?? null)
}

function retry(item: UploadItem) {
  if (item.status !== 'error') return
  item.status = 'pending'
  item.error = undefined
  pump()
}

function remove(item: UploadItem) {
  const index = items.findIndex((i) => i.uid === item.uid)
  if (index !== -1) items.splice(index, 1)
  notifyChange()
}

function clearAll() {
  items.splice(0, items.length)
  notifyChange()
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function showError(item: UploadItem) {
  ElMessage.error(item.error ?? t('common.operationFailed'))
}

defineExpose({ clearAll, items })
</script>

<template>
  <div class="uploader">
    <div
      class="uploader__dropzone"
      :class="{ 'uploader__dropzone--over': dragOver }"
      @click="inputRef?.click()"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <el-icon :size="40" color="var(--tp-text-tertiary)"><UploadFilled /></el-icon>
      <p class="uploader__hint">{{ t('uploader.dropHint') }}</p>
      <p v-if="props.accept" class="uploader__accept">{{ props.accept }}</p>
    </div>
    <input
      ref="inputRef"
      class="uploader__input"
      type="file"
      multiple
      :accept="props.accept"
      @change="onInputChange"
    />

    <ul v-if="items.length" class="uploader__list">
      <li v-for="item in items" :key="item.uid" class="uploader__item">
        <span class="uploader__name" :title="item.name">{{ item.name }}</span>
        <span class="uploader__size">{{ formatSize(item.size) }}</span>
        <el-progress
          class="uploader__progress"
          :percentage="item.percentage"
          :status="
            item.status === 'success'
              ? 'success'
              : item.status === 'error'
                ? 'exception'
                : undefined
          "
        />
        <span class="uploader__status">
          <el-icon v-if="item.status === 'success'" color="var(--ai-working)"
            ><CircleCheckFilled
          /></el-icon>
          <el-icon
            v-else-if="item.status === 'error'"
            color="var(--ai-risk)"
            class="uploader__error"
            @click="showError(item)"
          >
            <CircleCloseFilled />
          </el-icon>
        </span>
        <el-button v-if="item.status === 'error'" link size="small" @click="retry(item)">
          <el-icon><RefreshRight /></el-icon>
        </el-button>
        <el-button link size="small" @click="remove(item)">{{ t('common.cancel') }}</el-button>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.uploader {
  &__dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: calc(var(--tp-spacing-base) * 8) calc(var(--tp-spacing-base) * 4);
    border: 1px dashed var(--tp-border-color);
    border-radius: var(--tp-border-radius-base);
    cursor: pointer;
    transition:
      border-color 0.2s,
      background 0.2s;

    &:hover,
    &--over {
      border-color: var(--tp-primary);
      background: var(--tp-bg-hover);
    }
  }

  &__hint {
    margin: 8px 0 0;
    color: var(--tp-text-secondary);
  }

  &__accept {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__input {
    display: none;
  }

  &__list {
    margin: calc(var(--tp-spacing-base) * 3) 0 0;
    padding: 0;
    list-style: none;
  }

  &__item {
    display: flex;
    align-items: center;
    gap: calc(var(--tp-spacing-base) * 2);
    padding: calc(var(--tp-spacing-base) * 1) 0;
  }

  &__name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--tp-text-primary);
  }

  &__size {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__progress {
    width: 160px;
  }

  &__status {
    display: flex;
    align-items: center;
  }

  &__error {
    cursor: pointer;
  }
}
</style>
