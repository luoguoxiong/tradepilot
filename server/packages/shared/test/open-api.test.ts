import { describe, expect, it } from 'vitest';
import {
  API_KEY_RATE_LIMIT_PER_MINUTE,
  API_SCOPE_LIST,
  WEBHOOK_EVENT,
  WEBHOOK_EVENT_LIST,
  WEBHOOK_MAX_ATTEMPTS,
  webhookJobSchema,
  webhookMatchesEvent,
  webhookPayloadSchema,
} from '../src/contracts/open-api.js';

/**
 * 开放 API / 出站 Webhook 契约单测（P1-X-21/22，16 FR-11 / 后端技术方案 06 §5）：
 * 注册表白名单、事件命中口径、q:webhook 载荷校验、常量口径。
 */
describe('开放 API / Webhook 契约（16 FR-11 · 06 §5）', () => {
  it('scope 注册表形如 {资源}:{动作} 且无重复（DTO 白名单来源）', () => {
    expect(API_SCOPE_LIST.length).toBeGreaterThan(0);
    for (const scope of API_SCOPE_LIST) {
      expect(scope).toMatch(/^[a-z_]+:(read|write)$/);
    }
    expect(new Set(API_SCOPE_LIST).size).toBe(API_SCOPE_LIST.length);
  });

  it('事件注册表无重复，且含 16 FR-09 三项 + 06 §5.2 业务事件', () => {
    expect(new Set(WEBHOOK_EVENT_LIST).size).toBe(WEBHOOK_EVENT_LIST.length);
    for (const required of [
      WEBHOOK_EVENT.APPROVAL_PENDING,
      WEBHOOK_EVENT.RISK_ALERT,
      WEBHOOK_EVENT.TASK_FAILED,
      WEBHOOK_EVENT.TASK_COMPLETED,
      WEBHOOK_EVENT.APPROVAL_DECIDED,
      WEBHOOK_EVENT.MESSAGE_RECEIVED,
      WEBHOOK_EVENT.CUSTOMER_CREATED,
    ]) {
      expect(WEBHOOK_EVENT_LIST).toContain(required);
    }
  });

  it('webhookMatchesEvent：命中原始事件类型或归并事件键', () => {
    // approval_expired 归并为 approval_pending → 订阅任一写法都投递
    expect(webhookMatchesEvent(['approval_pending'], 'approval_expired', 'approval_pending')).toBe(
      true,
    );
    expect(webhookMatchesEvent(['approval_expired'], 'approval_expired', 'approval_pending')).toBe(
      true,
    );
    // 未订阅的事件不投递
    expect(webhookMatchesEvent(['task_failed'], 'approval_expired', 'approval_pending')).toBe(
      false,
    );
    expect(webhookMatchesEvent([], 'task_failed', 'task_failed')).toBe(false);
  });

  it('webhookPayloadSchema：事件快照字段齐备（occurredAt 必填）', () => {
    const parsed = webhookPayloadSchema.safeParse({
      event: 'task_failed',
      type: 'task_failed',
      orgId: 'org_1',
      title: '任务失败',
      occurredAt: '2026-09-13T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    expect(
      webhookPayloadSchema.safeParse({ event: 'task_failed', type: 'task_failed', orgId: 'org_1' })
        .success,
    ).toBe(false);
  });

  it('webhookJobSchema：合法 q:webhook 载荷通过；缺 url / 空 webhookId 拒绝', () => {
    const job = {
      webhookId: 'hook_1',
      orgId: 'org_1',
      url: 'https://example.com/hook',
      payload: {
        event: 'task_failed',
        type: 'task_failed',
        orgId: 'org_1',
        title: '任务失败',
        occurredAt: '2026-09-13T00:00:00.000Z',
      },
    };
    expect(webhookJobSchema.safeParse(job).success).toBe(true);
    expect(webhookJobSchema.safeParse({ ...job, url: '' }).success).toBe(false);
    expect(webhookJobSchema.safeParse({ ...job, webhookId: '' }).success).toBe(false);
    expect(webhookJobSchema.safeParse({ webhookId: 'hook_1' }).success).toBe(false);
  });

  it('常量口径：每 Key 60 req/min；投递最多 5 次（06 §5.1 / §5.2）', () => {
    expect(API_KEY_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
  });
});
