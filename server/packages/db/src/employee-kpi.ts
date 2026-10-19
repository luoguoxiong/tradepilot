import { sql } from 'drizzle-orm';
import { ROLE_SCOPED_KPI_METRICS, type KpiMetric } from '@tradepilot/core';
import type { Tx } from './tenant.js';

/**
 * 02 §3.2「KPI 口径定义」P1 精化 · 数据访问层。
 *
 * P0 的 `achieved` 取「当日 `ai_task` 产出计数」（任务量与业务量不等价，
 * 例如一次批量分析任务覆盖 20 个客户却只计 1）；P1 改为**业务表实时聚合**：
 *
 * | role | metric | 聚合来源（本文件内 SQL） |
 * |---|---|---|
 * | lead_hunter | daily_leads | `ai_lead`（今日新增，经 `task_id → ai_task.employee_id` 归因） |
 * | customer_researcher | daily_profiles | `ai_lead.analyzed_at`（今日完成分析/画像，同上归因） |
 * | sales | daily_replies | `message` out/ai/sent（经 `customer_activity.operator_id` 归因，与 15 §7 ETL 同源） |
 * | follow_up | daily_followups | `follow_up_execution` status=sent（按职能统计，见 core 常量注释） |
 * | merchandiser | active_orders | `sales_order` status<>completed（在跟订单数，存量指标） |
 * | manager | daily_reports | `business_report`（今日生成，经 `task_id → ai_task.employee_id` 归因） |
 *
 * 放在 db 包的原因与 `manager-insights.ts` 一致：02 员工卡片与 13 团队效率
 * 必须复用同一份聚合，否则两页数字会漂移（02 §3.2 / 13 §1.3）。
 */

/** 统计区间：[start, end)；时区由调用方按「企业本地日」换算后传入 */
export interface KpiRange {
  start: Date;
  end: Date;
}

export interface EmployeeKpiCounts {
  /** 可归因到具体 AI 员工的指标：metric → (employeeId → 值)；未产出的 metric 也会存在（空 Map） */
  byEmployee: Map<KpiMetric, Map<string, number>>;
  /** 只能按职能统计的指标（`ROLE_SCOPED_KPI_METRICS`）：metric → 值 */
  byRole: Map<KpiMetric, number>;
}

/** 可归因到具体 AI 员工的指标（其余见 `ROLE_SCOPED_KPI_METRICS`） */
const EMPLOYEE_SCOPED_METRICS: readonly KpiMetric[] = [
  'daily_leads',
  'daily_profiles',
  'daily_replies',
  'daily_reports',
];

interface RowsResult {
  rows: Record<string, unknown>[];
}

function readRows(result: unknown): Record<string, unknown>[] {
  return (result as RowsResult).rows ?? [];
}

function emptyCounts(): EmployeeKpiCounts {
  return {
    byEmployee: new Map(
      EMPLOYEE_SCOPED_METRICS.map((metric) => [metric, new Map<string, number>()]),
    ),
    byRole: new Map(ROLE_SCOPED_KPI_METRICS.map((metric) => [metric, 0])),
  };
}

/** 逐员工计数结果 → Map（employee_id 必非空，SQL 已过滤） */
function toByEmployee(result: unknown): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of readRows(result)) {
    const employeeId = row['employee_id'] ? String(row['employee_id']) : '';
    if (employeeId) {
      map.set(employeeId, Number(row['n'] ?? 0));
    }
  }
  return map;
}

function toScalar(result: unknown): number {
  const [row] = readRows(result);
  return row ? Number(row['n'] ?? 0) : 0;
}

/**
 * 聚合 6 类指标（一次并行查询）。
 * 调用方以「员工角色 → metric」取值；归因失败的员工回落到 0（而非 AI 指标兜底，避免虚高）。
 */
export async function fetchEmployeeKpiCounts(
  tx: Tx,
  orgId: string,
  range: KpiRange,
): Promise<EmployeeKpiCounts> {
  const counts = emptyCounts();

  const [leads, profiles, replies, followUps, orders, reports] = await Promise.all([
    // lead_hunter：今日新增线索（获客产出的业务量）
    tx.execute(sql`
      SELECT t.employee_id AS employee_id, count(*)::int AS n
      FROM ai_lead l
      JOIN ai_task t ON t.id = l.task_id
      WHERE l.org_id = ${orgId}
        AND l.created_at >= ${range.start} AND l.created_at < ${range.end}
        AND t.employee_id IS NOT NULL
      GROUP BY t.employee_id
    `),
    // customer_researcher：今日完成分析/画像的线索
    tx.execute(sql`
      SELECT t.employee_id AS employee_id, count(*)::int AS n
      FROM ai_lead l
      JOIN ai_task t ON t.id = l.task_id
      WHERE l.org_id = ${orgId}
        AND l.analyzed_at IS NOT NULL
        AND l.analyzed_at >= ${range.start} AND l.analyzed_at < ${range.end}
        AND t.employee_id IS NOT NULL
      GROUP BY t.employee_id
    `),
    // sales：今日 AI 发出的回复（message 与 AI 员工的关联落在 customer_activity.operator_id，与 15 §7 ETL 同源）
    tx.execute(sql`
      SELECT ca.operator_id AS employee_id, count(*)::int AS n
      FROM message m
      JOIN customer_activity ca
        ON ca.operator_type = 'ai' AND ca.ref_type = 'message' AND ca.ref_id = m.id
      WHERE m.org_id = ${orgId}
        AND m.direction = 'out' AND m.sender_type = 'ai' AND m.status = 'sent'
        AND m.sent_at >= ${range.start} AND m.sent_at < ${range.end}
        AND ca.operator_id IS NOT NULL
      GROUP BY ca.operator_id
    `),
    // follow_up：今日自动跟进执行数（策略驱动、明细无员工外键 → 按职能统计）
    tx.execute(sql`
      SELECT count(*)::int AS n
      FROM follow_up_execution e
      WHERE e.org_id = ${orgId}
        AND e.status = 'sent'
        AND e.sent_at >= ${range.start} AND e.sent_at < ${range.end}
    `),
    // merchandiser：在跟订单数（存量：未完成的订单，与「今日」无关，10 §3）
    tx.execute(sql`
      SELECT count(*)::int AS n
      FROM sales_order o
      WHERE o.org_id = ${orgId} AND o.status <> 'completed'
    `),
    // manager：今日生成的经营报告
    tx.execute(sql`
      SELECT t.employee_id AS employee_id, count(*)::int AS n
      FROM business_report r
      JOIN ai_task t ON t.id = r.task_id
      WHERE r.org_id = ${orgId}
        AND r.created_at >= ${range.start} AND r.created_at < ${range.end}
        AND t.employee_id IS NOT NULL
      GROUP BY t.employee_id
    `),
  ]);

  counts.byEmployee.set('daily_leads', toByEmployee(leads));
  counts.byEmployee.set('daily_profiles', toByEmployee(profiles));
  counts.byEmployee.set('daily_replies', toByEmployee(replies));
  counts.byEmployee.set('daily_reports', toByEmployee(reports));
  counts.byRole.set('daily_followups', toScalar(followUps));
  counts.byRole.set('active_orders', toScalar(orders));
  return counts;
}

/** 单指标取值：可归因指标查员工维度，职能指标查 org 维度（见 `ROLE_SCOPED_KPI_METRICS`） */
export function kpiCountOf(
  counts: EmployeeKpiCounts,
  metric: KpiMetric,
  employeeId: string,
): number {
  const byEmployee = counts.byEmployee.get(metric);
  if (byEmployee) {
    return byEmployee.get(employeeId) ?? 0;
  }
  return counts.byRole.get(metric) ?? 0;
}
