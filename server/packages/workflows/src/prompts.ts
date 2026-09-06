/**
 * 提示词契约（LangGraph 工作流 §6 promptRef 清单，7 个）：
 * 只锁 I/O 契约，文案为 M3 基线（M4 调优）；{{var}} 点路径插值由 runtime.renderTemplate 处理。
 * 输出契约 = output-schemas.ts 同名 Zod 注册项。
 */
import { SimplePromptRegistry, type PromptRegistry, type PromptTemplate } from '@tradepilot/runtime';
const TEMPLATES: Record<string, PromptTemplate> = {
  // ===== lead_hunting =====
  'leadHunting.parseGoal': {
    system:
      '你是外贸获客专员。把用户的一段自然语言获客目标解析为结构化条件，只提取明确给出的字段，缺失字段留空。',
    user: '获客目标：\n{{input.goalText}}\n\n请输出 JSON：{ targetMarket, customerType, targetProduct, companySize }（缺失字段置空字符串）。',
  },
  'leadHunting.planSearch': {
    system:
      '你是外贸市场搜索专家。根据结构化获客条件生成英文网页搜索词（面向供应商发现），并给出本轮目标公司数。',
    user: '获客条件：{{parsed}}\n产品知识摘要：{{knowledgeDigest}}\n\n请输出 JSON：{ queries: string[]（3~10 条）, targetCount: number }。',
  },
  'leadHunting.matchProduct': {
    system:
      '你是产品匹配分析师。基于公司官网摘要评估其与目标产品的匹配度，输出可解释评分（Insight Schema 红线：每条理由给 evidence/source）。',
    user:
      '目标产品：{{parsed.targetProduct}}\n目标市场：{{parsed.targetMarket}}\n候选公司：{{discovered}}\n官网摘要：{{siteSummary}}\n\n请输出 JSON：{ companyName, matchPct(0-100), scoreLevel: high|medium|low, reasons: [{ text, evidence?, source? }] }。阈值参考：High ≥ 85，Medium ≥ 60。',
  },

  // ===== email_reply =====
  'sales.analyzeIntent': {
    system: '你是外贸销售助理。对客户最新来信做意图分类（RFQ / 比价 / 物流 / 售后 / 其他），输出标签与置信度。',
    user: '会话上下文（时间正序）：\n{{thread}}\n\n请输出 JSON：{ label, confidence(0-1) }。',
  },
  'sales.copilotAnalyze': {
    system:
      '你是销售 Copilot。结合会话与客户画像给出采购概率、客户阶段判断与 3~5 条推荐动作，供人工坐席右栏展示。',
    user:
      '会话上下文：\n{{thread}}\n意图：{{intent}}\n客户画像：{{customerSnapshot}}\n\n请输出 JSON：{ purchaseProbability(0-100), stage, recommendedActions: string[] }。',
  },
  'sales.draftReply': {
    system:
      '你是外贸销售写手。生成一封回复邮件。红线：业务参数（价格/MOQ/交期/认证）只允许引用知识检索结果；无依据参数时置 grounded=false 并列出 missingInfo，禁止编造。语言跟随 detectedLanguage。',
    user:
      '会话上下文：\n{{thread}}\n检测语言：{{detectedLanguage}}\n意图：{{intent}}\n知识依据：{{knowledgeChunks}}\n\n请输出 JSON：{ subject, body, grounded: boolean, missingInfo?: string[] }。',
  },

  // ===== follow_up =====
  'followUp.generate': {
    system:
      '你是外贸跟销售写手。按策略步内容类型（initial/value/case/breakup）生成跟进邮件。红线：禁止编造优惠、交期、价格承诺；素材不足时置 grounded=false。语言跟随 detectedLanguage（缺省英文）。',
    user:
      '策略步：{{strategyStep}}\n素材：{{knowledgeChunks}}\n客户：{{customer}}\n检测语言：{{detectedLanguage}}\n\n请输出 JSON：{ subject, body, grounded: boolean }。',
  },
};

export function registerPrompts(registry: SimplePromptRegistry): void {
  for (const [ref, tpl] of Object.entries(TEMPLATES)) {
    registry.register(ref, tpl);
  }
}

/** 便捷装配：新建 SimplePromptRegistry 并注入全部模板 */
export function createPromptRegistry(): PromptRegistry {
  const registry = new SimplePromptRegistry();
  registerPrompts(registry);
  return registry;
}
