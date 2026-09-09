/**
 * flow 节点注册表（LangGraph 工作流 §2~§4 flow 语义 + Runtime 总纲 §4.3）。
 * FlowNodeFn = (state, ctx) → { patch, branch, done }；DB 访问一律 withOrg（RLS fail-closed）。
 *
 * M4-1 说明：
 * - lead_hunting 的 find_contact/lookup_contact 已工具化（tools/builtin/search-tools.ts），
 *   flow 层仅保留控制流（dedup/评分分流/目标检查/汇总）；
 * - 跨轮累积（scored/contacts/discovered 元数据）经 ctx.bag 承载（LastValue 通道无 reducer）；
 * - 频控顺延复用 @tradepilot/core time-window（P1-4 收口公式，Scheduler 预检共用同一实现）。
 */
import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { createId } from '@tradepilot/core';
import { computeDeferredNextRunAt, type SendWindow } from '@tradepilot/core';
import { schema, withOrg } from '@tradepilot/db';
import {
  boundExternal,
  detectEmailLanguage,
  type CompanyLead,
  type LeadContact,
  type LeadScore,
  type MatchThresholds,
} from '@tradepilot/shared';
import {
  SimpleFlowRegistry,
  loadCustomerInsights,
  loadRecentMessages,
  type FlowNodeFn,
  type FlowRegistry,
  type TaskRunContext,
} from '@tradepilot/runtime';

type State = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normDomain(domain: string | null | undefined): string | null {
  if (!domain) {
    return null;
  }
  return (
    domain
      .replace(/^www\./, '')
      .toLowerCase()
      .trim() || null
  );
}

function leadKey(lead: Pick<CompanyLead, 'companyName' | 'domain'>): string {
  return normDomain(lead.domain) ?? lead.companyName.toLowerCase().trim();
}

/** org.send_rules.sendWindow（'HH:MM'）→ core SendWindow（小时粒度） */
function parseSendWindow(sendRules: TaskRunContext['org']['sendRules']): SendWindow | undefined {
  if (!sendRules?.sendWindow) {
    return undefined;
  }
  const startHour = Number.parseInt(sendRules.sendWindow.start.slice(0, 2), 10);
  const endHour = Number.parseInt(sendRules.sendWindow.end.slice(0, 2), 10);
  if (Number.isNaN(startHour) || Number.isNaN(endHour)) {
    return undefined;
  }
  return { startHour, endHour };
}

/** advancedSettings（03 §3.4 五键结构 + 循环守护 maxRounds） */
interface AdvancedSettings {
  excludeDomains?: string[];
  companySizeRange?: { min?: number; max?: number };
  annualImportRange?: string;
  jobTitles?: string[];
  matchThresholds?: MatchThresholds;
  maxRounds?: number;
}

function readAdvanced(ctx: TaskRunContext): AdvancedSettings {
  const advanced = ctx.task.input['advancedSettings'];
  return advanced !== null && typeof advanced === 'object' ? (advanced as never) : {};
}

/**
 * scoreLevel 确定性映射（03 §3.5：单一评分源 matchPct，scoreLevel 不做二次 AI 判断，
 * 与 LLM 输出不一致时以本映射为准）：High ≥ high（默认 85）、Medium ≥ medium（默认 60）。
 */
export function mapScoreLevel(matchPct: number, thresholds?: MatchThresholds): 'high' | 'medium' | 'low' {
  const high = typeof thresholds?.high === 'number' ? thresholds.high : 85;
  const medium = typeof thresholds?.medium === 'number' ? thresholds.medium : 60;
  return matchPct >= high ? 'high' : matchPct >= medium ? 'medium' : 'low';
}

function bagArray<T>(ctx: TaskRunContext, key: string): T[] {
  return (ctx.bag.get(key) as T[] | undefined) ?? [];
}

/** ===== lead_hunting ===== */

/**
 * 三级去重口径（03 §3.6）：excludeDomains/companySizeRange 硬过滤 → 任务内已发现（bag seenKeys）→
 * 发现池/CRM 查重（归一化域名优先，lower(company_name) 兜底）。
 * 每轮产出首个新公司（discovered=[current]，crawl_site 以 discovered.0.* 取值）；
 * 无新公司 → branch 'duplicate'；搜索轮次守护（maxRounds，防 mock 池耗尽死循环）。
 */
const dedupCheck: FlowNodeFn = async (state, ctx) => {
  const result = state['searchResult'] as { companies?: CompanyLead[] } | undefined;
  const companies = result?.companies ?? [];
  const advanced = readAdvanced(ctx);
  const exclude = new Set(
    (advanced.excludeDomains ?? []).map((d) => normDomain(d)).filter(Boolean),
  );
  const seen = (ctx.bag.get('seenKeys') as Set<string> | undefined) ?? new Set<string>();
  const size = advanced.companySizeRange;

  const candidates = companies.filter((c) => {
    const key = leadKey(c);
    if (seen.has(key)) {
      return false;
    }
    const domain = normDomain(c.domain);
    if (domain && exclude.has(domain)) {
      seen.add(key);
      return false;
    }
    // companySizeRange 硬过滤（03 §3.4）：员工数区间外的候选直接排除（确定性，不进 AI 评分）
    if (
      size &&
      c.employeeCount !== undefined &&
      ((size.min !== undefined && c.employeeCount < size.min) ||
        (size.max !== undefined && c.employeeCount > size.max))
    ) {
      seen.add(key);
      return false;
    }
    return true;
  });

  // 发现池/CRM 查重（命中 → 视为已存在，不再新建）
  let fresh: CompanyLead | null = null;
  if (candidates.length > 0) {
    const domains = candidates.map((c) => normDomain(c.domain)).filter((d): d is string => !!d);
    const names = candidates.map((c) => c.companyName.toLowerCase().trim());
    fresh =
      (await withOrg(ctx.db, ctx.orgId, async (tx) => {
        // 命中口径：域名匹配 OR 名称匹配（分别 inArray 绑定，避免 ANY($2) 混排参数错误）
        const hitConds: (SQL | undefined)[] = [];
        if (domains.length > 0) {
          hitConds.push(inArray(schema.aiLead.companyDomain, domains));
        }
        if (names.length > 0) {
          hitConds.push(inArray(sql`lower(${schema.aiLead.companyName})`, names));
        }
        const rows = await tx
          .select({
            companyName: schema.aiLead.companyName,
            companyDomain: schema.aiLead.companyDomain,
          })
          .from(schema.aiLead)
          .where(
            hitConds.length > 0
              ? and(eq(schema.aiLead.orgId, ctx.orgId), or(...hitConds))
              : eq(schema.aiLead.orgId, ctx.orgId),
          );
        const existingKeys = new Set<string>();
        for (const r of rows) {
          existingKeys.add(normDomain(r.companyDomain) ?? r.companyName.toLowerCase().trim());
        }
        return candidates.find((c) => !existingKeys.has(leadKey(c))) ?? null;
      })) ?? null;
  }

  for (const c of companies) {
    seen.add(leadKey(c));
  }
  ctx.bag.set('seenKeys', seen);

  if (!fresh) {
    return { branch: 'duplicate' };
  }
  ctx.bag.set('companyMeta', {
    ...(ctx.bag.get('companyMeta') as Record<string, string> | undefined),
    [fresh.companyName]: fresh.country ?? 'Unknown',
  });
  return { patch: { discovered: [fresh] }, branch: 'new' };
};

/**
 * 评分累积（bag scoredAll → state.scored 镜像）+ 阈值分流。
 * scoreLevel 以 matchPct 按 matchThresholds 确定性映射覆写（03 §3.5，LLM 输出仅参考）；
 * 低于 Medium 分档线（默认 <60）不进入联系人发现。
 */
const recordScore: FlowNodeFn = (state, ctx) => {
  const current = state['currentScore'] as LeadScore | undefined;
  if (!current) {
    return { branch: 'low' };
  }
  const level = mapScoreLevel(current.matchPct, readAdvanced(ctx).matchThresholds);
  const normalized: LeadScore = { ...current, scoreLevel: level };
  const all = [...bagArray<LeadScore>(ctx, 'scoredAll'), normalized];
  ctx.bag.set('scoredAll', all);
  return { patch: { scored: all }, branch: level === 'low' ? 'low' : 'matched' };
};

/** 目标数检查（J）：scored ≥ targetCount 或轮次耗尽 → 'save'；否则 'continue' 回 web_search */
const targetReached: FlowNodeFn = (state, ctx) => {
  const advanced = readAdvanced(ctx);
  const target = readTargetCount(state, ctx);
  const scoredCount = bagArray<LeadScore>(ctx, 'scoredAll').length;
  // 每轮检查自增（搜索轮次守护：mock 池去重后不再产出新 lead 时防死循环）
  const rounds = ((ctx.bag.get('rounds') as number | undefined) ?? 0) + 1;
  ctx.bag.set('rounds', rounds);
  const maxRounds = advanced.maxRounds ?? 5;
  if (scoredCount >= target || rounds >= maxRounds) {
    return { branch: 'save' };
  }
  return { branch: 'continue' };
};

function readTargetCount(state: State, ctx: TaskRunContext): number {
  const fromPlan = (state['searchPlan'] as { targetCount?: number } | undefined)?.targetCount;
  const fromInput = ctx.task.input['targetCount'];
  const value = typeof fromInput === 'number' ? fromInput : fromPlan;
  return typeof value === 'number' && value >= 1 ? Math.min(100, Math.floor(value)) : 1;
}

/** 汇总发现池 leads（scored × contacts 按 companyName 连接 + 元数据国家）→ crm_write 入参。
 *  contacts 以 bag 累积为准（find_contact/lookup_contact 工具跨轮写入，含公开渠道 email）。 */
const assembleLeads: FlowNodeFn = (state, ctx) => {
  const scoredAll = bagArray<LeadScore>(ctx, 'scoredAll');
  const meta = (ctx.bag.get('companyMeta') as Record<string, string> | undefined) ?? {};
  const contacts = bagArray<LeadContact>(ctx, 'contactsAll');
  const leads = scoredAll.map((s) => ({
    companyName: s.companyName,
    country: meta[s.companyName] ?? 'Unknown',
    matchPct: s.matchPct,
    scoreLevel: s.scoreLevel,
    reasons: s.reasons,
    contacts: contacts
      .filter((c) => c.companyName === s.companyName)
      .map((c) => ({
        name: c.name,
        title: c.title,
        email: c.email,
        decisionInfluencePct: c.decisionInfluencePct,
      })),
  }));
  return { patch: { crmLeads: leads } };
};

/** finalize（L）：产出统计写日志事件（outputs 由 runner 从 State 摘取） */
const finalize: FlowNodeFn = (state, ctx) => {
  const scoredAll = bagArray<LeadScore>(ctx, 'scoredAll');
  const highValue = scoredAll.filter((s) => s.scoreLevel === 'high').length;
  ctx.events.push({
    type: 'log',
    payload: {
      logId: createId('tlog'),
      type: 'found',
      content: `获客完成：分析 ${scoredAll.length} 家，高价值 ${highValue} 家`,
    },
  });
  return { patch: {} };
};

/** ===== email_reply ===== */

/**
 * load_thread（M3 flow 承载）：inboxMessageId/conversationId → 会话最近消息 + 语言检测
 * （跟随最近一条 in 消息 language；缺失时按正文确定性检测 zh/en，无信号默认英文 06 §7）
 * + 客户画像快照。
 */
const loadThread: FlowNodeFn = async (state, ctx) => {
  const inboxMessageId = str(state['inboxMessageId']);
  let conversationId = str(state['conversationId']) || null;
  let customerId = str(state['customerId']) || null;

  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    if (!conversationId && inboxMessageId) {
      const [m] = await tx
        .select({ conversationId: schema.message.conversationId })
        .from(schema.message)
        .where(eq(schema.message.id, inboxMessageId))
        .limit(1);
      conversationId = m?.conversationId ?? null;
    }
    if (conversationId && !customerId) {
      const [c] = await tx
        .select({ customerId: schema.conversation.customerId })
        .from(schema.conversation)
        .where(eq(schema.conversation.id, conversationId))
        .limit(1);
      customerId = c?.customerId ?? null;
    }
  });

  const thread = (
    conversationId ? await loadRecentMessages(ctx.db, ctx.orgId, conversationId) : []
  ).map((m) =>
    // M3-16 / 08 §6：客户来信（direction=in）为不可信外部文本，进 prompt 前包边界标记防注入
    m.direction === 'in' ? { ...m, body: boundExternal(m.body) } : m,
  );
  const lastIn = [...thread].reverse().find((m) => m.direction === 'in');
  // 语言跟随（06 §7）：落库 language 优先，缺失按正文确定性检测 zh/en，无 in 信号默认英文
  const detectedLanguage = lastIn
    ? (lastIn.language?.trim() || detectEmailLanguage(lastIn.body))
    : 'en';
  // M5-C4 洞察写回：来信无语言标记时将检测结果写回 message.language（「语言跟随」持久化，
  // 06 详情/草稿语言口径与状态 detectedLanguage 同源）
  if (lastIn && !lastIn.language?.trim()) {
    await withOrg(ctx.db, ctx.orgId, async (tx) => {
      await tx
        .update(schema.message)
        .set({ language: detectedLanguage, updatedAt: ctx.now })
        .where(eq(schema.message.id, lastIn.messageId));
    });
  }
  const customerSnapshot = customerId
    ? await loadCustomerInsights(ctx.db, ctx.orgId, customerId)
    : null;

  const patch: State = {
    thread,
    detectedLanguage,
    ...(conversationId ? { conversationId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(customerSnapshot ? { customerSnapshot } : {}),
  };
  return { patch };
};

/** draft_reply 依据分流：grounded=true → 发送；false → need_info 收尾（outputs 留存缺料清单） */
const draftBranch: FlowNodeFn = (state) => {
  const draft = state['draft'] as { grounded?: boolean } | undefined;
  return { branch: draft?.grounded === true ? 'grounded' : 'need_info' };
};

/** need_info 收尾：不发送，draft.missingInfo 随 outputs 留存（completed · 需补充资料）；
 * copilot/intent 产出不依赖发送分支，洞察照常写回（06 §3.3 供右栏展示） */
const needInfo: FlowNodeFn = async (state, ctx) => {
  await persistConversationInsight(state, ctx);
  return { patch: {} };
};

/** intent.label（LLM 自由文本标签）→ ai_intent 枚举（确定性关键词映射，兜底 other） */
function mapAiIntent(label: unknown): 'rfq' | 'price_compare' | 'logistics' | 'sample' | 'other' {
  const s = typeof label === 'string' ? label.toLowerCase() : '';
  if (/rfq|询价|request/.test(s)) {
    return 'rfq';
  }
  if (/price|quote|比价|报价/.test(s)) {
    return 'price_compare';
  }
  if (/logistic|shipping|物流|运费/.test(s)) {
    return 'logistics';
  }
  if (/sample|样品|打样/.test(s)) {
    return 'sample';
  }
  return 'other';
}

/**
 * M5-C4 洞察写回：email_reply 图 copilot_analyze 产出 → conversation_insight
 * （uq_conversation_insight 按会话 upsert，intent/purchaseProbability/suggestions/citations）。
 * knowledgeChunks 形状 = knowledge_search 工具出参 { chunks: [{ chunkId, documentId, title, ... }] }。
 */
async function persistConversationInsight(state: State, ctx: TaskRunContext): Promise<void> {
  const conversationId = str(state['conversationId']);
  const intent = state['intent'] as { label?: string } | undefined;
  const copilot = state['copilot'] as
    | { purchaseProbability?: number; recommendedActions?: string[] }
    | undefined;
  if (!conversationId || (!intent && !copilot)) {
    return;
  }
  const kb = state['knowledgeChunks'] as
    | { chunks?: { chunkId?: string; documentId?: string; title?: string }[] }
    | undefined;
  const citations = (kb?.chunks ?? [])
    .filter((c) => typeof c.documentId === 'string' && c.documentId)
    .map((c) => ({
      docId: c.documentId!,
      ...(typeof c.title === 'string' && c.title ? { docName: c.title } : {}),
      ...(typeof c.chunkId === 'string' && c.chunkId ? { chunkId: c.chunkId } : {}),
    }));
  const suggestions = (copilot?.recommendedActions ?? [])
    .filter((a) => typeof a === 'string' && a.trim().length > 0)
    .slice(0, 5)
    .map((label) => ({ suggestionId: createId('sug'), label }));
  const probability = copilot?.purchaseProbability;
  const values = {
    id: createId('cins'),
    orgId: ctx.orgId,
    conversationId,
    intent: mapAiIntent(intent?.label),
    ...(typeof probability === 'number' && Number.isFinite(probability)
      ? { purchaseProbability: Math.max(0, Math.min(100, Math.round(probability))) }
      : {}),
    suggestions,
    ...(citations.length > 0 ? { citations } : {}),
    generatedAt: ctx.now,
    updatedAt: ctx.now,
  };
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    await tx
      .insert(schema.conversationInsight)
      .values(values)
      .onConflictDoUpdate({
        target: schema.conversationInsight.conversationId,
        set: {
          intent: values.intent,
          ...(values.purchaseProbability !== undefined
            ? { purchaseProbability: values.purchaseProbability }
            : {}),
          suggestions: values.suggestions,
          ...(citations.length > 0 ? { citations } : {}),
          generatedAt: values.generatedAt,
          updatedAt: values.updatedAt,
        },
      });
  });
}

/** writeback（M3 flow 承载）：发送结果写 CRM 活动记录 + conversation_insight 洞察写回（M5-C4）；
 * 首响时长指标随数据中心（P1） */
const writeback: FlowNodeFn = async (state, ctx) => {
  const messageId = str(state['messageId']);
  const customerId = str(state['customerId']);
  await persistConversationInsight(state, ctx);
  if (!customerId) {
    return { patch: {} };
  }
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    await tx.insert(schema.customerActivity).values({
      id: createId('act'),
      orgId: ctx.orgId,
      customerId,
      type: 'ai_action',
      summary: `AI 回复已发送${messageId ? `（消息 ${messageId}）` : ''}`,
      operatorType: 'ai',
      operatorId: ctx.employeeId,
      operatorName: ctx.employee.name,
      refType: messageId ? 'message' : null,
      refId: messageId || null,
    });
  });
  return { patch: {} };
};

/** ===== follow_up ===== */

/** load_context（M3 flow 承载）：follow_up_task + 客户分层快照（crm_read 语义） */
const loadContext: FlowNodeFn = async (state, ctx) => {
  const followUpTaskId = str(state['followUpTaskId']);
  let customerId = str(state['customerId']) || null;
  let stage = 'new_lead';
  let score = 0;
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    if (followUpTaskId) {
      const [ft] = await tx
        .select({ customerId: schema.followUpTask.customerId })
        .from(schema.followUpTask)
        .where(eq(schema.followUpTask.id, followUpTaskId))
        .limit(1);
      customerId = ft?.customerId ?? customerId;
    }
    if (customerId) {
      const [c] = await tx
        .select({ stage: schema.customer.stage, score: schema.customer.score })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt)))
        .limit(1);
      stage = c?.stage ?? stage;
      score = c?.score ?? score;
    }
  });
  return {
    patch: {
      customer: {
        id: customerId ?? '',
        tier:
          score >= 85 ? ('high' as const) : score >= 60 ? ('medium' as const) : ('low' as const),
        stage,
      },
    },
  };
};

/**
 * check_replied（07 §4）：扫描上次触达后客户回复（撞车防护）。
 * 已回复 → 'replied'（pause_strategy 转人工）；未回复 → 'no'。
 * 同时缓存该客户最近一次 outbound 时间 L（bag lastOutboundAt，schedule_next 频控复用）。
 */
const checkReplied: FlowNodeFn = async (state, ctx) => {
  const followUpTaskId = str(state['followUpTaskId']);
  const customerId = (state['customer'] as { id?: string } | undefined)?.id ?? '';

  let replied = false;
  let lastOutboundAt: Date | null = null;
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    const [ft] = await tx
      .select({
        lastExecutedAt: schema.followUpTask.lastExecutedAt,
        createdAt: schema.followUpTask.createdAt,
      })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, followUpTaskId))
      .limit(1);
    const since = ft?.lastExecutedAt ?? ft?.createdAt ?? new Date(0);
    const convs = await tx
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.orgId, ctx.orgId),
          eq(schema.conversation.customerId, customerId),
        ),
      );
    const convIds = convs.map((c) => c.id);
    if (convIds.length === 0) {
      return;
    }
    const [lastOut] = await tx
      .select({ sentAt: schema.message.sentAt, createdAt: schema.message.createdAt })
      .from(schema.message)
      .where(
        and(
          inArray(schema.message.conversationId, convIds),
          eq(schema.message.direction, 'out'),
          eq(schema.message.status, 'sent'),
        ),
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(1);
    lastOutboundAt = lastOut?.sentAt ?? lastOut?.createdAt ?? null;
    const [recentIn] = await tx
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(
        and(
          inArray(schema.message.conversationId, convIds),
          eq(schema.message.direction, 'in'),
          gt(schema.message.createdAt, since),
        ),
      )
      .limit(1);
    replied = !!recentIn;
  });
  ctx.bag.set('lastOutboundAt', lastOutboundAt);
  return { patch: { repliedSinceLast: replied }, branch: replied ? 'replied' : 'no' };
};

/** pause_strategy：暂停策略 + 生成交接 outputs（转人工 07 §4）；follow_up_task.status=paused */
const pauseStrategy: FlowNodeFn = async (state, ctx) => {
  const followUpTaskId = str(state['followUpTaskId']);
  const customerId = (state['customer'] as { id?: string } | undefined)?.id ?? '';
  const now = ctx.now;
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    await tx
      .update(schema.followUpTask)
      .set({ status: 'paused', updatedAt: now })
      .where(eq(schema.followUpTask.id, followUpTaskId));
    if (customerId) {
      await tx.insert(schema.customerActivity).values({
        id: createId('act'),
        orgId: ctx.orgId,
        customerId,
        type: 'ai_action',
        summary: '检测到客户已回复，AI 跟进自动暂停并转人工（07 §4）',
        operatorType: 'ai',
        operatorId: ctx.employeeId,
        operatorName: ctx.employee.name,
        refType: 'follow_up_task',
        refId: followUpTaskId,
      });
    }
  });
  return { patch: {} };
};

/**
 * select_step（07 FR-03）：步骤由 follow_up_strategy_step 决定（不由 LLM 决定节奏）。
 * 取首个未执行（execution.status='sent' 消费）的策略步；走完 → done（completed · 策略完成）。
 */
const selectStep: FlowNodeFn = async (state, ctx) => {
  const followUpTaskId = str(state['followUpTaskId']);
  const next = await pickNextStep(ctx, followUpTaskId);
  if (!next) {
    return { done: true };
  }
  return { patch: { strategyStep: toStrategyStep(next) } };
};

interface StrategyStepRow {
  seq: number;
  dayOffset: number;
  isBreakup: boolean;
  id: string;
}

/** strategyStep 携带 id：writeback_execution 依此落 execution.strategy_step_id（消费标记的幂等锚点） */
function toStrategyStep(step: StrategyStepRow): {
  id: string;
  seq: number;
  dayOffset: number;
  contentKind: string;
} {
  const contentKind = step.isBreakup
    ? 'breakup'
    : step.seq === 1
      ? 'initial'
      : step.seq === 2
        ? 'value'
        : 'case';
  return { id: step.id, seq: step.seq, dayOffset: step.dayOffset, contentKind };
}

async function pickNextStep(
  ctx: TaskRunContext,
  followUpTaskId: string,
): Promise<StrategyStepRow | null> {
  return withOrg(ctx.db, ctx.orgId, async (tx) => {
    const [ft] = await tx
      .select({ strategyId: schema.followUpTask.strategyId })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, followUpTaskId))
      .limit(1);
    if (!ft) {
      return null;
    }
    const steps = await tx
      .select({
        id: schema.followUpStrategyStep.id,
        seq: schema.followUpStrategyStep.seq,
        dayOffset: schema.followUpStrategyStep.dayOffset,
        isBreakup: schema.followUpStrategyStep.isBreakup,
      })
      .from(schema.followUpStrategyStep)
      .where(eq(schema.followUpStrategyStep.strategyId, ft.strategyId))
      .orderBy(schema.followUpStrategyStep.seq);
    const executed = await tx
      .select({ strategyStepId: schema.followUpExecution.strategyStepId })
      .from(schema.followUpExecution)
      .where(
        and(
          eq(schema.followUpExecution.followUpTaskId, followUpTaskId),
          eq(schema.followUpExecution.status, 'sent'),
        ),
      );
    const doneIds = new Set(executed.map((e) => e.strategyStepId));
    return steps.find((s) => !doneIds.has(s.id)) ?? null;
  });
}

/** writeback_execution：follow_up_execution(sent) + lastExecutedAt + CRM 活动记录 */
const writebackExecution: FlowNodeFn = async (state, ctx) => {
  const followUpTaskId = str(state['followUpTaskId']);
  const customerId = (state['customer'] as { id?: string } | undefined)?.id ?? '';
  const step = state['strategyStep'] as
    { id?: string; seq?: number; contentKind?: string } | undefined;
  const content = state['content'] as { body?: string } | undefined;
  const messageId = str(state['messageId']);
  const now = ctx.now;
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    await tx.insert(schema.followUpExecution).values({
      id: createId('fexc'),
      orgId: ctx.orgId,
      followUpTaskId,
      strategyStepId: step?.id ?? null,
      stepTitle: `第 ${step?.seq ?? '?'} 步 · ${step?.contentKind ?? 'follow_up'}`,
      status: 'sent',
      content: content?.body ?? null,
      messageId: messageId || null,
      sentAt: now,
    });
    await tx
      .update(schema.followUpTask)
      .set({ lastExecutedAt: now, updatedAt: now })
      .where(eq(schema.followUpTask.id, followUpTaskId));
    if (customerId) {
      await tx.insert(schema.customerActivity).values({
        id: createId('act'),
        orgId: ctx.orgId,
        customerId,
        type: 'ai_action',
        summary: `AI 跟进触达（第 ${step?.seq ?? '?'} 步 · ${step?.contentKind ?? ''}）`,
        operatorType: 'ai',
        operatorId: ctx.employeeId,
        operatorName: ctx.employee.name,
        refType: 'follow_up_task',
        refId: followUpTaskId,
      });
    }
  });
  return { patch: {} };
};

/**
 * schedule_next（07 v0.2.1，与 Scheduler 频控预检共用 @tradepilot/core 同一公式）：
 * 候选 = max(策略基准 + next.dayOffset 天, L + minTouchIntervalDays 天) → org.timezone 窗口对齐。
 * 有下一步 → follow_up_task.status=scheduled + nextStep；走完 → completed（done）。
 */
const scheduleNext: FlowNodeFn = async (state, ctx) => {
  const followUpTaskId = str(state['followUpTaskId']);
  const next = await pickNextStep(ctx, followUpTaskId);
  const now = ctx.now;
  const minTouchIntervalDays = ctx.org.sendRules?.minTouchIntervalDays ?? 3;
  const window = parseSendWindow(ctx.org.sendRules);

  if (!next) {
    await withOrg(ctx.db, ctx.orgId, async (tx) => {
      await tx
        .update(schema.followUpTask)
        .set({ status: 'completed', nextRunAt: null, updatedAt: now })
        .where(eq(schema.followUpTask.id, followUpTaskId));
    });
    return { done: true };
  }

  const [ft] = await withOrg(ctx.db, ctx.orgId, async (tx) =>
    tx
      .select({ createdAt: schema.followUpTask.createdAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, followUpTaskId))
      .limit(1),
  );
  // 策略基准 = Day 0（任务创建）；候选不早于当前时刻（过期步即时生效）
  const base = ft?.createdAt ?? now;
  const byDayOffset = new Date(base.getTime() + next.dayOffset * 86_400_000);
  const scheduled = byDayOffset.getTime() > now.getTime() ? byDayOffset : now;
  const lastOutboundAt = (ctx.bag.get('lastOutboundAt') as Date | null) ?? null;
  const nextRunAt = computeDeferredNextRunAt({
    now,
    nextRunAt: scheduled,
    lastOutboundAt,
    minTouchIntervalDays,
    timeZone: ctx.org.timezone,
    ...(window ? { window } : {}),
  });
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    await tx
      .update(schema.followUpTask)
      .set({ nextRunAt, status: 'scheduled', updatedAt: now })
      .where(eq(schema.followUpTask.id, followUpTaskId));
  });
  return { patch: { nextStep: { seq: next.seq, runAt: nextRunAt.toISOString() } } };
};

/** ===== product_analysis（M5-C4：customer_insight 写回） ===== */

/**
 * load_analysis_context：分析对象加载。
 * - customerId（客户 360 /customers/{id}/analyze）：加载客户画像快照 → analysisTargets 单元素；
 * - leadIds（03 /leads/batch-analyze）：发现池 lead 快照（ai_lead 非 customer，洞察仅落 outputs，
 *   不写 customer_insight——FK 约束 customer_id → customer.id）。
 */
const loadAnalysisContext: FlowNodeFn = async (state, ctx) => {
  const customerId = str(state['customerId']);
  const leadIds = Array.isArray(state['leadIds'])
    ? state['leadIds'].map((v) => String(v)).filter((v) => v.length > 0)
    : [];

  const targets: { id: string; name: string; country: string; industry: string | null }[] = [];
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    if (customerId) {
      const [c] = await tx
        .select({
          id: schema.customer.id,
          companyName: schema.customer.companyName,
          country: schema.customer.country,
          industry: schema.customer.industry,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt)))
        .limit(1);
      if (c) {
        targets.push({
          id: c.id,
          name: c.companyName,
          country: c.country,
          industry: c.industry,
        });
      }
      return;
    }
    if (leadIds.length > 0) {
      const rows = await tx
        .select({
          id: schema.aiLead.id,
          companyName: schema.aiLead.companyName,
          country: schema.aiLead.country,
          industry: schema.aiLead.industry,
        })
        .from(schema.aiLead)
        .where(and(eq(schema.aiLead.orgId, ctx.orgId), inArray(schema.aiLead.id, leadIds)));
      for (const r of rows) {
        targets.push({ id: r.id, name: r.companyName, country: r.country, industry: r.industry });
      }
    }
  });
  return { patch: { analysisTargets: targets } };
};

/**
 * write_customer_insight：copilot 分析产出 → customer_insight
 * （uq_customer_insight_type 按 (customer_id, insight_type) upsert；taskId 溯源 ai_task）。
 * 仅 customerId 场景写表；value = purchaseProbability（numeric 文本），reasons = 推荐动作映射。
 */
const writeCustomerInsight: FlowNodeFn = async (state, ctx) => {
  const customerId = str(state['customerId']);
  const copilot = state['copilot'] as
    | { purchaseProbability?: number; stage?: string; recommendedActions?: string[] }
    | undefined;
  if (!customerId || !copilot) {
    return { patch: {} };
  }
  const actions = (copilot.recommendedActions ?? [])
    .filter((a) => typeof a === 'string' && a.trim().length > 0)
    .slice(0, 5);
  const probability =
    typeof copilot.purchaseProbability === 'number' && Number.isFinite(copilot.purchaseProbability)
      ? Math.max(0, Math.min(100, Math.round(copilot.purchaseProbability)))
      : null;
  const reasons = actions.map((label) => ({ text: label }));
  const nextAction =
    actions.length > 0 ? { type: 'follow_up', label: actions[0]! } : null;
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    await tx
      .insert(schema.customerInsight)
      .values({
        id: createId('cins'),
        orgId: ctx.orgId,
        customerId,
        insightType: 'purchase_probability',
        ...(probability !== null ? { value: String(probability) } : {}),
        reasons,
        ...(nextAction ? { nextAction } : {}),
        taskId: ctx.taskId,
        generatedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [schema.customerInsight.customerId, schema.customerInsight.insightType],
        set: {
          ...(probability !== null ? { value: String(probability) } : {}),
          reasons,
          ...(nextAction ? { nextAction } : {}),
          taskId: ctx.taskId,
          generatedAt: ctx.now,
          updatedAt: ctx.now,
        },
      });
  });
  return { patch: {} };
};

/** ===== 注册表装配 ===== */

/** 注册到具体实现类（register 方法在 Simple 实现上，接口仅暴露 get/has） */
export function registerFlows(registry: SimpleFlowRegistry): void {
  registry.register('dedup_check', dedupCheck);
  registry.register('record_score', recordScore);
  registry.register('target_reached', targetReached);
  registry.register('assemble_leads', assembleLeads);
  registry.register('finalize', finalize);
  registry.register('load_thread', loadThread);
  registry.register('draft_branch', draftBranch);
  registry.register('need_info', needInfo);
  registry.register('writeback', writeback);
  registry.register('load_context', loadContext);
  registry.register('check_replied', checkReplied);
  registry.register('pause_strategy', pauseStrategy);
  registry.register('select_step', selectStep);
  registry.register('writeback_execution', writebackExecution);
  registry.register('schedule_next', scheduleNext);
  registry.register('load_analysis_context', loadAnalysisContext);
  registry.register('write_customer_insight', writeCustomerInsight);
}

/** 便捷装配：新建 SimpleFlowRegistry 并注入全部 flow */
export function createFlowRegistry(): FlowRegistry {
  const registry = new SimpleFlowRegistry();
  registerFlows(registry);
  return registry;
}
