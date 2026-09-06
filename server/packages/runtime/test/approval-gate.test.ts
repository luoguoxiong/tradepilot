import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import pino from 'pino';
import type { Db } from '@tradepilot/db';
import { ApprovalGate, type GateToolMeta, type TaskRunContext } from '../src/index.js';

/**
 * ApprovalGate 分流放行链单测（Runtime §4.7）：
 * ① high 必人工 → ② 强制人工例外（breakup / always / high_value_only×高价值）→
 * ③ org autoApprove + 员工 autoExecute → auto_approve → ④ 其余人工。
 * decide 不落库；仅 high_value_only × customerId 路径查客户分层（mock Db 承接）。
 */

const logger = pino({ level: 'silent' });

/** 最小 fake Db：只承接 customerTier 的 select…limit 链 */
function makeFakeDb(rows: { score: number | null }[]): Db {
  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  };
  return { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;
}

function makeCtx(overrides?: {
  autoApproveTypes?: string[];
  autoExecute?: string[];
  emailSendPolicy?: 'always' | 'high_value_only';
}): TaskRunContext {
  return {
    orgId: 'org-x',
    taskId: 'task-x',
    employeeId: 'emp-x',
    nodeId: 'email_send',
    taskType: 'email_reply',
    redis: {} as Redis,
    logger,
    now: new Date(),
    bag: new Map(),
    events: [],
    db: null as never,
    employee: {
      id: 'emp-x',
      orgId: 'org-x',
      role: 'sales',
      name: 'AI 销售',
      tools: ['email_send'],
      knowledgeScope: [],
      approvalPolicy: {
        email_send: overrides?.emailSendPolicy ?? 'high_value_only',
        quote: 'always',
        autoExecute: overrides?.autoExecute ?? [],
      },
      memoryConfig: null,
      externalCallDailyLimit: 200,
    },
    org: {
      id: 'org-x',
      timezone: 'Asia/Shanghai',
      sendRules: null,
      autoApproveTypes: overrides?.autoApproveTypes ?? [],
    },
    task: { id: 'task-x', title: '回复客户', input: {} },
    progressPct: 0,
    currentStep: '',
  };
}

const emailSendTool: GateToolMeta = { name: 'email_send', riskLevel: 'medium', approvalType: 'email_send' };
const quoteTool: GateToolMeta = { name: 'create_quote', riskLevel: 'high', approvalType: 'quote' };

function makeGate(db: Db = makeFakeDb([])): ApprovalGate {
  return new ApprovalGate(db, {} as Redis, { publish: vi.fn() } as never, logger);
}

describe('ApprovalGate.decide 分流放行链（Runtime §4.7）', () => {
  it('① high 风险一律 interrupt（不查库）', async () => {
    const verdict = await makeGate().decide(quoteTool, makeCtx(), {});
    expect(verdict.action).toBe('interrupt');
    expect(verdict.reason).toContain('high');
  });

  it('② Break-up Email 强制人工审（07 §4，优先于 autoApprove）', async () => {
    const ctx = makeCtx({ autoApproveTypes: ['email_send'], autoExecute: ['email_send'] });
    const verdict = await makeGate().decide(emailSendTool, ctx, { contentKind: 'breakup' });
    expect(verdict.action).toBe('interrupt');
    expect(verdict.reason).toContain('Break-up');
  });

  it("② 员工 approval_policy.email_send='always' 强制人工审", async () => {
    const ctx = makeCtx({ emailSendPolicy: 'always', autoApproveTypes: ['email_send'], autoExecute: ['email_send'] });
    const verdict = await makeGate().decide(emailSendTool, ctx, { contentKind: 'initial' });
    expect(verdict.action).toBe('interrupt');
    expect(verdict.reason).toContain('always');
  });

  it("② high_value_only × 高价值客户（score≥85）→ interrupt（查库定层）", async () => {
    const ctx = makeCtx({ emailSendPolicy: 'high_value_only', autoApproveTypes: ['email_send'], autoExecute: ['email_send'] });
    const gate = makeGate(makeFakeDb([{ score: 90 }]));
    const verdict = await gate.decide(emailSendTool, ctx, { customerId: 'cus-h' });
    expect(verdict.action).toBe('interrupt');
    expect(verdict.reason).toContain('高价值');
  });

  it('② high_value_only × 低价值客户不拦截，③ 命中 autoApprove+autoExecute → auto_approve', async () => {
    const ctx = makeCtx({ emailSendPolicy: 'high_value_only', autoApproveTypes: ['email_send'], autoExecute: ['email_send'] });
    const gate = makeGate(makeFakeDb([{ score: 40 }]));
    const verdict = await gate.decide(emailSendTool, ctx, { customerId: 'cus-l' });
    expect(verdict.action).toBe('auto_approve');
  });

  it('③ medium + org autoApprove + 员工 autoExecute → auto_approve', async () => {
    const ctx = makeCtx({ emailSendPolicy: 'high_value_only', autoApproveTypes: ['email_send'], autoExecute: ['email_send'] });
    const verdict = await makeGate().decide(emailSendTool, ctx, { customerId: 'cus-x' });
    expect(verdict.action).toBe('auto_approve');
  });

  it('④ org 已开 autoApprove 但员工 autoExecute 未含 → interrupt', async () => {
    const ctx = makeCtx({ emailSendPolicy: 'high_value_only', autoApproveTypes: ['email_send'], autoExecute: [] });
    const verdict = await makeGate().decide(emailSendTool, ctx, {});
    expect(verdict.action).toBe('interrupt');
  });

  it('④ 缺省：medium 未命中任何放行条件 → interrupt', async () => {
    const ctx = makeCtx({ emailSendPolicy: 'high_value_only' });
    const verdict = await makeGate().decide(emailSendTool, ctx, {});
    expect(verdict.action).toBe('interrupt');
  });
});
