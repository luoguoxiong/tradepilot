<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance, FormRules } from 'element-plus'

import {
  AI_MODEL_PROVIDERS,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  type AiModel,
  type AiModelProvider,
  type AiModelType,
  type CreateAiModelReq,
  type UpdateAiModelReq,
} from '@/api/types/settings'
import { useDictStore } from '@/stores/dict'

/**
 * AI 模型表单（16 FR-10 扩展）：
 * - type 由父级 tab 决定（llm / embedding / search），表单内不可切换；
 * - llm 关注 temperature / maxTokens；embedding 关注 dimensions；
 * - search 无模型标识/温度/维度，provider=http（Serper 兼容）时必填接口地址与 API Key；
 * - apiKey 仅提交不回显，编辑留空表示不变更。
 */
const props = withDefaults(
  defineProps<{
    type: AiModelType
    model?: AiModel | null
    submitting?: boolean
  }>(),
  { model: null, submitting: false },
)

const emit = defineEmits<{ submit: [req: CreateAiModelReq | UpdateAiModelReq] }>()

const { t } = useI18n()
const dict = useDictStore()

const formRef = ref<FormInstance>()
const isEmbedding = computed(() => props.type === 'embedding')
const isSearch = computed(() => props.type === 'search')
const isEdit = computed(() => props.model !== null)

const form = reactive({
  name: '',
  provider: 'openai' as AiModelProvider,
  model: '',
  baseUrl: '',
  apiKey: '',
  dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS as number | undefined,
  temperature: 0.7,
  maxTokens: undefined as number | undefined,
})

const providerOptions = computed(() =>
  dict
    .options('aiModelProvider')
    .filter((option) =>
      (AI_MODEL_PROVIDERS[props.type] as readonly string[]).includes(option.value),
    ),
)

const rules = computed<FormRules>(() => {
  const base: FormRules = {
    name: [{ required: true, message: t('settings.modelNameRequired'), trigger: 'blur' }],
    provider: [{ required: true, message: t('settings.modelProviderRequired'), trigger: 'change' }],
  }
  if (isSearch.value) {
    // http 供应商必须给出端点与凭据（与后端 assertSearchUsable 同口径）；编辑留空表示不变更
    if (form.provider === 'http') {
      base.baseUrl = [
        { required: true, message: t('settings.modelBaseUrlRequired'), trigger: 'blur' },
      ]
      if (!isEdit.value) {
        base.apiKey = [
          { required: true, message: t('settings.modelApiKeyRequired'), trigger: 'blur' },
        ]
      }
    }
    return base
  }
  base.model = [{ required: true, message: t('settings.modelIdentifierRequired'), trigger: 'blur' }]
  if (isEmbedding.value) {
    base.dimensions = [
      { required: true, message: t('settings.modelDimensionsRequired'), trigger: 'blur' },
    ]
  }
  return base
})

function reset() {
  const current = props.model
  form.name = current?.name ?? ''
  form.provider = current?.provider ?? AI_MODEL_PROVIDERS[props.type][0] ?? 'openai'
  form.model = current?.model ?? ''
  form.baseUrl = current?.baseUrl ?? ''
  form.apiKey = ''
  form.dimensions = isEmbedding.value ? KNOWLEDGE_EMBEDDING_DIMENSIONS : undefined
  form.temperature = current ? Number(current.temperature) : 0.7
  form.maxTokens = current?.maxTokens ?? undefined
}

reset()
watch(() => [props.model, props.type], reset)

function submit() {
  formRef.value?.validate((valid) => {
    if (!valid) return
    const name = form.name.trim()
    const modelId = form.model.trim()
    const baseUrl = form.baseUrl.trim()
    const apiKey = form.apiKey.trim()

    // search：无模型标识/温度/维度，仅 provider + baseUrl + apiKey（06 §3）
    if (isSearch.value) {
      const base = { name, provider: form.provider, ...(apiKey ? { apiKey } : {}) }
      if (isEdit.value) {
        // baseUrl 显式传 null 以支持清空自定义端点
        emit('submit', { ...base, baseUrl: baseUrl || null } as UpdateAiModelReq)
      } else {
        emit('submit', {
          type: props.type,
          ...base,
          ...(baseUrl ? { baseUrl } : {}),
        } as CreateAiModelReq)
      }
      return
    }

    const shared = {
      name,
      provider: form.provider,
      model: modelId,
      ...(apiKey ? { apiKey } : {}),
      ...(isEmbedding.value
        ? form.dimensions !== undefined
          ? { dimensions: form.dimensions }
          : {}
        : {
            temperature: form.temperature,
            ...(form.maxTokens != null ? { maxTokens: form.maxTokens } : {}),
          }),
    }

    if (isEdit.value) {
      // baseUrl 显式传 null 以支持清空自定义端点
      const req: UpdateAiModelReq = { ...shared, baseUrl: baseUrl || null }
      emit('submit', req)
    } else {
      const req: CreateAiModelReq = {
        type: props.type,
        ...shared,
        ...(baseUrl ? { baseUrl } : {}),
      }
      emit('submit', req)
    }
  })
}
</script>

<template>
  <el-form
    ref="formRef"
    class="ai-model-form"
    :model="form"
    :rules="rules"
    label-width="130px"
    @submit.prevent
  >
    <el-form-item :label="t('settings.modelName')" prop="name">
      <el-input v-model="form.name" maxlength="64" />
    </el-form-item>

    <el-form-item :label="t('settings.modelProvider')" prop="provider">
      <el-select v-model="form.provider" class="ai-model-form__field">
        <el-option
          v-for="option in providerOptions"
          :key="option.value"
          :label="t(option.labelKey)"
          :value="option.value"
        />
      </el-select>
    </el-form-item>

    <el-form-item v-if="!isSearch" :label="t('settings.modelIdentifier')" prop="model">
      <el-input v-model="form.model" :placeholder="t('settings.modelIdentifierPlaceholder')" />
    </el-form-item>

    <el-form-item
      :label="isSearch ? t('settings.modelSearchBaseUrl') : t('settings.modelBaseUrl')"
      prop="baseUrl"
    >
      <el-input
        v-model="form.baseUrl"
        :placeholder="
          isSearch
            ? t('settings.modelSearchBaseUrlPlaceholder')
            : t('settings.modelBaseUrlPlaceholder')
        "
      />
    </el-form-item>

    <el-form-item :label="t('settings.modelApiKey')" prop="apiKey">
      <el-input
        v-model="form.apiKey"
        type="password"
        show-password
        :placeholder="isEdit ? t('settings.modelApiKeyKeep') : t('settings.modelApiKeyPlaceholder')"
      />
    </el-form-item>

    <template v-if="isEmbedding">
      <el-form-item :label="t('settings.modelDimensions')" prop="dimensions">
        <el-input-number v-model="form.dimensions" disabled controls-position="right" />
        <p class="ai-model-form__hint">{{ t('settings.modelDimensionsFixed') }}</p>
      </el-form-item>
    </template>

    <template v-else-if="!isSearch">
      <el-form-item :label="t('settings.modelTemperature')">
        <el-input-number v-model="form.temperature" :min="0" :max="2" :step="0.1" :precision="2" />
      </el-form-item>
      <el-form-item :label="t('settings.modelMaxTokens')">
        <el-input-number
          v-model="form.maxTokens"
          :min="1"
          :max="200000"
          controls-position="right"
        />
      </el-form-item>
    </template>

    <slot name="footer">
      <div class="ai-model-form__footer">
        <el-button type="primary" :loading="props.submitting" @click="submit">
          {{ t('common.save') }}
        </el-button>
      </div>
    </slot>
  </el-form>
</template>

<style scoped lang="scss">
.ai-model-form {
  max-width: 640px;

  &__field {
    width: 100%;
  }

  &__hint {
    margin: 4px 0 0;
    color: var(--tp-text-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  &__footer {
    display: flex;
    justify-content: flex-end;
  }
}
</style>
