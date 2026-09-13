/**
 * 13 AI 外贸经理 · 洞察规则 / 报告模板（单一实现点，API 与 worker 共用）。
 *
 * 边界（13 §4 / 接口 13 §4）：
 * - 洞察必须基于可核实数据：所有发现都由业务表聚合派生，evidence 必填且可下钻；
 * - 一键动作白名单封闭为「发起类」：start_lead_task / enable_reactivation_strategy（可撤销，不产生对外效果）；
 * - 预测类内容标注 estimated: true（报告内以 `estimated` 标记行承载）。
 *
 * 本文件不碰 DB：聚合查询在 `@tradepilot/db`（manager-insights.ts），本层只做纯函数判定与文本组装，
 * 保证 API 实时发现与 worker 报告产出**同一套阈值与同一套文案**。
 */
import { zonedDayRangeUtc } from './time-window.js';

/** 风险口径：高价值客户静默天数（13 §2 原型「5 个高价值客户超过 14 天未联系」） */
export const MANAGER_INACTIVE_DAYS = 14;

/** 高价值客户判定分（customer.score 阈值；与 05 CRM 价值分同源字段） */
export const MANAGER_HIGH_VALUE_SCORE = 80;

/** 机会口径：滚动窗口（近 N 天 vs 前 N 天询盘对比） */
export const MANAGER_OPPORTUNITY_WINDOW_DAYS = 30;

/** 机会口径：环比增长阈值（%） */
export const MANAGER_OPPORTUNITY_GROWTH_PCT = 25;

/** 机会口径：近窗最小询盘量（避免小样本噪声） */
export const MANAGER_OPPORTUNITY_MIN_INQUIRIES = 3;

/** 每类发现最多返回条数（机会取增长最高者） */
export const MANAGER_OPPORTUNITY_MAX_ITEMS = 3;

/**
 * 发现状态（ai_discovery.status，CHECK IN ('new','executed','dismissed')，ER 08 §3）：
 * DISMISSED = 本轮未重检出的历史发现（自动置为终态，列表不再展示）。
 */
export const DISCOVERY_STATUS = {
  NEW: 'new',
  EXECUTED: 'executed',
  DISMISSED: 'dismissed',
} as const;

/** 一键动作白名单（13 §7；后续新增 action 必须遵守「可撤销、不对外」原则） */
export const MANAGER_DISCOVERY_ACTIONS = [
  'start_lead_task',
  'enable_reactivation_strategy',
] as const;
export type ManagerDiscoveryAction = (typeof MANAGER_DISCOVERY_ACTIONS)[number];

/**
 * 一键动作展示文案（接口 13 §1.2 `actions` 只读字段，由 action 映射、不单独传参）：
 * 文案集中在此，避免 API 与前端两处漂移。
 */
export const MANAGER_DISCOVERY_ACTION_LABEL: Record<ManagerDiscoveryAction, string> = {
  start_lead_task: '启动 AI 获客',
  enable_reactivation_strategy: 'AI 自动处理',
};

/** 发现类型（ai_discovery.type / discovery_type 枚举） */
export const DISCOVERY_TYPES = ['opportunity', 'risk'] as const;
export type DiscoveryType = (typeof DISCOVERY_TYPES)[number];

/** 报告周期（report_period 枚举；本期仅手动生成，13 §7.1） */
export const MANAGER_REPORT_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type ManagerReportPeriod = (typeof MANAGER_REPORT_PERIODS)[number];

/** 报告五段结构（13 §7.1 统一模板） */
export const BUSINESS_REPORT_SECTIONS = [
  { key: 'overview', title: '一、经营概览' },
  { key: 'opportunity', title: '二、机会洞察' },
  { key: 'risk', title: '三、风险预警' },
  { key: 'team', title: '四、团队效率' },
  { key: 'next', title: '五、建议与下一步' },
] as const;
export type BusinessReportSectionKey = (typeof BUSINESS_REPORT_SECTIONS)[number]['key'];

/** 预测标记（13 §4：预测类内容必须标注估算） */
export const ESTIMATED_FLAG = 'estimated: true';

export interface DiscoveryEvidence {
  text: string;
  source?: string;
  ref?: string;
}

/**
 * 一键动作（写入 ai_discovery.suggestion jsonb）。
 * 用 type 而非 interface：type 字面量具备隐式索引签名，可直接赋给 jsonb 的 Record<string, unknown>。
 */
export type DiscoverySuggestion = {
  label: string;
  action: ManagerDiscoveryAction;
  payload: Record<string, unknown>;
};

/** 发现草稿（写入 ai_discovery 前的纯数据形态） */
export interface DiscoveryDraft {
  type: DiscoveryType;
  title: string;
  detail: string;
  evidence: DiscoveryEvidence[];
  suggestion: DiscoverySuggestion;
}

/** 四项核心指标（13 §1.1 / 15 §3 同源口径） */
export interface ManagerOverview {
  newCustomers: number;
  newInquiries: number;
  newQuotes: number;
  dealsClosed: number;
}

/** 机会候选（db 层按国家聚合后的输入行） */
export interface OpportunityCandidate {
  country: string;
  /** 近窗询盘量 */
  recent: number;
  /** 前窗询盘量 */
  previous: number;
  /** 近窗高频产品名（quotation_item 快照，可空） */
  productName?: string | null;
}

/** 静默高价值客户（db 层输入行） */
export interface StaleCustomer {
  customerId: string;
  companyName: string;
  country?: string | null;
  score: number;
  lastTouchAt: Date | string | null;
}

export interface ReportTeamRow {
  employeeId: string;
  name: string;
  role: string;
  metric: string | null;
  achieved: number;
  target: number | null;
  kpiPct: number | null;
}

export interface BusinessReportInput {
  period: ManagerReportPeriod;
  periodStart: string;
  periodEnd: string;
  /** 本期四项指标（与 15 / 13 overview 同源快照） */
  overview: ManagerOverview | null;
  /** 上一周期四项指标（环比；无数据 → null，不臆造） */
  previousOverview: ManagerOverview | null;
  /** 上一周期区间（文案用） */
  previousPeriod?: { start: string; end: string } | null;
  discoveries: DiscoveryDraft[];
  team: ReportTeamRow[];
  generatedAt: Date;
}

/** 环比增长（%）；前值为 0 时无法计算 → null（不显示 ∞ / 100%） */
export function computeGrowthPct(recent: number, previous: number): number | null {
  if (previous <= 0) {
    return null;
  }
  return Math.round(((recent - previous) / previous) * 100);
}

/**
 * kpiPct 口径（13 §1.3 / §7.3，与 02 员工卡片同源）：
 * `min(100, round(achieved / target × 100))`；target 未配置（≤0）→ null（前端显示「未设目标」）。
 */
export function computeKpiPct(achieved: number, target: number | null | undefined): number | null {
  if (target === null || target === undefined || target <= 0) {
    return null;
  }
  return Math.min(100, Math.round((achieved / target) * 100));
}

/** 数据中心下钻深链（evidence.ref；前端据此打开 15 下钻明细，保证数字可验证） */
export function buildAnalyticsDrilldownRef(
  metric: string,
  params: { startDate?: string; endDate?: string; country?: string; employeeId?: string } = {},
): string {
  const query = new URLSearchParams({ metric, period: 'custom' });
  if (params.startDate) query.set('startDate', params.startDate);
  if (params.endDate) query.set('endDate', params.endDate);
  if (params.country) query.set('country', params.country);
  if (params.employeeId) query.set('employeeId', params.employeeId);
  return `/data-center?${query.toString()}`;
}

/** 客户 360 深链（风险证据可下钻到具体客户） */
export function buildCustomer360Ref(customerId: string): string {
  return `/customers/${customerId}`;
}

/** 客户类型兜底（获客任务 parsed.customerType 必填；发现场景无法从数据推断时用经销商口径） */
const DEFAULT_CUSTOMER_TYPE = '经销商';
const DEFAULT_PRODUCT = '主力出口产品';

/**
 * 机会 → 发现草稿（FR-03）：近窗询盘环比增长 ≥ 阈值且样本量达标才产出结论。
 * 文案对齐 13 §2 原型：「Carbon Fiber Insoles 相关询盘增加 28%」。
 */
export function buildOpportunityDiscoveries(
  candidates: OpportunityCandidate[],
  range: { startDate: string; endDate: string },
): DiscoveryDraft[] {
  const ranked = candidates
    .map((item) => ({ item, growth: computeGrowthPct(item.recent, item.previous) }))
    .filter(
      (entry): entry is { item: OpportunityCandidate; growth: number } =>
        entry.growth !== null &&
        entry.growth >= MANAGER_OPPORTUNITY_GROWTH_PCT &&
        entry.item.recent >= MANAGER_OPPORTUNITY_MIN_INQUIRIES &&
        Boolean(entry.item.country),
    )
    .sort((a, b) => b.growth - a.growth)
    .slice(0, MANAGER_OPPORTUNITY_MAX_ITEMS);

  return ranked.map(({ item, growth }) => {
    const product = item.productName?.trim() || DEFAULT_PRODUCT;
    return {
      type: 'opportunity' as const,
      title: `${item.country}市场机会`,
      detail: `${product} 相关询盘增加 ${growth}%`,
      evidence: [
        {
          text: `近 ${MANAGER_OPPORTUNITY_WINDOW_DAYS} 天询盘 ${item.previous} → ${item.recent}`,
          source: 'analytics',
          ref: buildAnalyticsDrilldownRef('inquiries', {
            startDate: range.startDate,
            endDate: range.endDate,
            country: item.country,
          }),
        },
      ],
      suggestion: {
        label: `增加${item.country}市场获客任务`,
        action: 'start_lead_task' as const,
        payload: {
          goalText: `在${item.country}市场开发对「${product}」有采购意向的经销商`,
          parsed: {
            targetMarket: item.country,
            customerType: DEFAULT_CUSTOMER_TYPE,
            targetProduct: product,
          },
        },
      },
    };
  });
}

/**
 * 风险 → 发现草稿（FR-04）：高价值客户静默 ≥ 阈值天数聚合为一条预警。
 * 文案对齐 13 §2 原型：「5 个高价值客户超过 14 天未联系」。
 */
export function buildRiskDiscovery(
  staleCustomers: StaleCustomer[],
  opts: { inactiveDays?: number; limit?: number } = {},
): DiscoveryDraft | null {
  if (staleCustomers.length === 0) {
    return null;
  }
  const inactiveDays = opts.inactiveDays ?? MANAGER_INACTIVE_DAYS;
  const shown = staleCustomers.slice(0, opts.limit ?? 5);
  return {
    type: 'risk',
    title: `${staleCustomers.length} 个高价值客户超过 ${inactiveDays} 天未联系`,
    detail: `高价值客户（评分 ≥ ${MANAGER_HIGH_VALUE_SCORE}）连续 ${inactiveDays} 天无触达记录，存在流失风险`,
    evidence: shown.map((row) => ({
      text: `${row.companyName}${row.country ? `（${row.country}）` : ''} · 评分 ${row.score} · 最后触达 ${formatDate(row.lastTouchAt)}`,
      source: 'crm',
      ref: buildCustomer360Ref(row.customerId),
    })),
    suggestion: {
      label: '启动自动重新激活策略',
      action: 'enable_reactivation_strategy',
      payload: {
        name: `高价值客户重新激活（${staleCustomers.length} 个客户）`,
        targetScope: { customerValue: ['high'] },
        autoSendPolicy: 'manual_review',
        steps: [
          {
            seq: 1,
            dayOffset: 0,
            title: '重新激活 · 价值提醒',
            content: '回顾此前的合作/报价内容，重新同步最新报价与供货能力，确认采购计划是否调整。',
          },
          {
            seq: 2,
            dayOffset: 3,
            title: '重新激活 · 案例背书',
            content: '提供同市场/同品类客户案例与出货情况，给出下一批次的排产与交付窗口建议。',
          },
          {
            seq: 3,
            dayOffset: 7,
            title: '重新激活 · 收尾确认',
            content: '确认是否仍有采购需求；无需求则礼貌收尾并保留后续联系窗口。',
            isBreakup: true,
          },
        ],
      },
    },
  };
}

/**
 * 机会/风险的统一统计窗口（同日历口径，API 实时发现与 worker 报告共用）：
 * - 近窗：当地日区间 [今天-(N-1), 今天结束]
 * - 前窗：近窗之前等长 N 天
 * 以 org 时区（`org.timezone`）切分当地日，避免跨时区把「昨天」算进今天（对齐 15 §7 口径）。
 */
export function managerInsightWindow(opts: {
  anchor: Date;
  timeZone: string;
  windowDays?: number;
}): {
  recentStart: Date;
  recentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
  windowDays: number;
} {
  const windowDays = opts.windowDays ?? MANAGER_OPPORTUNITY_WINDOW_DAYS;
  const today = zonedDayRangeUtc(opts.anchor, opts.timeZone);
  const recentStart = zonedDayRangeUtc(opts.anchor, opts.timeZone, windowDays - 1).start;
  const previousStart = zonedDayRangeUtc(opts.anchor, opts.timeZone, windowDays * 2 - 1).start;
  return {
    recentStart,
    recentEnd: today.end,
    previousStart,
    previousEnd: recentStart,
    windowDays,
  };
}

/** 按类型分组取出的发现（报告章节与列表共用） */
export function groupDiscoveries(discoveries: DiscoveryDraft[]): {
  opportunities: DiscoveryDraft[];
  risks: DiscoveryDraft[];
} {
  return {
    opportunities: discoveries.filter((d) => d.type === 'opportunity'),
    risks: discoveries.filter((d) => d.type === 'risk'),
  };
}

/** 报告周期标签（文案集中在此，避免 API/worker/前端三处漂移） */
export function reportPeriodLabel(period: ManagerReportPeriod): string {
  return period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报';
}

/**
 * 报告正文（Markdown 五段，13 §7.1）：
 * ①经营概览（四项指标 + 环比）②机会洞察 ③风险预警 ④团队效率 ⑤建议与下一步。
 * 预测类内容单列一行并标注 `estimated: true`（13 §4 红线）。
 */
export function buildBusinessReportMarkdown(input: BusinessReportInput): string {
  const { opportunities, risks } = groupDiscoveries(input.discoveries);
  const lines: string[] = [];

  lines.push(`# ${reportPeriodLabel(input.period)}（${input.periodStart} ~ ${input.periodEnd}）`);
  lines.push('');
  lines.push(
    `> 生成时间：${formatDateTime(input.generatedAt)} · 数据来源：业务表实时聚合（与数据中心同源）`,
  );
  lines.push('');

  // ① 经营概览
  lines.push(`## ${BUSINESS_REPORT_SECTIONS[0].title}`);
  lines.push('');
  if (input.overview) {
    const o = input.overview;
    lines.push(
      `- 新客户：${o.newCustomers}${formatDelta(o.newCustomers, input.previousOverview?.newCustomers)}`,
    );
    lines.push(
      `- 新询盘：${o.newInquiries}${formatDelta(o.newInquiries, input.previousOverview?.newInquiries)}`,
    );
    lines.push(
      `- 新报价：${o.newQuotes}${formatDelta(o.newQuotes, input.previousOverview?.newQuotes)}`,
    );
    lines.push(
      `- 成交订单：${o.dealsClosed}${formatDelta(o.dealsClosed, input.previousOverview?.dealsClosed)}`,
    );
    if (input.previousOverview && input.previousPeriod) {
      lines.push('');
      lines.push(
        `环比基准：${input.previousPeriod.start} ~ ${input.previousPeriod.end}（新客户 ${input.previousOverview.newCustomers} / 新询盘 ${input.previousOverview.newInquiries} / 新报价 ${input.previousOverview.newQuotes} / 成交 ${input.previousOverview.dealsClosed}）`,
      );
    }
    lines.push('');
    lines.push(
      `- 成交趋势预测（${ESTIMATED_FLAG}）：按本期成交 ${o.dealsClosed} 单线性外推，下一周期成交约 ${o.dealsClosed} 单，仅作参考`,
    );
  } else {
    lines.push('- 本期无可用指标快照');
  }
  lines.push('');

  // ② 机会洞察
  lines.push(`## ${BUSINESS_REPORT_SECTIONS[1].title}`);
  lines.push('');
  if (opportunities.length === 0) {
    lines.push('- 本期未发现达到阈值（环比 ≥ 25% 且样本量达标）的市场机会');
  } else {
    for (const item of opportunities) {
      lines.push(`### ${item.title}`);
      lines.push('');
      lines.push(`- 结论：${item.detail}`);
      for (const evidence of item.evidence) {
        lines.push(
          `- 证据：${evidence.text}${evidence.ref ? `（[下钻明细](${evidence.ref})）` : ''}`,
        );
      }
      lines.push(`- 建议：${item.suggestion.label}`);
      lines.push('');
    }
  }
  lines.push('');

  // ③ 风险预警
  lines.push(`## ${BUSINESS_REPORT_SECTIONS[2].title}`);
  lines.push('');
  if (risks.length === 0) {
    lines.push('- 本期无高价值客户静默预警');
  } else {
    for (const item of risks) {
      lines.push(`### ${item.title}`);
      lines.push('');
      lines.push(`- 结论：${item.detail}`);
      for (const evidence of item.evidence) {
        lines.push(
          `- 证据：${evidence.text}${evidence.ref ? `（[客户 360](${evidence.ref})）` : ''}`,
        );
      }
      lines.push(`- 建议：${item.suggestion.label}`);
      lines.push('');
    }
  }
  lines.push('');

  // ④ 团队效率
  lines.push(`## ${BUSINESS_REPORT_SECTIONS[3].title}`);
  lines.push('');
  if (input.team.length === 0) {
    lines.push('- 暂无 AI 员工数据');
  } else {
    lines.push('| AI 员工 | 指标 | 达成 / 目标 | 进度 |');
    lines.push('|---|---|---|---|');
    for (const row of input.team) {
      const metric = row.metric ?? '—';
      const target = row.target === null ? '未设目标' : String(row.target);
      const pct = row.kpiPct === null ? '未设目标' : `${row.kpiPct}%`;
      lines.push(`| ${row.name} | ${metric} | ${row.achieved} / ${target} | ${pct} |`);
    }
  }
  lines.push('');

  // ⑤ 建议与下一步
  lines.push(`## ${BUSINESS_REPORT_SECTIONS[4].title}`);
  lines.push('');
  const suggestions = input.discoveries.map((item) => item.suggestion);
  if (suggestions.length === 0) {
    lines.push('- 保持现有获客与跟进节奏，关注下期询盘增长');
  } else {
    suggestions.forEach((suggestion, index) => {
      lines.push(
        `${index + 1}. ${suggestion.label}（动作：\`${suggestion.action}\`，仅创建可撤销任务 / 策略，外发仍走审批）`,
      );
    });
  }
  lines.push('');

  return lines.join('\n');
}

/** 报告 citations（evidence 汇总去重；接口 13 §1.4 可下钻） */
export function buildBusinessReportCitations(
  input: BusinessReportInput,
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const citations: Record<string, unknown>[] = [];
  for (const discovery of input.discoveries) {
    for (const evidence of discovery.evidence) {
      const key = `${evidence.text}|${evidence.ref ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      citations.push({
        text: evidence.text,
        source: evidence.source ?? 'analytics',
        ...(evidence.ref ? { ref: evidence.ref } : {}),
      });
    }
  }
  return citations;
}

/** 构建报告所需的上一周期区间（daily/weekly/monthly 各自等长回溯） */
export function previousPeriodRange(
  period: ManagerReportPeriod,
  range: { start: string; end: string },
): { start: string; end: string } {
  const start = new Date(`${range.start}T00:00:00Z`);
  const end = new Date(`${range.end}T00:00:00Z`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);
  return { start: toDateKey(prevStart), end: toDateKey(prevEnd) };
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDate(value: Date | string | null): string {
  if (!value) {
    return '无记录';
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return '无记录';
  }
  return date.toISOString().slice(0, 10);
}

function formatDateTime(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16);
}

/** 环比文案：`（环比 +12%）` / `（环比 -8%）` / 无前值 → 空串 */
function formatDelta(current: number, previous: number | null | undefined): string {
  if (previous === null || previous === undefined) {
    return '';
  }
  const pct = computeGrowthPct(current, previous);
  if (pct === null) {
    return previous === 0 && current === 0 ? '' : '（环比 新增）';
  }
  const sign = pct > 0 ? '+' : '';
  return `（环比 ${sign}${pct}%）`;
}
