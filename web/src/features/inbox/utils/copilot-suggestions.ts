import type { CopilotSuggestion } from '@/api/types/conversations'

/**
 * 06 FR-06/FR-09 勾选式建议的执行分派（纯函数，便于单测；00 §5.1 降级矩阵 D8）。
 *
 * - 内容型（kind=content）：勾选后「插入草稿」（insert_draft）；
 * - 流程型（kind=process）：按 action 分派 —— create_tasks 建跟进任务、create_quote 带客跳 09 报价中心。
 * D8：09 未启用时不渲染「创建报价」入口（降级为 P0 行为，仅内容型 + 预约跟进可用）。
 */

export interface CopilotCheckedCounts {
  /** 插入草稿可用数量（内容型勾选数） */
  content: number
  /** 创建任务可用数量（action=create_tasks 勾选数） */
  tasks: number
  /** 创建报价可用数量（action=create_quote 勾选数） */
  quote: number
}

/** 按执行入口统计已勾选建议数（各入口按钮的启用条件） */
export function checkedCounts(
  suggestions: readonly CopilotSuggestion[],
  checked: ReadonlySet<string>,
): CopilotCheckedCounts {
  const counts: CopilotCheckedCounts = { content: 0, tasks: 0, quote: 0 }
  for (const s of suggestions) {
    if (!checked.has(s.suggestionId)) continue
    if (s.action === 'create_quote') counts.quote += 1
    else if (s.action === 'create_tasks') counts.tasks += 1
    else if (s.kind === 'content') counts.content += 1
  }
  return counts
}

/** 「创建报价」入口是否渲染：建议集合含该流程型动作，且 09 报价中心已启用（D8） */
export function showQuoteEntry(
  suggestions: readonly CopilotSuggestion[],
  quotesEnabled: boolean,
): boolean {
  return quotesEnabled && suggestions.some((s) => s.action === 'create_quote')
}

/** 执行「创建报价」后清除报价类勾选（其余入口的勾选保留，供后续分别执行） */
export function clearQuoteChecked(
  suggestions: readonly CopilotSuggestion[],
  checked: ReadonlySet<string>,
): Set<string> {
  const next = new Set(checked)
  for (const s of suggestions) {
    if (s.action === 'create_quote') next.delete(s.suggestionId)
  }
  return next
}
