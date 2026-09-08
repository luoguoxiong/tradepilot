/**
 * 三图终态 outputs 组装（LangGraph 工作流 §7 产出物契约 / 接口文档 14 §1.2）：
 * `[{ type: 'leads' | 'draft' | 'insight', payload }]` 类型化数组，替代 M3 通用 result 包裹。
 * - lead_hunting：leads（发现池列表 + 统计，供客户发现列表渲染）；
 * - email_reply：draft + insight（草稿 + Copilot 分析；need_info 场景 draft.missingInfo 随 payload 留存，
 *   copilot 即使不发送也落 outputs——06 §3.3「供右栏展示」）；
 * - follow_up：draft + insight（触达记录 + 下次排期）；pause 交接场景仅 insight（转人工标记）。
 */
type State = Record<string, unknown>;

function obj(state: State, key: string): Record<string, unknown> | undefined {
  const v = state[key];
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function arr(state: State, key: string): unknown[] {
  return Array.isArray(state[key]) ? (state[key] as unknown[]) : [];
}

/** lead_hunting：§7 发现池列表（公司/国家/matchPct/scoreLevel/matchReasons/contacts）+ 统计 */
function leadHuntingOutputs(state: State): Record<string, unknown>[] {
  const leads = arr(state, 'crmLeads');
  const scored = arr(state, 'scored');
  const highValueCount = scored.filter(
    (s) => (s as { scoreLevel?: string }).scoreLevel === 'high',
  ).length;
  return [
    {
      type: 'leads',
      payload: {
        leads,
        foundCount: leads.length,
        analyzedCount: scored.length,
        highValueCount,
      },
    },
  ];
}

/** email_reply：draft + insight（intent/copilot；need_info 附 missingInfo） */
function emailReplyOutputs(state: State): Record<string, unknown>[] {
  const outputs: Record<string, unknown>[] = [];
  const draft = obj(state, 'draft');
  if (draft) {
    outputs.push({ type: 'draft', payload: draft });
  }
  const intent = obj(state, 'intent');
  const copilot = obj(state, 'copilot');
  if (intent || copilot) {
    outputs.push({
      type: 'insight',
      payload: { ...(intent ? { intent } : {}), ...(copilot ? { copilot } : {}) },
    });
  }
  return outputs;
}

/** follow_up：draft + insight（策略步/触达/排期）；check_replied 命中 → 仅 insight（转人工交接） */
function followUpOutputs(state: State): Record<string, unknown>[] {
  if (state['repliedSinceLast'] === true) {
    return [
      {
        type: 'insight',
        payload: { paused: true, handoff: 'human', reason: 'customer_replied' },
      },
    ];
  }
  const outputs: Record<string, unknown>[] = [];
  const content = obj(state, 'content');
  if (content) {
    outputs.push({ type: 'draft', payload: content });
  }
  const step = obj(state, 'strategyStep');
  const nextStep = obj(state, 'nextStep');
  const messageId = state['messageId'];
  const insight: Record<string, unknown> = { ...(step ?? {}) };
  if (typeof messageId === 'string' && messageId) {
    insight['messageId'] = messageId;
  }
  if (nextStep) {
    insight['nextStep'] = nextStep;
  }
  if (Object.keys(insight).length > 0) {
    outputs.push({ type: 'insight', payload: insight });
  }
  return outputs;
}

const BUILDERS: Record<string, (state: State) => Record<string, unknown>[]> = {
  lead_hunting: leadHuntingOutputs,
  email_reply: emailReplyOutputs,
  follow_up: followUpOutputs,
};

/** 按 taskType 组装类型化 outputs；未注册类型返回 null（runner 回落通用 result 包裹） */
export function buildWorkflowOutputs(
  taskType: string,
  finalState: State,
): Record<string, unknown>[] | null {
  const builder = BUILDERS[taskType];
  return builder ? builder(finalState) : null;
}
