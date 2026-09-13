import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import {
  ANALYTICS_CALIBER_NOTE,
  ANALYTICS_METRIC,
  BizException,
  ErrorCode,
  PROMOTED_INQUIRY_WINDOW_DAYS,
  SAVED_HOURS_BASELINE_MINUTES,
  STAT_DIMENSION_ALL,
  computeSavedHours,
  getZonedWallTime,
  zonedWallTimeToUtc,
  type Scope,
} from '@tradepilot/core';
import { schema, withOrg, type Db, type OrgScopeContext, type Tx } from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import type {
  AiContributionResp,
  AnalyticsExportResult,
  AnalyticsFilterDto,
  CustomerTrendResp,
  DrilldownItemDto,
  DrilldownQueryDto,
  DrilldownResp,
  MarketDistributionResp,
  MarketRowDto,
  TrendPointDto,
} from './analytics.dto.js';
import { buildXlsx, type XlsxCell, type XlsxSheet } from './xlsx.js';

/**
 * 15 数据中心服务（P1-15-01~06）。
 *
 * 数据来源与口径：
 * - 所有指标按**业务表实时聚合**（与下钻明细同源），保证 15 §4「数字必须可下钻验证」——预聚合表
 *   `analytics_daily_summary`（P1-X-40）是按物化时点的快照，与实时明细存在漂移风险，故仅作对账基座。
 * - 计数 / 估算 / 归因口径全部取自 `@tradepilot/core`（`computeSavedHours` /
 *   `SAVED_HOURS_BASELINE_MINUTES` / `PROMOTED_INQUIRY_WINDOW_DAYS` / `ANALYTICS_CALIBER_NOTE`），
 *   不出现第二份实现；SQL 表达式与 worker `analytics-etl` 保持一致。
 * - 数据权限（00 §4.4）：self → 追加 owner 归属条件；team/all → MVP 下 team == org（RLS 已限定
 *   org），不追加条件（团队分组 P1 后续）。
 */

/** 自定义区间上限（避免超大区间拖垮聚合） */
const MAX_RANGE_DAYS = 366;

/** 市场分布 Top N（其余并入 OTHER，与 15 §1.3 示例一致） */
const MARKET_TOP_N = 3;

const ALL = STAT_DIMENSION_ALL;

interface ResolvedRange {
  startDate: string;
  endDate: string;
  /** UTC 下界（含） */
  start: Date;
  /** UTC 上界（不含） */
  end: Date;
  /** 当地日键（升序，YYYY-MM-DD） */
  days: string[];
}

/** 已解析的筛选条件（owner/country/employee 的可复用条件片段） */
interface MetricFilters {
  scope: Scope;
  /** scope=self 时限定 owner 列 */
  owner(column: SQL): SQL;
  /** country=all 时为空 */
  countryCond(column: SQL): SQL;
  /** 该 AI 员工带来的客户（按 source_lead → task.employee_id 归因） */
  employeeByAcquisition(): SQL;
  /** 该 AI 员工亲自执行的 AI 外联（customer_activity.operator_id） */
  employeeId: string | null;
}

// ===== 当地日工具（org 时区） =====

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function toDateKey(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function parseDateKey(key: string): LocalDate {
  const [year, month, day] = key.split('-').map((v) => Number.parseInt(v, 10));
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

function isRealDate(d: LocalDate): boolean {
  const dt = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return (
    dt.getUTCFullYear() === d.year && dt.getUTCMonth() === d.month - 1 && dt.getUTCDate() === d.day
  );
}

/** 周一=0 … 周日=6 */
function localWeekday(d: LocalDate): number {
  return (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;
}

function shiftDateKey(key: string, deltaDays: number): string {
  const d = parseDateKey(key);
  const dt = new Date(Date.UTC(d.year, d.month - 1, d.day + deltaDays));
  return toDateKey({
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  });
}

function enumerateDateKeys(startKey: string, endKey: string, maxDays: number): string[] {
  const keys: string[] = [];
  let cursor = startKey;
  while (cursor <= endKey) {
    keys.push(cursor);
    if (keys.length > maxDays) {
      throw new BizException(ErrorCode.BAD_REQUEST, `查询区间过大（上限 ${maxDays} 天）`);
    }
    cursor = shiftDateKey(cursor, 1);
  }
  return keys;
}

function localDayStartUtc(key: string, timeZone: string): Date {
  const d = parseDateKey(key);
  return zonedWallTimeToUtc(
    { year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
}

function pctOf(count: number, total: number): number {
  return total <= 0 ? 0 : Math.round((count / total) * 100);
}

/** drizzle node-postgres `execute` 返回 pg QueryResult，此处统一取行数组 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return (result as { rows?: Record<string, unknown>[] }).rows ?? [];
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toItem(row: Record<string, unknown>): DrilldownItemDto {
  const occurred = row['occurred_at'];
  return {
    id: asString(row['id']) ?? '',
    type: asString(row['type']) ?? '',
    title: asString(row['title']) ?? '',
    subtitle: asString(row['subtitle']),
    country: asString(row['country']),
    ownerName: asString(row['owner_name']),
    amount: asString(row['amount']),
    currency: asString(row['currency']),
    occurredAt: occurred instanceof Date ? occurred.toISOString() : (asString(occurred) ?? ''),
  };
}

@Injectable()
export class AnalyticsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ===== §3.1 客户增长趋势 =====

  async customerTrend(ctx: OrgScopeContext, dto: AnalyticsFilterDto): Promise<CustomerTrendResp> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZone(tx, ctx.orgId);
      const range = this.resolveRange(dto, timeZone, new Date());
      const f = this.buildFilters(ctx, dto);

      const [customers, inquiries, quotes] = await Promise.all([
        this.countByDay(
          tx,
          sql`
            SELECT (c.created_at AT TIME ZONE ${timeZone})::date::text AS d, count(*)::int AS n
            FROM customer c
            WHERE c.deleted_at IS NULL
              AND c.created_at >= ${range.start} AND c.created_at < ${range.end}
              ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
            GROUP BY 1
          `,
        ),
        this.countByDay(
          tx,
          sql`
            SELECT (v.created_at AT TIME ZONE ${timeZone})::date::text AS d, count(*)::int AS n
            FROM conversation v
            JOIN customer c ON c.id = v.customer_id
            WHERE c.deleted_at IS NULL
              AND v.created_at >= ${range.start} AND v.created_at < ${range.end}
              ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
            GROUP BY 1
          `,
        ),
        this.countByDay(
          tx,
          sql`
            SELECT (q.created_at AT TIME ZONE ${timeZone})::date::text AS d, count(*)::int AS n
            FROM quotation q
            JOIN customer c ON c.id = q.customer_id
            WHERE c.deleted_at IS NULL
              AND q.created_at >= ${range.start} AND q.created_at < ${range.end}
              ${f.owner(sql`q.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
            GROUP BY 1
          `,
        ),
      ]);

      const trend: TrendPointDto[] = range.days.map((date) => ({
        date,
        newCustomers: customers.get(date) ?? 0,
        newInquiries: inquiries.get(date) ?? 0,
        newQuotes: quotes.get(date) ?? 0,
      }));
      return { trend };
    });
  }

  // ===== §3.2 市场分布 =====

  /**
   * 市场分布即「国家维度拆分」，故不再叠加 `country` facet（否则退化为单行 100%），
   * 其余全局筛选（period / employee / scope）均生效。
   */
  async marketDistribution(
    ctx: OrgScopeContext,
    dto: AnalyticsFilterDto,
  ): Promise<MarketDistributionResp> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZone(tx, ctx.orgId);
      const range = this.resolveRange(dto, timeZone, new Date());
      const f = this.buildFilters(ctx, dto);

      const rows = await this.rows(
        tx,
        sql`
          SELECT c.country AS country, count(*)::int AS n
          FROM customer c
          WHERE c.deleted_at IS NULL
            AND c.created_at >= ${range.start} AND c.created_at < ${range.end}
            ${f.owner(sql`c.owner_id`)} ${f.employeeByAcquisition()}
          GROUP BY 1
          ORDER BY n DESC, country ASC
        `,
      );

      const counts = rows.map((row) => ({
        country: asString(row['country']) ?? 'UNKNOWN',
        n: Number(row['n'] ?? 0),
      }));
      const total = counts.reduce((sum, row) => sum + row.n, 0);
      const top = counts.slice(0, MARKET_TOP_N);
      const rest = counts.slice(MARKET_TOP_N).reduce((sum, row) => sum + row.n, 0);

      const markets: MarketRowDto[] = top.map((row) => ({
        country: row.country,
        customerCount: row.n,
        pct: pctOf(row.n, total),
      }));
      if (rest > 0) {
        markets.push({ country: 'OTHER', customerCount: rest, pct: pctOf(rest, total) });
      }
      return { markets };
    });
  }

  // ===== §3.3 AI 贡献 =====

  async aiContribution(ctx: OrgScopeContext, dto: AnalyticsFilterDto): Promise<AiContributionResp> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZone(tx, ctx.orgId);
      const range = this.resolveRange(dto, timeZone, new Date());
      const f = this.buildFilters(ctx, dto);

      const foundCustomers = await this.scalarCount(
        tx,
        sql`
          SELECT count(*)::int AS n
          FROM customer c
          WHERE c.deleted_at IS NULL AND c.source_lead_id IS NOT NULL
            AND c.created_at >= ${range.start} AND c.created_at < ${range.end}
            ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
        `,
      );
      const repliedEmails = await this.scalarCount(
        tx,
        sql`
          SELECT count(*)::int AS n
          ${this.outreachFrom()}
          WHERE m.direction = 'out' AND m.sender_type = 'ai' AND m.status = 'sent'
            AND m.sent_at IS NOT NULL
            AND m.sent_at >= ${range.start} AND m.sent_at < ${range.end}
            AND c.deleted_at IS NULL
            ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)}
            ${f.employeeId === null ? sql`` : sql`AND ca.operator_id = ${f.employeeId}`}
        `,
      );
      const followUpActions = await this.scalarCount(
        tx,
        sql`
          SELECT count(*)::int AS n
          FROM follow_up_execution e
          JOIN follow_up_task t ON t.id = e.follow_up_task_id
          JOIN customer c ON c.id = t.customer_id
          WHERE e.status = 'sent' AND e.sent_at IS NOT NULL
            AND e.sent_at >= ${range.start} AND e.sent_at < ${range.end}
            AND c.deleted_at IS NULL
            ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
        `,
      );
      const promotedInquiries = await this.scalarCount(tx, this.promotedInquiriesCount(range, f));
      const savedHours = computeSavedHours({
        foundCustomers,
        repliedEmails,
        // 员工维度下跟进动作无 AI 归因（与 worker analytics-etl 一致）
        followUpActions: f.employeeId === null ? followUpActions : 0,
      });

      return {
        foundCustomers,
        repliedEmails,
        savedHours,
        promotedInquiries,
        caliberNote: ANALYTICS_CALIBER_NOTE,
      };
    });
  }

  // ===== §3.4 下钻明细 =====

  async drilldown(ctx: OrgScopeContext, dto: DrilldownQueryDto): Promise<DrilldownResp> {
    const limit = dto.pageSize;
    const offset = (dto.page - 1) * dto.pageSize;

    return withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZone(tx, ctx.orgId);
      const range = this.resolveRange(dto, timeZone, new Date());
      const f = this.buildFilters(ctx, dto);

      const { countSql, listSql } = this.buildDrilldownSql(dto.metric, range, f, limit, offset);
      const total = await this.scalarCount(tx, countSql);
      const rows = await this.rows(tx, listSql);
      return {
        metric: dto.metric,
        total,
        page: dto.page,
        pageSize: dto.pageSize,
        items: rows.map(toItem),
      };
    });
  }

  // ===== §3.5 Excel 导出 =====

  async exportExcel(ctx: OrgScopeContext, dto: AnalyticsFilterDto): Promise<AnalyticsExportResult> {
    const [trend, markets, contribution] = await Promise.all([
      this.customerTrend(ctx, dto),
      this.marketDistribution(ctx, dto),
      this.aiContribution(ctx, dto),
    ]);

    const sheets: XlsxSheet[] = [
      {
        name: '客户增长趋势',
        rows: [
          ['日期', '新客户', '新询盘', '新报价'],
          ...trend.trend.map((point): XlsxCell[] => [
            point.date,
            point.newCustomers,
            point.newInquiries,
            point.newQuotes,
          ]),
        ],
      },
      {
        name: '市场分布',
        rows: [
          ['国家/市场', '客户数', '占比(%)'],
          ...markets.markets.map((row): XlsxCell[] => [row.country, row.customerCount, row.pct]),
        ],
      },
      {
        name: 'AI 贡献',
        rows: [
          ['指标', '数值'],
          ['AI 找到客户', contribution.foundCustomers],
          ['AI 回复邮件', contribution.repliedEmails],
          ['AI 节省工时(小时)', contribution.savedHours],
          ['AI 促成询盘', contribution.promotedInquiries],
          ['口径说明', contribution.caliberNote],
        ],
      },
    ];

    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `data-center-${stamp}.xlsx`, buffer: buildXlsx(sheets) };
  }

  // ===== 内部：时区 / 区间 / 筛选 =====

  private async orgTimeZone(tx: Tx, orgId: string): Promise<string> {
    const [row] = await tx
      .select({ timezone: schema.org.timezone })
      .from(schema.org)
      .where(eq(schema.org.id, orgId))
      .limit(1);
    return row?.timezone ?? 'Asia/Shanghai';
  }

  private resolveRange(dto: AnalyticsFilterDto, timeZone: string, now: Date): ResolvedRange {
    const wall = getZonedWallTime(now, timeZone);
    const todayLocal: LocalDate = { year: wall.year, month: wall.month, day: wall.day };
    const today = toDateKey(todayLocal);

    let startKey: string;
    let endKey: string;
    if (dto.period === 'this_month') {
      startKey = toDateKey({ year: todayLocal.year, month: todayLocal.month, day: 1 });
      endKey = today;
    } else if (dto.period === 'custom') {
      startKey = dto.startDate ?? today;
      endKey = dto.endDate ?? today;
      for (const key of [startKey, endKey]) {
        if (!isRealDate(parseDateKey(key))) {
          throw new BizException(ErrorCode.BAD_REQUEST, `日期不存在: ${key}`);
        }
      }
      if (startKey > endKey) {
        throw new BizException(ErrorCode.BAD_REQUEST, 'endDate 不能早于 startDate');
      }
    } else {
      startKey = shiftDateKey(today, -localWeekday(todayLocal));
      endKey = today;
    }

    const days = enumerateDateKeys(startKey, endKey, MAX_RANGE_DAYS);
    const first = days[0] ?? today;
    const last = days[days.length - 1] ?? today;
    return {
      startDate: first,
      endDate: last,
      start: localDayStartUtc(first, timeZone),
      end: localDayStartUtc(shiftDateKey(last, 1), timeZone),
      days,
    };
  }

  private buildFilters(ctx: OrgScopeContext, dto: AnalyticsFilterDto): MetricFilters {
    const country = dto.country === ALL ? null : dto.country;
    const employeeId = dto.employeeId === ALL ? null : dto.employeeId;
    const selfScoped = ctx.scope === 'self';

    return {
      scope: ctx.scope,
      employeeId,
      owner: (column: SQL): SQL => (selfScoped ? sql`AND ${column} = ${ctx.userId}` : sql``),
      countryCond: (column: SQL): SQL =>
        country === null ? sql`` : sql`AND ${column} = ${country}`,
      employeeByAcquisition: (): SQL =>
        employeeId === null
          ? sql``
          : sql`AND EXISTS (
              SELECT 1 FROM ai_lead l
              JOIN ai_task t ON t.id = l.task_id
              WHERE l.id = c.source_lead_id AND t.employee_id = ${employeeId}
            )`,
    };
  }

  // ===== 内部：基础计数 =====

  private async rows(tx: Tx, query: SQL): Promise<Record<string, unknown>[]> {
    return rowsOf(await tx.execute(query));
  }

  private async countByDay(tx: Tx, query: SQL): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const row of await this.rows(tx, query)) {
      const day = asString(row['d']);
      if (day !== null) map.set(day.slice(0, 10), Number(row['n'] ?? 0));
    }
    return map;
  }

  private async scalarCount(tx: Tx, query: SQL): Promise<number> {
    const [row] = await this.rows(tx, query);
    return Number(row?.['n'] ?? 0);
  }

  /** AI 外联邮件（message + 会话 + 客户 + 归属 AI 员工）FROM 子句复用片段 */
  private outreachFrom(): SQL {
    return sql`
      FROM message m
      JOIN conversation v ON v.id = m.conversation_id
      JOIN customer c ON c.id = v.customer_id
      LEFT JOIN LATERAL (
        SELECT a.operator_id
        FROM customer_activity a
        WHERE a.operator_type = 'ai' AND a.ref_type = 'message' AND a.ref_id = m.id
        ORDER BY a.created_at ASC
        LIMIT 1
      ) ca ON true
    `;
  }

  // ===== 内部：下钻 SQL =====

  private buildDrilldownSql(
    metric: DrilldownQueryDto['metric'],
    range: ResolvedRange,
    f: MetricFilters,
    limit: number,
    offset: number,
  ): { countSql: SQL; listSql: SQL } {
    switch (metric) {
      case ANALYTICS_METRIC.NEW_CUSTOMERS:
        return this.customerItemSql(range, f, sql``, limit, offset);
      case ANALYTICS_METRIC.FOUND_CUSTOMERS:
        return this.customerItemSql(range, f, sql`AND c.source_lead_id IS NOT NULL`, limit, offset);
      case ANALYTICS_METRIC.INQUIRIES:
        return this.conversationItemSql(range, f, limit, offset);
      case ANALYTICS_METRIC.NEW_QUOTES:
        return this.quotationItemSql(range, f, false, limit, offset);
      case ANALYTICS_METRIC.DEALS_CLOSED:
        return this.quotationItemSql(range, f, true, limit, offset);
      case ANALYTICS_METRIC.REPLIED_EMAILS:
        return this.repliedEmailsItemSql(range, f, limit, offset);
      case ANALYTICS_METRIC.PROMOTED_INQUIRIES:
        return this.promotedItemSql(range, f, limit, offset);
      case ANALYTICS_METRIC.SAVED_HOURS:
        return this.savedHoursItemSql(range, f, limit, offset);
    }
  }

  private customerItemSql(
    range: ResolvedRange,
    f: MetricFilters,
    extraWhere: SQL,
    limit: number,
    offset: number,
  ): { countSql: SQL; listSql: SQL } {
    const base = sql`
      FROM customer c
      LEFT JOIN user_account u ON u.id = c.owner_id
      WHERE c.deleted_at IS NULL
        AND c.created_at >= ${range.start} AND c.created_at < ${range.end}
        ${extraWhere}
        ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
    `;
    return {
      countSql: sql`SELECT count(*)::int AS n ${base}`,
      listSql: sql`
        SELECT c.id AS id, 'customer' AS type, c.company_name AS title,
               c.industry AS subtitle, c.country AS country, u.name AS owner_name,
               NULL AS amount, NULL AS currency, c.created_at AS occurred_at
        ${base}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    };
  }

  private conversationItemSql(
    range: ResolvedRange,
    f: MetricFilters,
    limit: number,
    offset: number,
  ): { countSql: SQL; listSql: SQL } {
    const base = sql`
      FROM conversation v
      JOIN customer c ON c.id = v.customer_id
      LEFT JOIN user_account u ON u.id = c.owner_id
      WHERE c.deleted_at IS NULL
        AND v.created_at >= ${range.start} AND v.created_at < ${range.end}
        ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
    `;
    return {
      countSql: sql`SELECT count(*)::int AS n ${base}`,
      listSql: sql`
        SELECT v.id AS id, 'conversation' AS type,
               coalesce(v.subject, c.company_name) AS title,
               c.company_name AS subtitle, c.country AS country, u.name AS owner_name,
               NULL AS amount, NULL AS currency, v.created_at AS occurred_at
        ${base}
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    };
  }

  private quotationItemSql(
    range: ResolvedRange,
    f: MetricFilters,
    won: boolean,
    limit: number,
    offset: number,
  ): { countSql: SQL; listSql: SQL } {
    const timeValue = won ? sql`q.won_at` : sql`q.created_at`;
    const wonFilter = won
      ? sql`AND q.status = 'won' AND q.won_at IS NOT NULL AND q.won_at >= ${range.start} AND q.won_at < ${range.end}`
      : sql`AND q.created_at >= ${range.start} AND q.created_at < ${range.end}`;
    const base = sql`
      FROM quotation q
      JOIN customer c ON c.id = q.customer_id
      LEFT JOIN user_account u ON u.id = q.owner_id
      WHERE c.deleted_at IS NULL
        ${wonFilter}
        ${f.owner(sql`q.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
    `;
    return {
      countSql: sql`SELECT count(*)::int AS n ${base}`,
      listSql: sql`
        SELECT q.id AS id, 'quotation' AS type, q.quote_no AS title,
               c.company_name AS subtitle, c.country AS country, u.name AS owner_name,
               q.total_amount::text AS amount, q.currency AS currency, ${timeValue} AS occurred_at
        ${base}
        ORDER BY ${timeValue} DESC, q.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    };
  }

  private repliedEmailsItemSql(
    range: ResolvedRange,
    f: MetricFilters,
    limit: number,
    offset: number,
  ): { countSql: SQL; listSql: SQL } {
    const base = sql`
      ${this.outreachFrom()}
      LEFT JOIN ai_employee emp ON emp.id = ca.operator_id
      WHERE m.direction = 'out' AND m.sender_type = 'ai' AND m.status = 'sent'
        AND m.sent_at IS NOT NULL
        AND m.sent_at >= ${range.start} AND m.sent_at < ${range.end}
        AND c.deleted_at IS NULL
        ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)}
        ${f.employeeId === null ? sql`` : sql`AND ca.operator_id = ${f.employeeId}`}
    `;
    return {
      countSql: sql`SELECT count(*)::int AS n ${base}`,
      listSql: sql`
        SELECT m.id AS id, 'message' AS type,
               coalesce(v.subject, c.company_name) AS title,
               c.company_name AS subtitle, c.country AS country, emp.name AS owner_name,
               NULL AS amount, NULL AS currency, m.sent_at AS occurred_at
        ${base}
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    };
  }

  /** 促成询盘：AI 外联（窗口内最后触点）后客户首条来信 */
  private promotedInquiriesBase(range: ResolvedRange, f: MetricFilters): SQL {
    return sql`
      WITH first_inquiry AS (
        SELECT v.id AS conversation_id, min(m.created_at) AS inquiry_at
        FROM message m
        JOIN conversation v ON v.id = m.conversation_id
        JOIN customer c ON c.id = v.customer_id
        WHERE m.direction = 'in' AND c.deleted_at IS NULL
          ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
        GROUP BY v.id
      ),
      last_touch AS (
        SELECT fi.conversation_id, fi.inquiry_at, t.id AS message_id, t.operator_id
        FROM first_inquiry fi
        JOIN LATERAL (
          SELECT o.id,
                 (SELECT a.operator_id FROM customer_activity a
                  WHERE a.operator_type = 'ai' AND a.ref_type = 'message' AND a.ref_id = o.id
                  ORDER BY a.created_at ASC LIMIT 1) AS operator_id
          FROM message o
          WHERE o.conversation_id = fi.conversation_id
            AND o.direction = 'out' AND o.sender_type = 'ai' AND o.status = 'sent'
            AND o.sent_at IS NOT NULL
            AND o.sent_at <= fi.inquiry_at
            AND o.sent_at >= fi.inquiry_at - make_interval(days => ${PROMOTED_INQUIRY_WINDOW_DAYS})
          ORDER BY o.sent_at DESC
          LIMIT 1
        ) t ON true
        WHERE fi.inquiry_at >= ${range.start} AND fi.inquiry_at < ${range.end}
          ${f.employeeId === null ? sql`` : sql`AND t.operator_id = ${f.employeeId}`}
      )
    `;
  }

  private promotedInquiriesCount(range: ResolvedRange, f: MetricFilters): SQL {
    return sql`
      ${this.promotedInquiriesBase(range, f)}
      SELECT count(*)::int AS n FROM last_touch
    `;
  }

  private promotedItemSql(
    range: ResolvedRange,
    f: MetricFilters,
    limit: number,
    offset: number,
  ): { countSql: SQL; listSql: SQL } {
    const base = this.promotedInquiriesBase(range, f);
    return {
      countSql: sql`${base} SELECT count(*)::int AS n FROM last_touch`,
      listSql: sql`
        ${base}
        SELECT v.id AS id, 'conversation' AS type,
               coalesce(v.subject, c.company_name) AS title,
               c.company_name AS subtitle, c.country AS country, emp.name AS owner_name,
               NULL AS amount, NULL AS currency, lt.inquiry_at AS occurred_at
        FROM last_touch lt
        JOIN conversation v ON v.id = lt.conversation_id
        JOIN customer c ON c.id = v.customer_id
        LEFT JOIN ai_employee emp ON emp.id = lt.operator_id
        ORDER BY lt.inquiry_at DESC, v.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    };
  }

  /** saved_hours 下钻 = 三类 AI 动作明细（分钟数求和复算 = 卡片数值） */
  private savedHoursUnion(range: ResolvedRange, f: MetricFilters): SQL {
    const followUpExcluded = f.employeeId === null ? sql`` : sql`AND false`;
    return sql`
      SELECT c.id AS id, 'found_customer' AS type, c.company_name AS title,
             NULL AS subtitle, c.country AS country, u.name AS owner_name,
             ${SAVED_HOURS_BASELINE_MINUTES.foundCustomer} AS amount, 'MIN' AS currency,
             c.created_at AS occurred_at
      FROM customer c
      LEFT JOIN user_account u ON u.id = c.owner_id
      WHERE c.deleted_at IS NULL AND c.source_lead_id IS NOT NULL
        AND c.created_at >= ${range.start} AND c.created_at < ${range.end}
        ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
      UNION ALL
      SELECT m.id, 'replied_email', coalesce(v.subject, c.company_name),
             c.company_name, c.country, emp.name,
             ${SAVED_HOURS_BASELINE_MINUTES.email}, 'MIN', m.sent_at
      ${this.outreachFrom()}
      LEFT JOIN ai_employee emp ON emp.id = ca.operator_id
      WHERE m.direction = 'out' AND m.sender_type = 'ai' AND m.status = 'sent'
        AND m.sent_at IS NOT NULL
        AND m.sent_at >= ${range.start} AND m.sent_at < ${range.end}
        AND c.deleted_at IS NULL
        ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)}
        ${f.employeeId === null ? sql`` : sql`AND ca.operator_id = ${f.employeeId}`}
      UNION ALL
      SELECT e.id, 'follow_up', e.step_title,
             c.company_name, c.country, u.name,
             ${SAVED_HOURS_BASELINE_MINUTES.followUp}, 'MIN', e.sent_at
      FROM follow_up_execution e
      JOIN follow_up_task t ON t.id = e.follow_up_task_id
      JOIN customer c ON c.id = t.customer_id
      LEFT JOIN user_account u ON u.id = c.owner_id
      WHERE e.status = 'sent' AND e.sent_at IS NOT NULL
        AND e.sent_at >= ${range.start} AND e.sent_at < ${range.end}
        AND c.deleted_at IS NULL
        ${f.owner(sql`c.owner_id`)} ${f.countryCond(sql`c.country`)} ${f.employeeByAcquisition()}
        ${followUpExcluded}
    `;
  }

  private savedHoursItemSql(
    range: ResolvedRange,
    f: MetricFilters,
    limit: number,
    offset: number,
  ): { countSql: SQL; listSql: SQL } {
    const union = this.savedHoursUnion(range, f);
    return {
      countSql: sql`SELECT count(*)::int AS n FROM (${union}) t`,
      listSql: sql`
        SELECT * FROM (${union}) t
        ORDER BY occurred_at DESC NULLS LAST, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    };
  }
}
