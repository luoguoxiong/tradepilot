/**
 * q:notify 载荷与分发契约（M5-A2 通知服务，后端技术方案 06 §1/§2.3）。
 *
 * 生产端（runtime / worker 扫描器）统一投递 NotifyJob 形状；消费端（NotifyProcessor）
 * 按 notification_setting 的事件 × 渠道开关矩阵分发：
 * - site 渠道：站内通知表落库（M5-A2 增补 notification 表；审批待审数另经
 *   GET /approvals/summary 15s 轮询，12 §7 / ER 08 §4 口径）；
 * - email 渠道：复用 org 任一 connected mailbox 外发（06 §2.3 系统通知邮件）；
 *   无可用邮箱 → 仅站内留痕。
 */
import { z } from 'zod';

/** notification_setting.events 矩阵键（与 db schema NotificationEventKey 同域；独立声明避免 db→shared 反向依赖） */
export const NOTIFY_EVENT_KEY = {
  APPROVAL_PENDING: 'approval_pending',
  RISK_ALERT: 'risk_alert',
  TASK_FAILED: 'task_failed',
} as const;

export type NotifyEventKey = (typeof NOTIFY_EVENT_KEY)[keyof typeof NOTIFY_EVENT_KEY];

/** 事件 × 渠道开关（16 §1.8 FR-09） */
export type NotifyEventSwitch = { site: boolean; email: boolean };

/** 缺省开关矩阵（16 设置未配置时的兜底口径，与 settings ensureNotificationRow 同源） */
export const DEFAULT_NOTIFICATION_EVENTS: Record<NotifyEventKey, NotifyEventSwitch> = {
  [NOTIFY_EVENT_KEY.APPROVAL_PENDING]: { site: true, email: true },
  [NOTIFY_EVENT_KEY.RISK_ALERT]: { site: true, email: true },
  [NOTIFY_EVENT_KEY.TASK_FAILED]: { site: true, email: false },
};

/** q:notify job 载荷（消费端安全解析：畸形载荷留痕跳过，不抛错重投） */
export const notifyJobSchema = z.object({
  /** 原始事件类型（approval_pending / approval_expired / task_failed / budget_limit …） */
  type: z.string().min(1),
  orgId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().optional(),
  /** 业务引用（approval / task …），站内通知跳转语义 */
  refType: z.string().optional(),
  refId: z.string().optional(),
});

export type NotifyJob = z.infer<typeof notifyJobSchema>;

/**
 * 原始事件类型 → 设置矩阵事件键：
 * - approval_pending / approval_expired（超时提醒，12 §7「超时邮件提醒经理一次」）→ approval_pending
 * - task_failed → task_failed
 * - budget_limit / mailbox_error 等系统风险 → risk_alert（缺省）
 */
export function notifyEventKey(type: string): NotifyEventKey {
  switch (type) {
    case 'approval_pending':
    case 'approval_expired':
      return NOTIFY_EVENT_KEY.APPROVAL_PENDING;
    case 'task_failed':
      return NOTIFY_EVENT_KEY.TASK_FAILED;
    default:
      return NOTIFY_EVENT_KEY.RISK_ALERT;
  }
}
