import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import pino from 'pino';
import type { Logger } from 'pino';
import type { TaskEnqueuer, TaskEventPublisher } from '@tradepilot/runtime';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { ApprovalExpiryScanner } from '../src/scheduler/approval-expiry.js';

/**
 * ApprovalExpiryScanner 独立 spec（后端技术方案 04 §4 / M4 启动清单 A3，M3-T2 测试缺口）：
 * - pending 且 expires_at < now → expired 终态 + approval_log('expired') 系统代理留痕；
 * - 级联 ai_task.failed(approval_expired)（乐观锁）+ follow_up_task.paused（转人工）；
 * - 员工终态回写前置校验（M3-06）：员工仍占用其它任务 → 保持状态；
 * - q:notify 提醒一次 + SSE status/done；
 * - 防重：已有 expired 留痕不再处置（不重复发通知）。
 * 前置：docker compose up（PG 5432）；扫描经 superDb（BYPASSRLS，与生产 sched 角色等效语义）。
 */

const SUPER_URL =
  process.env.TEST_DB_URL ?? 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const logger: Logger = pino({ level: 'silent' });

let db: Db;

const ORG = createId('org');
const USER = createId('usr');
const EMP = createId('aie');
const EMP_BUSY = createId('aie');
const CUS = createId('cus');
const CUS2 = createId('cus');
const STRATEGY = createId('fstr');
const FT = createId('ftask');
const FT2 = createId('ftask');
const TASK = createId('task');
const TASK_BUSY = createId('task');
const APPROVAL = createId('aprq');
const APPROVAL_BUSY = createId('aprq');
const APPROVAL_FUTURE = createId('aprq');

const enqueuer = {
  enqueueNotify: vi.fn(async () => undefined),
} as unknown as TaskEnqueuer;
const publisher = { publish: vi.fn(async () => undefined) } as unknown as TaskEventPublisher;

let scanner: ApprovalExpiryScanner;

/** 过期审批 fixture（linkedTaskId + 级联 followUpTask 可选） */
async function insertExpiredApproval(values: {
  id: string;
  linkedTaskId?: string;
}): Promise<void> {
  await db.insert(schema.approvalRequest).values({
    id: values.id,
    orgId: ORG,
    approvalType: 'email_send',
    riskLevel: 'medium',
    title: `M4-A3 超时审批 ${values.id}`,
    bizType: 'message',
    bizId: createId('msg'),
    context: {},
    aiProposal: {},
    status: 'pending',
    linkedTaskId: values.linkedTaskId ?? null,
    expiresAt: new Date(Date.now() - 60_000),
  });
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  scanner = new ApprovalExpiryScanner({ db, publisher, enqueuer, logger });

  // 跨租户扫描器对 DB 残留敏感：全局清表保干净基线（测试库，TRUNCATE CASCADE 跳过 FK 顺序）
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`TRUNCATE TABLE approval_request, approval_log, ai_task, ai_task_log, ai_task_step, follow_up_task, follow_up_execution RESTART IDENTITY CASCADE`,
    );
  });

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values({
      id: ORG,
      name: 'M4-A3 审批超时租户',
      timezone: 'Asia/Shanghai',
    });
    // 系统代理留痕取 org 首个 manager/admin
    await tx.insert(schema.userAccount).values({
      id: USER,
      orgId: ORG,
      email: `it-apr-${ORG}@test.com`,
      passwordHash: 'x',
      name: '审批超时管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values([
      {
        id: EMP,
        orgId: ORG,
        role: 'sales' as const,
        name: '挂起员工',
        goal: '测试',
        tools: [],
        permissions: {},
        approvalPolicy: {
          email_send: 'high_value_only' as const,
          quote: 'always' as const,
          autoExecute: [],
        },
        kpiConfig: [{ metric: 'leads', target: 1, period: 'daily' as const }],
        status: 'waiting_approval',
      },
      {
        id: EMP_BUSY,
        orgId: ORG,
        role: 'sales' as const,
        name: '占用员工',
        goal: '测试',
        tools: [],
        permissions: {},
        approvalPolicy: {
          email_send: 'high_value_only' as const,
          quote: 'always' as const,
          autoExecute: [],
        },
        kpiConfig: [{ metric: 'leads', target: 1, period: 'daily' as const }],
        status: 'working',
      },
    ]);
    await tx.insert(schema.customer).values([
      { id: CUS, orgId: ORG, companyName: '超时客户A', country: 'US', ownerId: USER },
      { id: CUS2, orgId: ORG, companyName: '超时客户B', country: 'US', ownerId: USER },
    ]);
    await tx.insert(schema.followUpStrategy).values({
      id: STRATEGY,
      orgId: ORG,
      name: 'A3 策略',
      targetScope: {},
      autoSendPolicy: 'manual_review',
    });
    await tx.insert(schema.followUpTask).values([
      {
        id: FT,
        orgId: ORG,
        customerId: CUS,
        strategyId: STRATEGY,
        status: 'waiting_approval',
        nextRunAt: new Date(Date.now() + 3600_000),
      },
      {
        id: FT2,
        orgId: ORG,
        customerId: CUS2,
        strategyId: STRATEGY,
        status: 'waiting_approval',
        nextRunAt: new Date(Date.now() + 3600_000),
      },
    ]);
    await tx.insert(schema.aiTask).values([
      {
        id: TASK,
        orgId: ORG,
        employeeId: EMP,
        type: 'follow_up',
        title: 'A3 级联失败任务',
        status: 'waiting_approval',
        input: { followUpTaskId: FT, customerId: CUS },
      },
      {
        id: TASK_BUSY,
        orgId: ORG,
        employeeId: EMP_BUSY,
        type: 'email_reply',
        title: 'A3 员工占用场景',
        status: 'waiting_approval',
        input: { followUpTaskId: FT2 },
      },
      // EMP_BUSY 的其它占用任务（防「级联失败把跑 A 任务的员工误置 idle」，M3-06）
      {
        id: createId('task'),
        orgId: ORG,
        employeeId: EMP_BUSY,
        type: 'email_reply',
        title: 'A3 占用中的运行任务',
        status: 'running',
        startedAt: new Date(),
      },
    ]);
  });

  await insertExpiredApproval({ id: APPROVAL, linkedTaskId: TASK });
  await insertExpiredApproval({ id: APPROVAL_BUSY, linkedTaskId: TASK_BUSY });
  // 未到期控制组
  await db.insert(schema.approvalRequest).values({
    id: APPROVAL_FUTURE,
    orgId: ORG,
    approvalType: 'email_send',
    riskLevel: 'medium',
    title: 'A3 未到期审批',
    bizType: 'message',
    bizId: createId('msg'),
    context: {},
    aiProposal: {},
    status: 'pending',
    expiresAt: new Date(Date.now() + 3600_000),
  });
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    const orgIds = [ORG];
    await tx.delete(schema.approvalLog).where(inArray(schema.approvalLog.orgId, orgIds));
    await tx.delete(schema.approvalRequest).where(inArray(schema.approvalRequest.orgId, orgIds));
    await tx.delete(schema.aiTask).where(inArray(schema.aiTask.orgId, orgIds));
    await tx.delete(schema.followUpTask).where(inArray(schema.followUpTask.orgId, orgIds));
    await tx.delete(schema.followUpStrategy).where(inArray(schema.followUpStrategy.orgId, orgIds));
    await tx.delete(schema.customer).where(inArray(schema.customer.orgId, orgIds));
    await tx.delete(schema.aiEmployee).where(inArray(schema.aiEmployee.orgId, orgIds));
    await tx.delete(schema.userAccount).where(inArray(schema.userAccount.orgId, orgIds));
    await tx.delete(schema.org).where(inArray(schema.org.id, orgIds));
  });
  await closeDb(db);
});

describe('ApprovalExpiryScanner（04 §4）', () => {
  it('过期审批 → expired 终态 + 系统代理留痕 + 级联 failed/paused + 员工回 idle + notify + SSE', async () => {
    const handled = await scanner.tick();
    // 两条过期（APPROVAL / APPROVAL_BUSY），未到期控制组不动
    expect(handled).toBe(2);

    const [req] = await db
      .select({ status: schema.approvalRequest.status, updatedAt: schema.approvalRequest.updatedAt })
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, APPROVAL));
    expect(req?.status).toBe('expired');

    const logs = await db
      .select({
        action: schema.approvalLog.action,
        approverName: schema.approvalLog.approverName,
        approverId: schema.approvalLog.approverId,
      })
      .from(schema.approvalLog)
      .where(eq(schema.approvalLog.approvalId, APPROVAL));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('expired');
    expect(logs[0]!.approverId).toBe(USER);
    expect(logs[0]!.approverName).toContain('系统超时代理');

    // 级联：ai_task.failed(approval_expired)
    const [task] = await db
      .select({ status: schema.aiTask.status, error: schema.aiTask.error, finishedAt: schema.aiTask.finishedAt })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK));
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('approval_expired');
    expect(task?.finishedAt).not.toBeNull();

    // 级联：follow_up_task.paused（转人工）
    const [ft] = await db
      .select({ status: schema.followUpTask.status })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT));
    expect(ft?.status).toBe('paused');

    // 员工无其它占用任务 → idle
    const [emp] = await db
      .select({ status: schema.aiEmployee.status })
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, EMP));
    expect(emp?.status).toBe('idle');

    // q:notify 提醒（每条过期一次）
    expect(enqueuer.enqueueNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_expired', approvalId: APPROVAL, orgId: ORG }),
    );

    // SSE：status + done 两事件（failed 语义）
    const events = publisher.publish.mock.calls.filter((c) => c[0] === TASK);
    expect(events).toHaveLength(2);
    expect(events[0]![1]).toMatchObject({ type: 'status', payload: { status: 'failed' } });
    expect(events[1]![1]).toMatchObject({ type: 'done', payload: { status: 'failed' } });

    // 未到期控制组保持 pending
    const [future] = await db
      .select({ status: schema.approvalRequest.status })
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, APPROVAL_FUTURE));
    expect(future?.status).toBe('pending');
  });

  it('员工仍占用其它任务 → 级联失败但不回 idle（M3-06 终态回写前置校验）', async () => {
    const [emp] = await db
      .select({ status: schema.aiEmployee.status })
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, EMP_BUSY));
    expect(emp?.status).toBe('working');
    const [task] = await db
      .select({ status: schema.aiTask.status })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK_BUSY));
    expect(task?.status).toBe('failed');
    const [ft] = await db
      .select({ status: schema.followUpTask.status })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT2));
    expect(ft?.status).toBe('paused');
  });

  it('防重：已有 expired 留痕 → 本轮跳过，不再重复留痕/发通知', async () => {
    enqueuer.enqueueNotify.mockClear();
    publisher.publish.mockClear();
    const handled = await scanner.tick();
    expect(handled).toBe(0);
    const logs = await db
      .select({ id: schema.approvalLog.id })
      .from(schema.approvalLog)
      .where(eq(schema.approvalLog.approvalId, APPROVAL));
    expect(logs).toHaveLength(1);
    expect(enqueuer.enqueueNotify).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
