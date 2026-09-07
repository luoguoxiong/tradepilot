/**
 * P0 三图 SOP 定义（LangGraph 工作流 §2~§4 mermaid 逐节点落地）+ State 通道键注册。
 * - 节点 id/边与文档 §2.2/§3.2/§4.3 对齐；M3 以 flow 承载的节点在 flows.ts 顶部说明；
 * - 与文档 State 的差异：增加少量「编排辅助键」（搜 searchPlan/crmLeads/knowledgeChunks 等），
 *   原因：LastValue 通道无 reducer（累积经 flow/bag）+ 工具出参形状到 doc 字段的桥接；
 * - stateKeys 供 GraphCompiler 建通道；input 顶层同名键由 runner 播种进初始 State。
 */
import { BizException, ErrorCode } from '@tradepilot/core';
import type { SopGraphDefinition } from '@tradepilot/shared';
import type { TaskSopProvider } from '@tradepilot/runtime';

/** BaseTaskState 六键（通道声明必需） */
const BASE_KEYS = ['taskId', 'orgId', 'employeeId', 'taskType', 'input', 'errors'] as const;

const LEAD_HUNTING_SOP: SopGraphDefinition = {
  version: 2,
  entry: 'parse_goal',
  nodes: [
    { id: 'parse_goal', kind: 'llm', promptRef: 'leadHunting.parseGoal', outputSchema: 'parsedGoal', outputKey: 'parsed', title: '解析获客目标', progress: 5 },
    { id: 'retrieve_knowledge', kind: 'tool', tool: 'knowledge_search', input: { scene: 'lead_match', topK: 3 }, inputMap: { query: 'parsed.targetProduct' }, outputKey: 'knowledgeChunks', title: '产品知识检索', progress: 5 },
    { id: 'plan_search', kind: 'llm', promptRef: 'leadHunting.planSearch', outputSchema: 'searchPlan', outputKey: 'searchPlan', logType: 'search', title: '生成搜索策略', progress: 10 },
    { id: 'web_search', kind: 'tool', tool: 'web_search', inputMap: { queries: 'searchPlan.queries' }, outputKey: 'searchResult', logType: 'found', title: '执行网页搜索' },
    { id: 'dedup_check', kind: 'flow', route: 'dedup_check', title: '三级去重' },
    { id: 'crawl_site', kind: 'tool', tool: 'site_crawl', inputMap: { domain: 'discovered.0.domain', companyName: 'discovered.0.companyName' }, outputKey: 'siteSummary', logType: 'crawl', title: '抓取官网摘要' },
    { id: 'match_product', kind: 'llm', promptRef: 'leadHunting.matchProduct', outputSchema: 'leadScore', outputKey: 'currentScore', logType: 'match', title: '产品匹配评分', progress: 8 },
    { id: 'record_score', kind: 'flow', route: 'record_score', title: '记录评分' },
    { id: 'find_contact', kind: 'tool', tool: 'find_contact', inputMap: { companyName: 'discovered.0.companyName', domain: 'discovered.0.domain', jobTitles: 'input.advancedSettings.jobTitles' }, outputKey: 'contacts', logType: 'contact', title: '发现联系人', progress: 5 },
    { id: 'lookup_contact', kind: 'tool', tool: 'lookup_contact', inputMap: { companyName: 'discovered.0.companyName', domain: 'discovered.0.domain' }, outputKey: 'lookupResult', logType: 'lookup', title: '公开渠道联系方式', progress: 5 },
    { id: 'target_check', kind: 'flow', route: 'target_reached', title: '目标数检查' },
    { id: 'assemble_leads', kind: 'flow', route: 'assemble_leads', title: '汇总发现池' },
    { id: 'save_to_crm_pool', kind: 'tool', tool: 'crm_write', inputMap: { leads: 'crmLeads' }, logType: 'found', title: '写入客户发现池', progress: 40 },
    { id: 'finalize', kind: 'flow', route: 'finalize', title: '汇总产出', progress: 25 },
  ],
  edges: [
    { from: 'parse_goal', to: 'retrieve_knowledge' },
    { from: 'retrieve_knowledge', to: 'plan_search' },
    { from: 'plan_search', to: 'web_search' },
    { from: 'web_search', to: 'dedup_check' },
    { from: 'dedup_check', to: 'crawl_site', when: 'new' },
    { from: 'dedup_check', to: 'target_check', when: 'duplicate' },
    { from: 'crawl_site', to: 'match_product' },
    { from: 'match_product', to: 'record_score' },
    { from: 'record_score', to: 'find_contact', when: 'matched' },
    { from: 'record_score', to: 'target_check', when: 'low' },
    { from: 'find_contact', to: 'lookup_contact' },
    { from: 'lookup_contact', to: 'target_check' },
    { from: 'target_check', to: 'web_search', when: 'continue' },
    { from: 'target_check', to: 'assemble_leads', when: 'save' },
    { from: 'assemble_leads', to: 'save_to_crm_pool' },
    { from: 'save_to_crm_pool', to: 'finalize' },
  ],
};

const EMAIL_REPLY_SOP: SopGraphDefinition = {
  version: 1,
  entry: 'load_thread',
  nodes: [
    { id: 'load_thread', kind: 'flow', route: 'load_thread', title: '加载会话上下文', progress: 10 },
    { id: 'analyze_intent', kind: 'llm', promptRef: 'sales.analyzeIntent', outputSchema: 'intent', outputKey: 'intent', title: '意图识别', progress: 10 },
    { id: 'copilot_analyze', kind: 'llm', promptRef: 'sales.copilotAnalyze', outputSchema: 'copilot', outputKey: 'copilot', title: 'Copilot 分析', progress: 15 },
    { id: 'retrieve_knowledge', kind: 'tool', tool: 'knowledge_search', input: { scene: 'email_reply', topK: 5 }, inputMap: { query: 'intent.label' }, outputKey: 'knowledgeChunks', title: '知识检索', progress: 10 },
    { id: 'draft_reply', kind: 'llm', promptRef: 'sales.draftReply', outputSchema: 'draftReply', outputKey: 'draft', title: '生成回复草稿', progress: 25 },
    { id: 'draft_branch', kind: 'flow', route: 'draft_branch', title: '依据校验分流' },
    { id: 'email_send', kind: 'tool', tool: 'email_send', risk: 'medium', approvalType: 'email_send', inputMap: { conversationId: 'conversationId', subject: 'draft.subject', body: 'draft.body', inboxMessageId: 'inboxMessageId', customerId: 'customerId' }, title: '发送回复邮件', progress: 20 },
    { id: 'writeback', kind: 'flow', route: 'writeback', title: '回写 CRM 活动', progress: 10 },
    { id: 'need_info', kind: 'flow', route: 'need_info', title: '缺料收尾' },
  ],
  edges: [
    { from: 'load_thread', to: 'analyze_intent' },
    { from: 'analyze_intent', to: 'copilot_analyze' },
    { from: 'copilot_analyze', to: 'retrieve_knowledge' },
    { from: 'retrieve_knowledge', to: 'draft_reply' },
    { from: 'draft_reply', to: 'draft_branch' },
    { from: 'draft_branch', to: 'email_send', when: 'grounded' },
    { from: 'draft_branch', to: 'need_info', when: 'need_info' },
    { from: 'email_send', to: 'writeback' },
  ],
};

const FOLLOW_UP_SOP: SopGraphDefinition = {
  version: 1,
  entry: 'load_context',
  nodes: [
    { id: 'load_context', kind: 'flow', route: 'load_context', title: '加载跟进上下文', progress: 10 },
    { id: 'check_replied', kind: 'flow', route: 'check_replied', title: '客户回复检查' },
    { id: 'pause_strategy', kind: 'flow', route: 'pause_strategy', title: '暂停策略转人工' },
    { id: 'select_step', kind: 'flow', route: 'select_step', title: '选取策略步' },
    { id: 'retrieve_content', kind: 'tool', tool: 'knowledge_search', input: { scene: 'follow_up', topK: 3 }, inputMap: { query: 'strategyStep.contentKind' }, outputKey: 'knowledgeChunks', title: '素材检索', progress: 10 },
    { id: 'generate_follow_up', kind: 'llm', promptRef: 'followUp.generate', outputSchema: 'followUpContent', outputKey: 'content', title: '生成跟进内容', progress: 25 },
    { id: 'email_send', kind: 'tool', tool: 'email_send', risk: 'medium', approvalType: 'email_send', inputMap: { conversationId: 'conversationId', subject: 'content.subject', body: 'content.body', contentKind: 'strategyStep.contentKind', customerId: 'customer.id' }, title: '发送跟进邮件', progress: 20 },
    { id: 'writeback_execution', kind: 'flow', route: 'writeback_execution', title: '执行记录回写', progress: 15 },
    { id: 'schedule_next', kind: 'flow', route: 'schedule_next', title: '排期下一步', progress: 20 },
  ],
  edges: [
    { from: 'load_context', to: 'check_replied' },
    { from: 'check_replied', to: 'pause_strategy', when: 'replied' },
    { from: 'check_replied', to: 'select_step', when: 'no' },
    { from: 'select_step', to: 'retrieve_content' },
    { from: 'retrieve_content', to: 'generate_follow_up' },
    { from: 'generate_follow_up', to: 'email_send' },
    { from: 'email_send', to: 'writeback_execution' },
    { from: 'writeback_execution', to: 'schedule_next' },
  ],
};

/** taskType → SOP + State 通道键（文档字段 + 编排辅助键） */
const TASK_SOPS: Record<string, { sop: SopGraphDefinition; stateKeys: string[] }> = {
  lead_hunting: {
    sop: LEAD_HUNTING_SOP,
    stateKeys: [
      ...BASE_KEYS,
      // 文档 §2.1
      'parsed', 'searchQueries', 'discovered', 'scored', 'contacts', 'targetCount',
      // 编排辅助（见文件头说明）
      'searchPlan', 'searchResult', 'siteSummary', 'currentScore', 'crmLeads',
      'knowledgeChunks', 'lookupResult',
    ],
  },
  email_reply: {
    sop: EMAIL_REPLY_SOP,
    stateKeys: [
      ...BASE_KEYS,
      // 文档 §3.1
      'thread', 'detectedLanguage', 'intent', 'copilot', 'knowledgeRefs', 'draft', 'sentMessageId',
      // 编排辅助
      'inboxMessageId', 'conversationId', 'customerId', 'customerSnapshot', 'knowledgeChunks', 'messageId',
    ],
  },
  follow_up: {
    sop: FOLLOW_UP_SOP,
    stateKeys: [
      ...BASE_KEYS,
      // 文档 §4.2
      'followUpTaskId', 'strategyStep', 'customer', 'repliedSinceLast', 'content', 'nextStep',
      // 编排辅助
      'conversationId', 'customerId', 'knowledgeChunks', 'messageId',
    ],
  },
};

export const workflowSopProvider: TaskSopProvider = {
  get(taskType: string): { sop: unknown; stateKeys: string[] } {
    const entry = TASK_SOPS[taskType];
    if (!entry) {
      throw new BizException(ErrorCode.NOT_FOUND, `task_type 无内置 SOP: ${taskType}`);
    }
    return { sop: entry.sop, stateKeys: entry.stateKeys };
  },
};

/** 三图 SOP 直接映射（诊断/测试用；运行时经 workflowSopProvider 携带 stateKeys） */
export const WORKFLOW_SOP_DEFINITIONS: Readonly<Record<string, SopGraphDefinition>> = {
  lead_hunting: LEAD_HUNTING_SOP,
  email_reply: EMAIL_REPLY_SOP,
  follow_up: FOLLOW_UP_SOP,
};
