/**
 * Runtime 上下文与依赖装配类型（后端技术方案 05）。
 * TaskRunContext 经 LangGraph config.configurable 传入节点包装器；节点内 DB 写共享 withOrg 事务。
 */
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '@tradepilot/db';
import type { ApprovalRule, EmployeeApprovalPolicy, OrgSendRules } from '@tradepilot/db';
import type { BufferedTaskEvent } from '@tradepilot/tools';

/** 任务运行所需的员工快照（领取时加载，任务内不变——SOP 版本锁定语义） */
export interface EmployeeRuntime {
  id: string;
  orgId: string;
  role: string;
  name: string;
  tools: string[];
  knowledgeScope: string[];
  approvalPolicy: EmployeeApprovalPolicy;
  memoryConfig: { retentionDays?: number; scope?: string } | null;
  externalCallDailyLimit: number;
}

/** 任务运行所需的 org 快照（时区/发送窗口/频控） */
export interface OrgRuntime {
  id: string;
  timezone: string;
  sendRules: OrgSendRules | null;
  /** org 级 autoApprove 开关：从 role_permission.approval_rules 提取（16 FR-08，仅 medium 可开） */
  autoApproveTypes: string[];
}

/** 组织级审批规则行（role_permission.approval_rules） */
export type OrgApprovalRule = ApprovalRule & { autoApprove?: boolean };

/** 节点级事务化上下文：与 tools.ToolContext 兼容（结构化子集） */
export interface NodeTxContext {
  orgId: string;
  taskId: string;
  employeeId: string;
  nodeId: string;
  taskType: string;
  redis: Redis;
  logger: Logger;
  now: Date;
  bag: Map<string, unknown>;
  events: BufferedTaskEvent[];
}

/** 任务级运行上下文（贯穿整个图执行） */
export interface TaskRunContext extends NodeTxContext {
  db: Db;
  employee: EmployeeRuntime;
  org: OrgRuntime;
  /** 任务行快照（input/outputs 等） */
  task: { id: string; title: string; input: Record<string, unknown> };
  /** 当前节点（wrapper 设置） */
  nodeId: string;
  progressPct: number;
  currentStep: string;
}
