/**
 * AnalyticsEtl 分析日汇总预聚合（P1-X-40~43，产品需求 15 §7 / ER 08 §2.5）：
 *
 * 每小时扫描全部 org，按 org 时区回算最近 N 个当地日，把业务表「区间计数」结果写入
 * `analytics_daily_summary`（`UNIQUE(org_id, stat_date, country, employee_id)` 幂等 upsert）——
 * 为「数据中心」（15 §3）看板卡片 / 趋势 / 员工筛选加速，避免每次请求全表聚合。
 *
 * 物化粒度（MVP）：
 *   - `(country='ALL', employee_id='ALL')`：org 当日全量指标（看板卡片 / 趋势，15 §3.1/§3.2）；
 *   - `(country='ALL', employee_id=<emp>)`：可归因到 AI 员工的 AI 贡献四项动作
 *     （found_customers / replied_emails / promoted_inquiries / saved_hours，15 §3.3 员工筛选）。
 *
 * country 维度不做日增量物化：15 §3.2「市场分布」是客户「存量」国家分布（非当日新增），
 * 由数据中心接口按业务表实时聚合；本表统一以 'ALL' 落 country，唯一键保留该维度以备扩展。
 *
 * 口径唯一实现点：计数 / 估算 / 归因口径全部取自 `@tradepilot/core`（analytics.ts），
 * 与数据中心接口（S4）共用，保证「统计口径可下钻复算」（15 §4）。本文件只负责区间 SQL 与落库。
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  PROMOTED_INQUIRY_WINDOW_DAYS,
  STAT_DIMENSION_ALL,
  computeSavedHours,
  createId,
  zonedDayRangeUtc,
} from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';

/** 扫描周期（04 §3.1 扫描循环基座）：每小时。当日数据持续增长，小时级重算即近实时。 */
export const ANALYTICS_ETL_INTERVAL_MS = 60 * 60_000;

/** 回算天数：覆盖昨日与今日（迟到数据 + 归因窗口内的重算） */
export const ANALYTICS_ETL_LOOKBACK_DAYS = 2;

const ALL = STAT_DIMENSION_ALL;

export interface AnalyticsEtlDeps {
  db: Db;
  logger: Logger;
  /** 回算天数覆盖（默认 ANALYTICS_ETL_LOOKBACK_DAYS），测试可注入 */
  lookbackDays?: number;
}

/** 单条汇总行（落库前去重，保证同批 insert 不出现重复冲突键） */
interface SummaryRow {
  country: string;
  employeeId: string;
  newCustomers: number;
  newInquiries: number;
  newQuotes: number;
  foundCustomers: number;
  repliedEmails: number;
  promotedInquiries: number;
  savedHours: string;
}

interface OrgBaseCounts {
  newCustomers: number;
  newInquiries: number;
  newQuotes: number;
  foundCustomers: number;
  repliedEmails: number;
  followUpActions: number;
}

export class AnalyticsEtl {
  constructor(private readonly deps: AnalyticsEtlDeps) {}

  /** 单轮 ETL：返回 upsert 的汇总行数（测试可直接调用） */
  async tick(now = new Date()): Promise<number> {
    const { db, logger } = this.deps;
    // 跨租户扫描（sched 角色白名单口径，02 §4.3）
    const orgs = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx.select({ id: schema.org.id, timezone: schema.org.timezone }).from(schema.org);
    });

    const lookback = this.deps.lookbackDays ?? ANALYTICS_ETL_LOOKBACK_DAYS;
    let written = 0;
    for (const orgRow of orgs) {
      const tz = orgRow.timezone || 'Asia/Shanghai';
      // daysAgo=1 起：上一当地日（已完成）与今日（近实时）
      for (let daysAgo = 1; daysAgo <= lookback; daysAgo += 1) {
        try {
          written += await this.aggregateOrg(orgRow.id, tz, now, daysAgo);
        } catch (err) {
          logger.warn(
            {
              orgId: orgRow.id,
              timezone: tz,
              daysAgo,
              err: err instanceof Error ? err.message : String(err),
            },
            '分析预聚合失败，下轮重试',
          );
        }
      }
    }
    return written;
  }

  /** 按 org × 当地日聚合 → upsert；返回落库行数 */
  private async aggregateOrg(
    orgId: string,
    tz: string,
    now: Date,
    daysAgo: number,
  ): Promise<number> {
    const { statDate, start, end } = zonedDayRangeUtc(now, tz, daysAgo);
    return withOrg(this.deps.db, orgId, async (tx) => {
      const base = await this.orgBaseCounts(tx, start, end);
      const promoted = await this.scalar(tx, this.promotedInquiriesSql(start, end));

      // 去重键：country|employeeId（同批 insert 内不得重复，否则 PG 报 ON CONFLICT 二次影响）
      const rows = new Map<string, SummaryRow>();
      const total: SummaryRow = {
        country: ALL,
        employeeId: ALL,
        newCustomers: base.newCustomers,
        newInquiries: base.newInquiries,
        newQuotes: base.newQuotes,
        foundCustomers: base.foundCustomers,
        repliedEmails: base.repliedEmails,
        promotedInquiries: promoted,
        savedHours: computeSavedHours({
          foundCustomers: base.foundCustomers,
          repliedEmails: base.repliedEmails,
          followUpActions: base.followUpActions,
        }).toFixed(1),
      };
      rows.set(`${ALL}|${ALL}`, total);

      // 逐 AI 员工：可归因的 AI 贡献（15 §3.3 员工筛选）
      const foundByEmp = await this.groupByEmployee(
        tx,
        this.foundCustomersByEmployeeSql(start, end),
      );
      const repliedByEmp = await this.groupByEmployee(
        tx,
        this.repliedEmailsByEmployeeSql(start, end),
      );
      const promotedByEmp = await this.groupByEmployee(
        tx,
        this.promotedInquiriesByEmployeeSql(start, end),
      );
      const employees = new Set<string>([
        ...foundByEmp.keys(),
        ...repliedByEmp.keys(),
        ...promotedByEmp.keys(),
      ]);
      for (const employeeId of employees) {
        const foundCustomers = foundByEmp.get(employeeId) ?? 0;
        const repliedEmails = repliedByEmp.get(employeeId) ?? 0;
        const promotedInquiries = promotedByEmp.get(employeeId) ?? 0;
        rows.set(`${ALL}|${employeeId}`, {
          country: ALL,
          employeeId,
          newCustomers: 0,
          newInquiries: 0,
          newQuotes: 0,
          foundCustomers,
          repliedEmails,
          promotedInquiries,
          // 跟进动作（follow_up_execution）无员工归属列，故员工级 savedHours 不含跟进项
          savedHours: computeSavedHours({
            foundCustomers,
            repliedEmails,
            followUpActions: 0,
          }).toFixed(1),
        });
      }

      const values = [...rows.values()].map((row) => ({
        id: createId('asum'),
        orgId,
        statDate,
        country: row.country,
        employeeId: row.employeeId,
        newCustomers: row.newCustomers,
        newInquiries: row.newInquiries,
        newQuotes: row.newQuotes,
        foundCustomers: row.foundCustomers,
        repliedEmails: row.repliedEmails,
        promotedInquiries: row.promotedInquiries,
        savedHours: row.savedHours,
      }));

      await tx
        .insert(schema.analyticsDailySummary)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.analyticsDailySummary.orgId,
            schema.analyticsDailySummary.statDate,
            schema.analyticsDailySummary.country,
            schema.analyticsDailySummary.employeeId,
          ],
          set: {
            newCustomers: sql`excluded.new_customers`,
            newInquiries: sql`excluded.new_inquiries`,
            newQuotes: sql`excluded.new_quotes`,
            foundCustomers: sql`excluded.found_customers`,
            repliedEmails: sql`excluded.replied_emails`,
            promotedInquiries: sql`excluded.promoted_inquiries`,
            savedHours: sql`excluded.saved_hours`,
            updatedAt: sql`now()`,
          },
        });

      return values.length;
    });
  }

  // ===== 区间计数口径（15 §7「基础指标按业务表区间计数」）=====

  /** org 当日基础指标 + AI 动作计数（口径见 15 §7；与 dashboard KPI 对齐） */
  private async orgBaseCounts(tx: Tx, start: Date, end: Date): Promise<OrgBaseCounts> {
    const result = await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM customer c
           WHERE c.deleted_at IS NULL AND c.created_at >= ${start} AND c.created_at < ${end}) AS new_customers,
        (SELECT count(*)::int FROM conversation v
           JOIN customer vc ON vc.id = v.customer_id
           WHERE vc.deleted_at IS NULL
             AND v.created_at >= ${start} AND v.created_at < ${end}) AS new_inquiries,
        (SELECT count(*)::int FROM quotation q
           WHERE q.created_at >= ${start} AND q.created_at < ${end}) AS new_quotes,
        (SELECT count(*)::int FROM customer c
           WHERE c.deleted_at IS NULL AND c.source_lead_id IS NOT NULL
             AND c.created_at >= ${start} AND c.created_at < ${end}) AS found_customers,
        (SELECT count(*)::int FROM message m
           WHERE m.direction = 'out' AND m.sender_type = 'ai' AND m.status = 'sent'
             AND m.sent_at IS NOT NULL AND m.sent_at >= ${start} AND m.sent_at < ${end}) AS replied_emails,
        (SELECT count(*)::int FROM follow_up_execution f
           WHERE f.status = 'sent' AND f.sent_at IS NOT NULL
             AND f.sent_at >= ${start} AND f.sent_at < ${end}) AS follow_up_actions
    `);
    const row = rowsOf(result)[0] ?? {};
    return {
      newCustomers: Number(row['new_customers'] ?? 0),
      newInquiries: Number(row['new_inquiries'] ?? 0),
      newQuotes: Number(row['new_quotes'] ?? 0),
      foundCustomers: Number(row['found_customers'] ?? 0),
      repliedEmails: Number(row['replied_emails'] ?? 0),
      followUpActions: Number(row['follow_up_actions'] ?? 0),
    };
  }

  /** 促成询盘（org 级）：当日「会话首条来信」中，14 天窗口内存在 AI 外联触点的条数（15 §7） */
  private promotedInquiriesSql(start: Date, end: Date): SQL {
    return sql`
      WITH first_inquiry AS (
        SELECT m.conversation_id, min(m.created_at) AS inquiry_at
        FROM message m
        WHERE m.direction = 'in'
        GROUP BY m.conversation_id
      )
      SELECT count(*)::int AS n
      FROM first_inquiry fi
      WHERE fi.inquiry_at >= ${start} AND fi.inquiry_at < ${end}
        AND EXISTS (
          SELECT 1 FROM message o
          WHERE o.conversation_id = fi.conversation_id
            AND o.direction = 'out' AND o.sender_type = 'ai' AND o.status = 'sent'
            AND o.sent_at IS NOT NULL
            AND o.sent_at <= fi.inquiry_at
            AND o.sent_at >= fi.inquiry_at - make_interval(days => ${PROMOTED_INQUIRY_WINDOW_DAYS})
        )
    `;
  }

  /** 获客转化按 AI 员工：customer.source_lead_id → ai_lead.task_id → ai_task.employee_id */
  private foundCustomersByEmployeeSql(start: Date, end: Date): SQL {
    return sql`
      SELECT t.employee_id AS employee_id, count(*)::int AS n
      FROM customer c
      JOIN ai_lead l ON l.id = c.source_lead_id
      JOIN ai_task t ON t.id = l.task_id
      WHERE c.deleted_at IS NULL AND c.source_lead_id IS NOT NULL
        AND c.created_at >= ${start} AND c.created_at < ${end}
        AND t.employee_id IS NOT NULL
      GROUP BY t.employee_id
    `;
  }

  /** AI 外联邮件按 AI 员工：message 经 customer_activity(ref_type='message') 反查 operator_id */
  private repliedEmailsByEmployeeSql(start: Date, end: Date): SQL {
    return sql`
      SELECT ca.operator_id AS employee_id, count(*)::int AS n
      FROM message m
      JOIN customer_activity ca
        ON ca.operator_type = 'ai' AND ca.ref_type = 'message' AND ca.ref_id = m.id
      WHERE m.direction = 'out' AND m.sender_type = 'ai' AND m.status = 'sent'
        AND m.sent_at IS NOT NULL AND m.sent_at >= ${start} AND m.sent_at < ${end}
        AND ca.operator_id IS NOT NULL
      GROUP BY ca.operator_id
    `;
  }

  /** 促成询盘按 AI 员工：最后触点（窗口内 sent_at 最大）外联邮件 → operator_id（15 §7 最后触点归因） */
  private promotedInquiriesByEmployeeSql(start: Date, end: Date): SQL {
    return sql`
      WITH first_inquiry AS (
        SELECT m.conversation_id, min(m.created_at) AS inquiry_at
        FROM message m
        WHERE m.direction = 'in'
        GROUP BY m.conversation_id
      ),
      last_touch AS (
        SELECT fi.conversation_id,
          (SELECT o.id FROM message o
             WHERE o.conversation_id = fi.conversation_id
               AND o.direction = 'out' AND o.sender_type = 'ai' AND o.status = 'sent'
               AND o.sent_at IS NOT NULL
               AND o.sent_at <= fi.inquiry_at
               AND o.sent_at >= fi.inquiry_at - make_interval(days => ${PROMOTED_INQUIRY_WINDOW_DAYS})
             ORDER BY o.sent_at DESC
             LIMIT 1) AS message_id
        FROM first_inquiry fi
        WHERE fi.inquiry_at >= ${start} AND fi.inquiry_at < ${end}
      )
      SELECT ca.operator_id AS employee_id, count(*)::int AS n
      FROM last_touch lt
      JOIN customer_activity ca
        ON ca.operator_type = 'ai' AND ca.ref_type = 'message' AND ca.ref_id = lt.message_id
      WHERE lt.message_id IS NOT NULL AND ca.operator_id IS NOT NULL
      GROUP BY ca.operator_id
    `;
  }

  // ===== 执行工具 =====

  private async scalar(tx: Tx, query: SQL): Promise<number> {
    const result = await tx.execute(query);
    return Number(rowsOf(result)[0]?.['n'] ?? 0);
  }

  private async groupByEmployee(tx: Tx, query: SQL): Promise<Map<string, number>> {
    const result = await tx.execute(query);
    const map = new Map<string, number>();
    for (const row of rowsOf(result)) {
      const key = row['employee_id'];
      if (typeof key === 'string' && key.length > 0) {
        map.set(key, Number(row['n'] ?? 0));
      }
    }
    return map;
  }
}

/** drizzle node-postgres `execute` 返回 pg `QueryResult`，此处统一取行数组 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return (result as { rows?: Record<string, unknown>[] }).rows ?? [];
}
