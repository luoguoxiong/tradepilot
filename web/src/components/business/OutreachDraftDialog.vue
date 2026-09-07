<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import type { GenerateOutreachResp } from '@/api/types/customers'

/**
 * OutreachDraftDialog AI 开发信草稿预览（04 §3.4）：
 * - POST /contacts/{id}/generate-outreach 产出草稿（status=draft），不直接发送；
 * - P0 预览 + 复制；编辑 / 重新生成 / 保存草稿 / 发送 随 06-AI 销售工作台（M5）开放。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    loading?: boolean
    draft?: GenerateOutreachResp | null
    /** M5 工作台开放编辑/发送前的引导提示是否展示 */
    wip?: boolean
  }>(),
  { loading: false, draft: null, wip: true },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 重新生成（调用方重新发起 POST generate-outreach） */
  regenerate: []
}>()

const { t } = useI18n()

function close() {
  if (props.loading) return
  emit('update:modelValue', false)
}

async function copy() {
  if (!props.draft?.content) return
  try {
    await navigator.clipboard.writeText(props.draft.content)
    ElMessage.success(t('c360.draftCopied'))
  } catch {
    ElMessage.warning(t('c360.draftCopyFailed'))
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('c360.draftTitle')"
    width="640px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="close"
  >
    <div v-loading="loading" class="outreach-draft">
      <template v-if="draft">
        <div class="outreach-draft__head">
          <span class="outreach-draft__status">{{ t('c360.draftStatus') }}</span>
          <span v-if="draft.conversationId" class="outreach-draft__conv">
            {{ t('c360.draftConversation') }}
          </span>
        </div>
        <pre class="outreach-draft__content">{{ draft.content }}</pre>
        <el-alert
          v-if="wip"
          :title="t('c360.draftWip')"
          type="info"
          :closable="false"
          class="outreach-draft__wip"
        />
      </template>
      <el-empty v-else-if="!loading" :description="t('common.empty')" />
    </div>

    <template #footer>
      <el-button @click="close">{{ t('common.close') }}</el-button>
      <el-button :disabled="loading || !draft" @click="emit('regenerate')">
        {{ t('c360.regenerate') }}
      </el-button>
      <el-button type="primary" :disabled="!draft" :loading="loading" @click="copy">
        {{ t('c360.copyDraft') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.outreach-draft {
  min-height: 160px;

  &__head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }

  &__status {
    font-size: 12px;
    font-weight: 600;
    color: var(--ai-waiting);
    border: 1px solid currentcolor;
    border-radius: 4px;
    padding: 0 8px;
    line-height: 20px;
  }

  &__conv {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__content {
    margin: 0;
    padding: 12px 14px;
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.7;
    font-size: 13px;
    color: var(--tp-text-primary);
    background: var(--tp-bg-hover);
    border: 1px solid var(--tp-border-color);
    border-radius: 6px;
    font-family: inherit;
  }

  &__wip {
    margin-top: 12px;
  }
}
</style>
