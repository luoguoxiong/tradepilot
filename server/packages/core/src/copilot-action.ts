/**
 * 推荐动作分类器（06 FR-09 流程型建议；00 §5.1 降级矩阵 D8 恢复，纯函数、可单测）。
 *
 * 背景（06 §7 澄清 v0.2）：「执行建议」按勾选集合一次执行，接口 `mode` 双模式：
 * - **内容型**（insert_draft）：回复报价范围 / 询问采购数量 / 推荐产品 → 合并为草稿要点，不直接发送；
 * - **流程型**（跳转或建任务）：创建报价 / 预约跟进 → 跳转对应模块或生成任务。
 *
 * 模型侧只产出自然语言动作（`recommendedActions: string[]`），「动作意图」由其文案决定。
 * 本模块把文案确定性归一为稳定标识，供服务端（06 Copilot 读侧 / 04 洞察 nextAction）与
 * 前端（按钮启用与执行分支）共用，避免两端各写一套关键词表：
 *
 * - `create_quote`：创建报价 → 前端跳 09 报价中心（`customerId` + `create=1` 深链，D8 随 09 启用）；
 * - `create_tasks`：预约跟进 → 建 `follow_up_task`（沿用 07 跟进序列）；
 * - `null`：内容型 → insert_draft。
 *
 * 判定规则刻意要求「动作动词 + 动作宾语」相邻，避免内容型建议被误判：
 * 「回复报价范围」（内容型，插入草稿）只含宾语、不含创建动词 → 仍为内容型。
 */

/** 流程型动作标识（前端 `CopilotSuggestion.action`） */
export type CopilotAction = 'create_quote' | 'create_tasks';

/** 建议类别：content 内容型（insert_draft）/ process 流程型（create_quote | create_tasks） */
export type CopilotSuggestionKind = 'content' | 'process';

/** 04 §1.3 洞察下一步动作标识 */
export type CopilotNextActionType =
  'send_quote' | 'follow_up' | 'contact_decision_maker' | 'generate_outreach';

interface CopilotActionRule {
  action: CopilotAction;
  /** 命中即判定为该动作（规则表按序判定：报价先于跟进） */
  patterns: readonly RegExp[];
}

/**
 * 规则表：中文「动词 + 宾语」相邻（≤6 字），或英文动作短语。
 *
 * 注意「创建报价」只认**创建类**动词（创建/生成/发起/新建/出具/制作/准备/拟定/整理）：
 * 「发送报价单」「发送报价」这类 P0 既有文案表达的是「把报价内容说清楚」（内容型 → 插入草稿），
 * 不是「新建一条报价单」，因此不得归为流程型（否则 P0 建议的语义被改写）。
 */
export const COPILOT_ACTION_RULES: readonly CopilotActionRule[] = [
  {
    action: 'create_quote',
    patterns: [
      /(创建|生成|发起|新建|出具|制作|准备|拟定|整理)[^，。；！？,.;!?]{0,6}(报价单|报价方案|报价)/,
      /\b(create|generate|prepare|draft|issue|make|open)\s+(a\s+|an\s+|the\s+)?(quote|quotation)\b/i,
    ],
  },
  {
    action: 'create_tasks',
    patterns: [
      /(创建|生成|发起|新建|安排|设置|预约|计划|添加)[^，。；！？,.;!?]{0,6}(跟进|回访|跟进任务|回电|通话|会议|提醒)/,
      /(预约|安排)[^，。；！？,.;!?]{0,8}(联系|通话|会议|跟进|回访)/,
      /\bfollow[\s-]?up\b/i,
      /\bschedul(e|ing)\b/i,
    ],
  },
];

/**
 * 判定模型给出的推荐动作属于哪种流程型动作。
 * @param label 模型产出的动作文案（自然语言）
 * @returns 流程型动作标识；内容型返回 `null`
 */
export function classifyCopilotAction(label: string): CopilotAction | null {
  const text = (label ?? '').trim();
  if (text.length === 0) {
    return null;
  }
  for (const rule of COPILOT_ACTION_RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return rule.action;
    }
  }
  return null;
}

/** 建议类别（06 Copilot 响应组装：process 建议走流程型执行入口） */
export function copilotSuggestionKind(label: string): CopilotSuggestionKind {
  return classifyCopilotAction(label) ? 'process' : 'content';
}

/** 04 §1.3 洞察下一步动作类型：create_quote → send_quote（引导创建报价）、create_tasks → follow_up */
export function copilotNextActionType(label: string): CopilotNextActionType | null {
  const action = classifyCopilotAction(label);
  if (action === 'create_quote') {
    return 'send_quote';
  }
  if (action === 'create_tasks') {
    return 'follow_up';
  }
  return null;
}
