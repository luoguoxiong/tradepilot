<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import { searchKnowledge } from '@/api/resources/knowledge'
import { qk } from '@/query/keys'
import { useDictStore } from '@/stores/dict'

/**
 * 检索预览（11 FR-06 AI 引用测试）：
 * 输入问题 → RAG 命中 chunk（docName/chunkId/score 高亮展示）；
 * noResult=true 必须明示「知识库中没有相关信息」，禁止编造（11 §3.3）。
 */
const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ 'update:visible': [v: boolean] }>()

const { t } = useI18n()
const dict = useDictStore()

const input = ref('')
/** 回车触发的一次性检索载荷（undefined = 不发请求） */
const searchPayload = ref<{ query: string } | null>(null)

const searchQuery = useQuery({
  queryKey: computed(() => qk.knowledge.search(searchPayload.value)),
  queryFn: () => searchKnowledge({ query: searchPayload.value!.query, topK: 5 }),
  enabled: computed(() => props.visible && searchPayload.value !== null),
  staleTime: 0,
  gcTime: 0,
})

const hits = computed(() => searchQuery.data.value?.results ?? [])
const noResult = computed(() => searchQuery.data.value?.noResult ?? false)

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      input.value = ''
      searchPayload.value = null
    }
  },
)

function onSearch() {
  const query = input.value.trim()
  if (!query) return
  searchPayload.value = { query }
}
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    :title="t('knowledge.searchTitle')"
    width="640px"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="search-preview">
      <div class="search-preview__bar">
        <el-input
          v-model="input"
          :placeholder="t('knowledge.searchPlaceholder')"
          clearable
          @keyup.enter="onSearch"
          @clear="searchPayload = null"
        />
        <el-button type="primary" :loading="searchQuery.isFetching.value" @click="onSearch">
          {{ searchQuery.isFetching.value ? t('knowledge.searching') : t('knowledge.searchAction') }}
        </el-button>
      </div>

      <div v-if="noResult" class="search-preview__empty">
        <el-alert :title="t('knowledge.searchEmpty')" type="warning" :closable="false" show-icon />
      </div>

      <div v-else class="search-preview__list">
        <div v-for="hit in hits" :key="hit.chunkId" class="search-preview__item">
          <div class="search-preview__head">
            <span class="search-preview__doc">{{ hit.docName }}</span>
            <span
              class="search-preview__category"
              :style="{ color: dict.color('knowledgeCategory', hit.category ?? 'other') }"
            >
              {{ dict.label('knowledgeCategory', hit.category ?? 'other') }}
            </span>
            <span class="search-preview__score">
              {{ t('knowledge.searchScore') }} {{ (hit.score * 100).toFixed(0) }}%
            </span>
          </div>
          <p class="search-preview__content">{{ hit.content }}</p>
          <span class="search-preview__chunk">
            {{ t('knowledge.searchChunk', { chunkId: hit.chunkId }) }}
          </span>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:visible', false)">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.search-preview {
  &__bar {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  &__empty {
    padding: 8px 0;
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 400px;
    overflow: auto;
  }

  &__item {
    padding: 12px;
    border: 1px solid var(--tp-border-light, #e4e7ed);
    border-radius: 8px;
  }

  &__head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__doc {
    font-weight: 500;
    color: var(--tp-text-primary);
  }

  &__category {
    font-size: 12px;
  }

  &__score {
    margin-left: auto;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__content {
    margin: 8px 0 4px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--tp-text-secondary);
  }

  &__chunk {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
