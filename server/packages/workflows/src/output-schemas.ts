/**
 * LLM 结构化输出契约注册表（LangGraph 工作流 §6 输出列 / Runtime 总纲 §6.3）。
 * 名字与 SOP llm 节点 outputSchema 一一对应；mock provider 按 Zod 形状产出确定性数据。
 */
import { z } from 'zod';
import { SimpleOutputSchemaRegistry, type OutputSchemaRegistry } from '@tradepilot/runtime';

export const parsedGoalSchema = z.object({
  targetMarket: z.string().optional(),
  customerType: z.string().optional(),
  targetProduct: z.string().optional(),
  companySize: z.string().optional(),
});

export const searchPlanSchema = z.object({
  queries: z.array(z.string().min(1)).min(1).max(10),
  targetCount: z.number().int().min(1).max(100),
});

/** Insight Schema 红线（03 §4）：可解释 reasons（对齐 LeadScore） */
export const leadScoreSchema = z.object({
  companyName: z.string().min(1),
  matchPct: z.number().int().min(0).max(100),
  scoreLevel: z.enum(['high', 'medium', 'low']),
  reasons: z.array(
    z.object({
      text: z.string().min(1),
      evidence: z.string().optional(),
      source: z.string().optional(),
    }),
  ),
});

export const intentSchema = z.object({
  label: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const copilotSchema = z.object({
  purchaseProbability: z.number().min(0).max(100),
  stage: z.string().min(1),
  recommendedActions: z.array(z.string().min(1)),
});

/** 信念红线（06 §4 / D9）：grounded=false + missingInfo 走 need_info 分支 */
export const draftReplySchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  grounded: z.boolean(),
  missingInfo: z.array(z.string()).optional(),
});

export const followUpContentSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  grounded: z.boolean(),
});

const REGISTRY: Record<string, z.ZodType> = {
  parsedGoal: parsedGoalSchema,
  searchPlan: searchPlanSchema,
  leadScore: leadScoreSchema,
  intent: intentSchema,
  copilot: copilotSchema,
  draftReply: draftReplySchema,
  followUpContent: followUpContentSchema,
};

/** 注册到具体实现类（register 方法在 Simple 实现上，接口仅暴露 get/has） */
export function registerOutputSchemas(registry: SimpleOutputSchemaRegistry): void {
  for (const [name, schema] of Object.entries(REGISTRY)) {
    registry.register(name, schema);
  }
}

/** 便捷装配：新建 SimpleOutputSchemaRegistry 并注入全部 schema */
export function createOutputSchemaRegistry(): OutputSchemaRegistry {
  const registry = new SimpleOutputSchemaRegistry();
  registerOutputSchemas(registry);
  return registry;
}
