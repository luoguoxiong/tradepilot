import { ref } from 'vue'
import { ElMessage } from 'element-plus'

import { generateOutreach } from '@/api/resources/customers'
import type { GenerateOutreachResp } from '@/api/types/customers'
import type { ApiError } from '@/api/http'

/**
 * useOutreachDraft —— AI 生成开发信草稿（04 §3.4）：
 * 调用 POST /contacts/{id}/generate-outreach 产出草稿并在预览弹层展示；
 * 编辑 / 保存 / 发送随 06-AI 销售工作台（M5）开放。头部「联系客户」与联系人卡片共用。
 */
export function useOutreachDraft() {
  const visible = ref(false)
  const loading = ref(false)
  const draft = ref<GenerateOutreachResp | null>(null)

  let lastContactId = ''
  let lastScenario: 'cold_outreach' | 'quote_followup' = 'cold_outreach'

  async function generate(
    contactId: string,
    scenario: 'cold_outreach' | 'quote_followup' = 'cold_outreach',
  ) {
    lastContactId = contactId
    lastScenario = scenario
    loading.value = true
    visible.value = true
    draft.value = null
    try {
      draft.value = await generateOutreach(contactId, scenario)
    } catch (error) {
      ElMessage.error((error as ApiError).message || '生成失败，请稍后重试')
      visible.value = false
    } finally {
      loading.value = false
    }
  }

  async function regenerate() {
    if (!lastContactId) return
    await generate(lastContactId, lastScenario)
  }

  function close() {
    visible.value = false
    draft.value = null
  }

  return { visible, loading, draft, generate, regenerate, close }
}
