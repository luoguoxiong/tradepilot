import { describe, expect, it } from 'vitest'

import type { CopilotSuggestion } from '@/api/types/conversations'
import {
  checkedCounts,
  clearQuoteChecked,
  showQuoteEntry,
} from '@/features/inbox/utils/copilot-suggestions'

/**
 * D8（06 §7.2 FR-09 流程型建议）：
 * - 内容型 → 插入草稿；create_tasks → 创建任务；create_quote → 带客跳 09 报价中心；
 * - 各入口按钮按「同入口勾选数」启用，互不串台；
 * - 09 未启用时（P0 降级）不渲染「创建报价」入口。
 */
const content: CopilotSuggestion = {
  suggestionId: 'sug-1',
  label: '强调 MOQ 500 双起订',
  checked: false,
  kind: 'content',
}
const taskSug: CopilotSuggestion = {
  suggestionId: 'sug-2',
  label: '预约 5 天后跟进',
  checked: false,
  kind: 'process',
  action: 'create_tasks',
}
const quoteSug: CopilotSuggestion = {
  suggestionId: 'sug-3',
  label: '创建报价单（MOQ 500）',
  checked: false,
  kind: 'process',
  action: 'create_quote',
}
const all = [content, taskSug, quoteSug]

describe('checkedCounts（勾选按执行入口分派）', () => {
  it('三类建议各自计数，互不串台', () => {
    expect(checkedCounts(all, new Set(['sug-1', 'sug-2', 'sug-3']))).toEqual({
      content: 1,
      tasks: 1,
      quote: 1,
    })
    expect(checkedCounts(all, new Set(['sug-3']))).toEqual({ content: 0, tasks: 0, quote: 1 })
    expect(checkedCounts(all, new Set())).toEqual({ content: 0, tasks: 0, quote: 0 })
  })

  it('只有报价建议勾选时，「创建任务」按钮保持禁用（不串到跟进任务）', () => {
    const counts = checkedCounts(all, new Set(['sug-3']))
    expect(counts.tasks).toBe(0)
  })

  it('未知 action 的流程型建议不计入任何执行入口（避免误执行）', () => {
    const unknown: CopilotSuggestion = {
      suggestionId: 'sug-9',
      label: '待定动作',
      checked: false,
      kind: 'process',
    }
    expect(checkedCounts([unknown], new Set(['sug-9']))).toEqual({ content: 0, tasks: 0, quote: 0 })
  })
})

describe('showQuoteEntry（D8：创建报价入口随 09 启用）', () => {
  it('P1（09 启用）且建议含 create_quote → 渲染入口', () => {
    expect(showQuoteEntry(all, true)).toBe(true)
  })

  it('P0（09 未启用）→ 隐藏入口（降级为内容型 + 预约跟进）', () => {
    expect(showQuoteEntry(all, false)).toBe(false)
  })

  it('建议集合无 create_quote → 不渲染空入口', () => {
    expect(showQuoteEntry([content, taskSug], true)).toBe(false)
  })
})

describe('clearQuoteChecked（执行报价后仅清报价类勾选）', () => {
  it('保留其余入口勾选，供后续分别执行', () => {
    const next = clearQuoteChecked(all, new Set(['sug-1', 'sug-3']))
    expect([...next]).toEqual(['sug-1'])
  })
})
