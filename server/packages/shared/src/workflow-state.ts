/**
 * 工作流 State 与 SOP 图结构契约（LangGraph 工作流 00 §1~§4 + Runtime 总纲 §4.3）。
 * packages/runtime 编译器消费；State 类型与文档定义一字不差。
 */
import { z } from 'zod';
import type { RiskLevel } from './enums/index.js';

/** 任务日志类型（03 §1.5 枚举，与 DB task_log_type 一致） */
export const TASK_LOG_TYPE = {
  SEARCH: 'search',
  FOUND: 'found',
  CRAWL: 'crawl',
  MATCH: 'match',
  CONTACT: 'contact',
  LOOKUP: 'lookup',
  ERROR: 'error',
} as const;
export type TaskLogType = (typeof TASK_LOG_TYPE)[keyof typeof TASK_LOG_TYPE];

/** ===== SOP 图结构（Runtime 总纲 §4.3 jsonc 结构）===== */

export const SOP_NODE_KIND = { LLM: 'llm', TOOL: 'tool', FLOW: 'flow' } as const;
export type SopNodeKind = (typeof SOP_NODE_KIND)[keyof typeof SOP_NODE_KIND];

export const MODEL_TIER = { LIGHT: 'light', MEDIUM: 'medium', STRONG: 'strong' } as const;
export type ModelTier = (typeof MODEL_TIER)[keyof typeof MODEL_TIER];

/** llm 节点 */
export interface SopLlmNode {
  id: string;
  kind: 'llm';
  promptRef: string;
  /** 结构化输出 schema 注册名（LangGraph 工作流 §6 / runtime 输出 schema 注册表） */
  outputSchema?: string;
  /** 结果写入的 State 字段名（缺省：data 本身为对象时展开合并，标量写节点 id 键） */
  outputKey?: string;
  logType?: TaskLogType;
  /** 模型档位（promptRef↔档位映射固化于 LangGraph 工作流 §6） */
  tier?: ModelTier;
  /** 步骤展示名（ai_task_step.name） */
  title?: string;
  /** 节点完成后进度（静态映射 LangGraph 工作流各图进度贡献） */
  progress?: number;
}

/** tool 节点：risk=medium/high 执行前自动进 Approval Gate（总纲 §4.7），图中不手写 interrupt */
export interface SopToolNode {
  id: string;
  kind: 'tool';
  tool: string;
  /** 入参装配：静态 JSON（与 inputMap 合并，inputMap 优先） */
  input?: Record<string, unknown>;
  /** 入参装配：State 字段映射（schema 字段名 → State 键） */
  inputMap?: Record<string, string>;
  /** 结果写入的 State 字段名（缺省展开合并工具返回对象） */
  outputKey?: string;
  logType?: TaskLogType;
  risk?: RiskLevel;
  approvalType?: string;
  title?: string;
  progress?: number;
}

/** flow 节点：控制流（dedup_check / check_replied / schedule_next 等，在 workflows 包代码注册表实现） */
export interface SopFlowNode {
  id: string;
  kind: 'flow';
  /** 条件分支路由函数名（workflows 包注册表键） */
  route?: string;
  title?: string;
  progress?: number;
}

export type SopNode = SopLlmNode | SopToolNode | SopFlowNode;

export interface SopEdge {
  from: string;
  to: string;
  /** 条件边：from 节点返回的分支键（如 'yes'/'no'、'matched'/'low'） */
  when?: string;
}

/** sop_template.content 的图定义部分（总纲 §4.3） */
export interface SopGraphDefinition {
  version: number;
  entry: string;
  nodes: SopNode[];
  edges: SopEdge[];
  /** 提前结束条件（如获客达到 targetCount） */
  doneWhen?: string;
}

/** sop_template.content 解析 schema（编译器入参校验，05 §2：Zod 校验 nodes/edges/kind 枚举/promptRef 存在性） */
export const sopGraphDefinitionSchema = z
  .object({
    version: z.number().int().min(1),
    entry: z.string().min(1),
    nodes: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            id: z.string().min(1),
            kind: z.literal('llm'),
            promptRef: z.string().min(1),
            outputSchema: z.string().optional(),
            outputKey: z.string().optional(),
            logType: z.string().optional(),
            tier: z.enum(['light', 'medium', 'strong']).optional(),
            title: z.string().optional(),
            progress: z.number().min(0).max(100).optional(),
          }),
          z.object({
            id: z.string().min(1),
            kind: z.literal('tool'),
            tool: z.string().min(1),
            input: z.record(z.unknown()).optional(),
            inputMap: z.record(z.string()).optional(),
            outputKey: z.string().optional(),
            logType: z.string().optional(),
            risk: z.enum(['low', 'medium', 'high']).optional(),
            approvalType: z.string().optional(),
            title: z.string().optional(),
            progress: z.number().min(0).max(100).optional(),
          }),
          z.object({
            id: z.string().min(1),
            kind: z.literal('flow'),
            route: z.string().optional(),
            title: z.string().optional(),
            progress: z.number().min(0).max(100).optional(),
          }),
        ]),
      )
      .min(1),
    edges: z.array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        when: z.string().optional(),
      }),
    ),
    doneWhen: z.string().optional(),
  })
  .superRefine((sop, ctx) => {
    const ids = new Set(sop.nodes.map((n) => n.id));
    if (!ids.has(sop.entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entry'], message: `入口节点 ${sop.entry} 不存在` });
    }
    sop.edges.forEach((e, i) => {
      if (!ids.has(e.from) || !ids.has(e.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', i], message: `边 ${e.from}→${e.to} 引用未知节点` });
      }
    });
  });

/** ===== BaseTaskState（LangGraph 工作流 §1.1）===== */

export interface TaskStateError {
  nodeId: string;
  message: string;
  retried: boolean;
}

export interface BaseTaskState {
  taskId: string;
  orgId: string;
  employeeId: string;
  taskType: string;
  input: Record<string, unknown>;
  errors: TaskStateError[];
}

/** ===== lead_hunting（LangGraph 工作流 §2）===== */

export interface CompanyLead {
  domain: string | null;
  companyName: string;
  country?: string;
  website?: string;
  source: string;
  /** dedup_check 标记 */
  duplicate?: boolean;
  /** excludeDomains 硬过滤标记 */
  excluded?: boolean;
}

/** Insight Schema（03 §4 可解释红线；insight/schema.ts 同构） */
export interface LeadScore {
  companyName: string;
  matchPct: number;
  scoreLevel: 'high' | 'medium' | 'low';
  reasons: { text: string; evidence?: string; source?: string }[];
}

export interface LeadContact {
  companyName: string;
  name?: string;
  title?: string;
  email?: string;
  /** 决策影响力（90/75/40 档确定性映射，未命中 null，04 需求 §3.2） */
  decisionInfluencePct: number | null;
}

export interface LeadHuntingState extends BaseTaskState {
  parsed: {
    targetMarket?: string;
    customerType?: string;
    targetProduct?: string;
    companySize?: string;
  };
  searchQueries: string[];
  discovered: CompanyLead[];
  scored: LeadScore[];
  contacts: LeadContact[];
  targetCount: number;
}

/** ===== email_reply（LangGraph 工作流 §3）===== */

export interface EmailMessageRef {
  messageId: string;
  direction: 'in' | 'out';
  subject: string | null;
  body: string;
  language: string | null;
  sentAt: string | null;
  senderType?: string;
}

export interface KnowledgeChunkRef {
  chunkId: string;
  documentId: string;
  title: string;
  category: string;
  excerpt: string;
}

export interface EmailReplyState extends BaseTaskState {
  input: { inboxMessageId: string };
  thread: EmailMessageRef[];
  /** 来信语言：跟随最近一条 in 消息 language，缺省英文（06 §7） */
  detectedLanguage?: string;
  intent: { label: string; confidence: number };
  copilot: {
    purchaseProbability: number;
    stage: string;
    recommendedActions: string[];
  };
  knowledgeRefs: KnowledgeChunkRef[];
  draft: { subject: string; body: string; grounded: boolean; missingInfo?: string[] };
  sentMessageId?: string;
}

/** ===== follow_up（LangGraph 工作流 §4）===== */

export interface FollowUpState extends BaseTaskState {
  followUpTaskId: string;
  strategyStep: { seq: number; dayOffset: number; contentKind: string };
  customer: { id: string; tier: 'high' | 'medium' | 'low'; stage: string };
  repliedSinceLast: boolean;
  content: { subject: string; body: string; grounded: boolean };
  nextStep?: { seq: number; runAt: string };
}

/** 节点进度贡献函数（LangGraph 工作流 §1.2：progressOf(state) 纯函数） */
export type ProgressOf<S extends BaseTaskState> = (state: S) => number;
