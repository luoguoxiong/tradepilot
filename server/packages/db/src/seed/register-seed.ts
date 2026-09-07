import { createId } from '@tradepilot/core';
import type { Tx } from '../tenant.js';
import {
  aiEmployee,
  aiModelSetting,
  followUpStrategy,
  followUpStrategyStep,
  rolePermission,
  sopTemplate,
  type ApprovalRule,
  type RolePermissionMatrix,
  type SopContent,
} from '../schema/index.js';

/**
 * 注册事务种子（后端技术方案 02 §10 / 03 §1.1）：
 * role_permission×3 + 默认跟进策略/步骤 + 6 预置员工（sop_template + ai_employee）+ ai_model_setting×4。
 * 在注册事务内随 org/admin 一起提交（单 org 幂等：仅注册时执行一次）。
 */

/** 16 §2.7 权限矩阵基线（03 §2.1：Guard 读库不读死配置） */
const ROLE_PERMISSION_MATRIX: Record<'admin' | 'manager' | 'sales', RolePermissionMatrix> = {
  admin: {
    customers: 'all',
    quotes: 'approve',
    approvals: [
      'quote',
      'email_send',
      'contract',
      'order_change',
      'bulk_marketing',
      'customer_delete',
    ],
    settings: 'manage',
  },
  manager: {
    customers: 'team',
    quotes: 'edit',
    approvals: ['quote', 'email_send'],
    settings: 'view',
  },
  sales: {
    customers: 'self',
    quotes: 'view',
    approvals: [],
    settings: 'none',
  },
};

/** 12 §7.1 审批规则基线：high 一律人工、email_send 可 autoApprove */
const APPROVAL_RULES: ApprovalRule[] = [
  { approvalType: 'quote', approverRoles: ['admin', 'manager'] },
  { approvalType: 'email_send', approverRoles: ['admin', 'manager'] },
];

/** ER 00 §5.5 默认跟进策略：Day 0/3/7/14/30 五步（is_default=true 不可删可复制） */
const DEFAULT_STRATEGY_STEPS = [
  {
    seq: 1,
    dayOffset: 0,
    title: '首次触达',
    channel: 'email',
    isBreakup: false,
    content: '价值主张开发信：结合客户画像与产品优势，突出差异化卖点与成功案例。',
  },
  {
    seq: 2,
    dayOffset: 3,
    title: '二次跟进',
    channel: 'email',
    isBreakup: false,
    content: '附加产品资料与同行业客户案例，回应首封邮件可能未被覆盖的关注点。',
  },
  {
    seq: 3,
    dayOffset: 7,
    title: '三次跟进',
    channel: 'email',
    isBreakup: false,
    content: '分享行业洞察与市场趋势，邀请客户提出具体需求以提供报价。',
  },
  {
    seq: 4,
    dayOffset: 14,
    title: '四次跟进',
    channel: 'email',
    isBreakup: false,
    content: '限时优惠或样品邀约，给出明确行动建议（询价/约样品/约通话）。',
  },
  {
    seq: 5,
    dayOffset: 30,
    title: 'Break-up Email',
    channel: 'email',
    isBreakup: true,
    content: '最后触达：礼貌告知暂停跟进，保留长期联系通道（强制人工审批）。',
  },
] as const;

/** 02-AI员工中心 §1.1 六角色预置（SOP content 结构以 Runtime 总纲 §4.3 为准） */
type AiEmployeeRole =
  'lead_hunter' | 'customer_researcher' | 'sales' | 'follow_up' | 'merchandiser' | 'manager';

interface PresetEmployee {
  role: AiEmployeeRole;
  name: string;
  goal: string;
  skills: string[];
  tools: string[];
  kpi: { metric: string; target: number };
  sop: SopContent;
}

const PRESET_EMPLOYEES: PresetEmployee[] = [
  {
    role: 'lead_hunter',
    name: 'AI 获客专员',
    goal: '按画像持续挖掘高价值潜在客户，产出可验证线索入 ai_lead 共享池',
    skills: ['market_scan', 'profile_match', 'contact_discovery'],
    tools: ['web_search', 'site_crawl', 'find_contact', 'lookup_contact', 'crm_write', 'knowledge_search'],
    kpi: { metric: 'daily_leads', target: 35 },
    sop: {
      steps: [
        'parse_requirement',
        'search_sources',
        'match_product',
        'score_value',
        'enrich_contact',
      ],
      prompts: { system: '你是外贸获客专员，严格按 org 产品画像筛选客户。' },
      advancedSettings: { match_product: { high: 85, medium: 70 } },
    },
  },
  {
    role: 'customer_researcher',
    name: 'AI 客户研究员',
    goal: '对目标客户做背景调研与需求洞察，产出客户画像与切入建议',
    skills: ['background_research', 'insight_extraction'],
    tools: ['web_search', 'knowledge_search'],
    kpi: { metric: 'daily_insights', target: 20 },
    sop: {
      steps: ['collect_background', 'analyze_demand', 'summarize_insight'],
      prompts: { system: '你是客户研究员，输出结构化客户画像与切入点建议。' },
    },
  },
  {
    role: 'sales',
    name: 'AI 外贸销售员',
    goal: '响应询盘生成专业回复与报价草稿，推动商机进入下一阶段',
    skills: ['inquiry_reply', 'quote_draft'],
    tools: ['email_draft', 'knowledge_search', 'product_search'],
    kpi: { metric: 'reply_rate', target: 90 },
    sop: {
      steps: ['parse_inquiry', 'retrieve_context', 'draft_reply', 'attach_quote_hint'],
      prompts: { system: '你是外贸销售员，按客户最近来信语言回复，专业友好。' },
    },
  },
  {
    role: 'follow_up',
    name: 'AI 跟进员工',
    goal: '按策略节奏执行跟进任务，识别回复信号并及时止损/加速',
    skills: ['cadence_planning', 'signal_detection'],
    tools: ['email_draft', 'check_replied', 'crm_read'],
    kpi: { metric: 'followup_completion', target: 95 },
    sop: {
      steps: ['load_strategy', 'check_replied', 'draft_touch', 'schedule_next'],
      prompts: { system: '你是跟进专员，严格遵循频控与发送窗口，Break-up 邮件必须转人工。' },
    },
  },
  {
    role: 'merchandiser',
    name: 'AI 跟单员工',
    goal: '监控订单履约进度与风险，异常及时预警（随订单中心 P1 启用）',
    skills: ['progress_tracking', 'risk_alert'],
    tools: ['order_read'],
    kpi: { metric: 'risk_alert_timeliness', target: 99 },
    sop: {
      steps: ['load_order', 'compare_progress', 'emit_alert'],
      prompts: { system: '你是跟单员，按里程碑比对实际进度，逾期即预警。' },
    },
  },
  {
    role: 'manager',
    name: 'AI 外贸经理',
    goal: '汇总全局数据产出经营报告与行动建议，统筹六员工协作',
    skills: ['report_generation', 'prioritization'],
    tools: ['analytics_read', 'knowledge_search'],
    kpi: { metric: 'report_on_time', target: 100 },
    sop: {
      steps: ['aggregate_metrics', 'diagnose_risk', 'draft_report', 'recommend_actions'],
      prompts: { system: '你是外贸经理，按五段式结构输出经营报告，预测项标记 estimated。' },
    },
  },
];

/** 16 §2.9 四场景默认模型路由（简单场景小模型 / 复杂场景大模型） */
const DEFAULT_MODEL_SETTINGS = [
  { scene: 'lead_hunting', model: 'gpt-4o', temperature: '0.30', maxTokens: 4096 },
  { scene: 'email_reply', model: 'gpt-4o', temperature: '0.70', maxTokens: 2048 },
  { scene: 'follow_up', model: 'gpt-4o-mini', temperature: '0.50', maxTokens: 2048 },
  { scene: 'analysis', model: 'gpt-4o', temperature: '0.20', maxTokens: 8192 },
] as const;

export async function seedOrg(tx: Tx, orgId: string, adminUserId: string): Promise<void> {
  // 1. role_permission ×3
  await tx.insert(rolePermission).values(
    (['admin', 'manager', 'sales'] as const).map((role) => ({
      id: createId('rperm'),
      orgId,
      role,
      permissions: ROLE_PERMISSION_MATRIX[role],
      approvalRules: APPROVAL_RULES,
      updatedBy: adminUserId,
    })),
  );

  // 2. 默认跟进策略 + 五步
  const [strategy] = await tx
    .insert(followUpStrategy)
    .values({
      id: createId('strat'),
      orgId,
      name: '标准跟进策略',
      targetScope: {},
      autoSendPolicy: 'manual_review',
      enabled: true,
      isDefault: true,
      createdBy: adminUserId,
    })
    .returning({ id: followUpStrategy.id });
  if (!strategy) {
    throw new Error('默认跟进策略创建失败');
  }

  await tx.insert(followUpStrategyStep).values(
    DEFAULT_STRATEGY_STEPS.map((step) => ({
      id: createId('sstep'),
      orgId,
      strategyId: strategy.id,
      seq: step.seq,
      dayOffset: step.dayOffset,
      title: step.title,
      content: step.content,
      channel: step.channel,
      isBreakup: step.isBreakup,
    })),
  );

  // 3. 六预置员工（sop_template + ai_employee 成对）
  for (const emp of PRESET_EMPLOYEES) {
    const [sop] = await tx
      .insert(sopTemplate)
      .values({
        id: createId('sop'),
        orgId,
        role: emp.role,
        name: `${emp.name}·预置SOP`,
        content: emp.sop,
        isPreset: true,
      })
      .returning({ id: sopTemplate.id });
    if (!sop) {
      throw new Error('预置 SOP 创建失败');
    }

    await tx.insert(aiEmployee).values({
      id: createId('emp'),
      orgId,
      role: emp.role,
      name: emp.name,
      status: 'idle',
      goal: emp.goal,
      sopTemplateId: sop.id,
      skills: [...emp.skills],
      tools: [...emp.tools],
      memoryConfig: { retentionDays: 180 },
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: emp.kpi.metric, target: emp.kpi.target, period: 'daily' },
      createdBy: adminUserId,
    });
  }

  // 4. ai_model_setting ×4 scenes
  await tx.insert(aiModelSetting).values(
    DEFAULT_MODEL_SETTINGS.map((m) => ({
      id: createId('mset'),
      orgId,
      scene: m.scene,
      model: m.model,
      temperature: m.temperature,
      maxTokens: m.maxTokens,
    })),
  );
}
