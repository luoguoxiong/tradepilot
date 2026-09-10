/**
 * 03 AI 获客服务（接口 03 §3，M5-B2）：
 * - lead-hunter/summary：员工状态 + 今日产出 + 当前任务
 * - lead-tasks/parse：LLM 解析目标文本 → 结构化字段
 * - lead-tasks：创建获客任务（复用 tasks 模块 lead_hunting）
 * - leads 列表/详情/summary：从 ai_lead 发现池查询
 * - add-to-crm：三级去重后转入 CRM customer
 * - batch-analyze：异步创建 product_analysis 任务
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { BizException, ErrorCode, createId } from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { TasksService } from '../tasks/tasks.service.js';
import { CustomersService } from '../customers/customers.service.js';
import type {
  AddToCrmDto,
  BatchAnalyzeDto,
  ConvertLeadDto,
  CreateLeadTaskDto,
  ListLeadsQuery,
  ParseLeadTaskDto,
} from './leads.dto.js';
import type { OrgScopeContext } from '@tradepilot/db';

export interface LeadHunterSummary {
  employee: { employeeId: string; name: string; status: string } | null;
  todaySummary: { found: number; analyzed: number; highValue: number };
  currentTask: {
    taskId: string;
    goal: string;
    progressPct: number;
    foundCount: number;
    targetCount: number;
    currentStep: string;
    status: string;
  } | null;
}

export interface ParseResult {
  parsed: {
    targetMarket: string;
    customerType: string;
    targetProduct: string;
    companySize?: string;
  };
  optimizedGoal: string;
  confidence: number;
  reasons: { text: string }[];
}

export interface LeadItem {
  leadId: string;
  companyName: string;
  country: string;
  industry: string | null;
  website: string | null;
  matchPct: number;
  scoreLevel: string;
  inCrm: boolean;
  matchReasons: {
    value: number;
    confidence: number;
    reasons: { text: string; evidence?: string; source?: string }[];
  };
}

/** 03 §2 GET /leads/summary：各价值档数量（`all`/`inCrm` 供 Tab 计数，03 §1.6） */
export interface LeadSummaryCounts {
  all: number;
  high: number;
  medium: number;
  low: number;
  inCrm: number;
}

/** 04 §2 POST /leads/{id}/convert 响应（单条转化，与批量 add-to-crm 汇总形状不同） */
export interface ConvertLeadResult {
  leadId: string;
  customerId: string;
  customerName: string;
  mapped: boolean;
}

export interface LeadDetail {
  leadId: string;
  companyName: string;
  country: string;
  industry: string | null;
  website: string | null;
  matchPct: number;
  scoreLevel: string;
  inCrm: boolean;
  convertedCustomerId: string | null;
  matchReasons: {
    value: number;
    confidence: number;
    reasons: { text: string; evidence?: string; source?: string }[];
  };
  overview: {
    companySize?: string;
    foundedYear?: number;
    customerType?: string;
    mainProducts?: string[];
  } | null;
  contacts: { name: string; title: string | null; email: string | null }[];
  createdAt: string;
}

export interface AddToCrmResult {
  created: number;
  duplicated: number;
  customers: { customerId: string; leadId: string }[];
  mapped: { leadId: string; mappedCustomerId: string }[];
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(CustomersService) private readonly customers: CustomersService,
  ) {}

  /** B2 §1 工作台头部：员工状态 + 今日产出 + 当前任务 */
  async summary(ctx: OrgScopeContext): Promise<LeadHunterSummary> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return withOrg(this.db, ctx.orgId, async (tx) => {
      // 查找 lead_hunter 角色的 AI 员工
      const [employee] = await tx
        .select({
          id: schema.aiEmployee.id,
          name: schema.aiEmployee.name,
          status: schema.aiEmployee.status,
        })
        .from(schema.aiEmployee)
        .where(
          and(eq(schema.aiEmployee.orgId, ctx.orgId), eq(schema.aiEmployee.role, 'lead_hunter')),
        )
        .limit(1);

      // 今日产出
      const [todayAgg] = await tx
        .select({
          found: sql<number>`count(*)::int`,
          highValue: sql<number>`count(*) filter (where ${schema.aiLead.scoreLevel} = 'high')::int`,
        })
        .from(schema.aiLead)
        .where(
          and(
            eq(schema.aiLead.orgId, ctx.orgId),
            sql`${schema.aiLead.createdAt} >= ${today.toISOString()}`,
          ),
        );
      // 今日分析数 = 有 analyzedAt 的 lead 数
      const [analyzedAgg] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiLead)
        .where(
          and(
            eq(schema.aiLead.orgId, ctx.orgId),
            sql`${schema.aiLead.createdAt} >= ${today.toISOString()}`,
            sql`${schema.aiLead.analyzedAt} is not null`,
          ),
        );

      // 当前任务（lead_hunting 类型，非终态）
      const [currentTask] = await tx
        .select({
          taskId: schema.aiTask.id,
          title: schema.aiTask.title,
          progressPct: schema.aiTask.progressPct,
          status: schema.aiTask.status,
          currentStep: schema.aiTask.currentStep,
        })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.orgId, ctx.orgId),
            eq(schema.aiTask.type, 'lead_hunting'),
            sql`${schema.aiTask.status} not in ('completed', 'failed', 'canceled')`,
          ),
        )
        .orderBy(desc(schema.aiTask.createdAt))
        .limit(1);

      let foundCount = 0;
      let targetCount = 0;
      if (currentTask) {
        const [leadCount] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.aiLead)
          .where(
            and(eq(schema.aiLead.orgId, ctx.orgId), eq(schema.aiLead.taskId, currentTask.taskId)),
          );
        foundCount = leadCount?.n ?? 0;

        const [taskRow] = await tx
          .select({ input: schema.aiTask.input })
          .from(schema.aiTask)
          .where(eq(schema.aiTask.id, currentTask.taskId))
          .limit(1);
        if (taskRow?.input) {
          targetCount = ((taskRow.input as Record<string, unknown>)?.targetCount as number) ?? 0;
        }
      }

      return {
        employee: employee
          ? { employeeId: employee.id, name: employee.name, status: employee.status }
          : null,
        todaySummary: {
          found: todayAgg?.found ?? 0,
          analyzed: analyzedAgg?.n ?? 0,
          highValue: todayAgg?.highValue ?? 0,
        },
        currentTask: currentTask
          ? {
              taskId: currentTask.taskId,
              goal: currentTask.title,
              progressPct: currentTask.progressPct,
              foundCount,
              targetCount,
              currentStep: currentTask.currentStep ?? '',
              status: currentTask.status,
            }
          : null,
      };
    });
  }

  /** B2 §2 AI 解析目标文本 → 结构化字段 */
  async parse(ctx: OrgScopeContext, dto: ParseLeadTaskDto): Promise<ParseResult> {
    // MVP: 基于规则简单解析，后续可接 LLM
    const text = dto.goalText;
    const parsed = this.simpleParse(text);
    const optimizedGoal = `寻找${parsed.targetMarket}的${parsed.customerType}，匹配${parsed.targetProduct}产品线`;
    return {
      parsed,
      optimizedGoal,
      confidence: 0.85,
      reasons: [{ text: '从目标文本中提取到市场/客户类型/产品三要素' }],
    };
  }

  /** B2 §3 创建获客任务（复用 tasks 模块 lead_hunting） */
  async createTask(
    ctx: OrgScopeContext,
    dto: CreateLeadTaskDto,
  ): Promise<{ taskId: string; status: string }> {
    const input: Record<string, unknown> = {
      goalText: dto.goalText,
      parsed: dto.parsed,
      advancedSettings: dto.advancedSettings ?? {},
      targetCount: dto.targetCount ?? 35,
    };
    const employeeId = await withOrg(this.db, ctx.orgId, (tx) =>
      this.resolveLeadHunterEmployee(tx, ctx.orgId, dto.employeeId),
    );
    return this.tasks.create(ctx.orgId, ctx.userId, {
      employeeId,
      type: 'lead_hunting',
      title: `获客：${dto.parsed.targetMarket} ${dto.parsed.customerType}`,
      input,
    });
  }

  /**
   * 解析 lead_hunting 执行员工（03 §3.2）。
   * 显式传入 → 必须属本 org 且角色为 lead_hunter（不存在/跨租户 → 40401）；
   * 未传（§1.3 创建表单并无该字段，前端不传）→ 回退 org 内 lead_hunter，再退 customer_researcher。
   * 不校验将导致任务落到他人/他租户员工，故与 batchAnalyze 同口径显式解析。
   */
  private async resolveLeadHunterEmployee(
    tx: Tx,
    orgId: string,
    employeeId?: string,
  ): Promise<string> {
    if (employeeId) {
      const [row] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(
          and(
            eq(schema.aiEmployee.id, employeeId),
            eq(schema.aiEmployee.orgId, orgId),
            eq(schema.aiEmployee.role, 'lead_hunter'),
          ),
        )
        .limit(1);
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, '获客员工不存在');
      }
      return row.id;
    }

    const [row] = await tx
      .select({ id: schema.aiEmployee.id })
      .from(schema.aiEmployee)
      .where(
        and(
          eq(schema.aiEmployee.orgId, orgId),
          inArray(schema.aiEmployee.role, ['lead_hunter', 'customer_researcher']),
        ),
      )
      .limit(1);
    if (!row) {
      throw new BizException(ErrorCode.NOT_FOUND, '未找到可用 AI 员工');
    }
    return row.id;
  }

  /** B2 §4 客户发现列表 */
  async list(
    ctx: OrgScopeContext,
    query: ListLeadsQuery & { page: number; pageSize: number },
  ): Promise<{ items: LeadItem[]; total: number; page: number; pageSize: number }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conditions: SQL[] = [eq(schema.aiLead.orgId, ctx.orgId)];

      if (query.valueLevel && query.valueLevel !== 'all') {
        conditions.push(eq(schema.aiLead.scoreLevel, query.valueLevel));
      }
      if (query.keyword) {
        conditions.push(ilike(schema.aiLead.companyName, `%${query.keyword}%`));
      }
      if (query.country) {
        conditions.push(eq(schema.aiLead.country, query.country));
      }
      if (query.industry) {
        conditions.push(eq(schema.aiLead.industry, query.industry));
      }
      if (query.minMatchPct !== undefined) {
        conditions.push(sql`${schema.aiLead.matchPct} >= ${query.minMatchPct}`);
      }
      if (query.taskId) {
        conditions.push(eq(schema.aiLead.taskId, query.taskId));
      }
      if (query.inCrm !== undefined) {
        conditions.push(eq(schema.aiLead.inCrm, query.inCrm));
      }

      const where = and(...conditions);

      const rows = await tx
        .select()
        .from(schema.aiLead)
        .where(where)
        .orderBy(desc(schema.aiLead.matchPct))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiLead)
        .where(where);

      return {
        items: rows.map((r) => ({
          leadId: r.id,
          companyName: r.companyName,
          country: r.country,
          industry: r.industry,
          website: r.website,
          matchPct: r.matchPct,
          scoreLevel: r.scoreLevel,
          inCrm: r.inCrm,
          matchReasons: r.insight,
        })),
        total: countRow?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /**
   * B2 §4 各价值档数量。
   * 03 §1.6 Tab 计数需要：`all`（全部）+ 三档 + `inCrm`（已加入 CRM），
   * 字段名与前端 `LeadSummaryResp` 一致（`all` 而非 `total`，前端取 `summary.all`）。
   */
  async summaryCounts(ctx: OrgScopeContext): Promise<LeadSummaryCounts> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [row] = await tx
        .select({
          all: sql<number>`count(*)::int`,
          high: sql<number>`count(*) filter (where ${schema.aiLead.scoreLevel} = 'high')::int`,
          medium: sql<number>`count(*) filter (where ${schema.aiLead.scoreLevel} = 'medium')::int`,
          low: sql<number>`count(*) filter (where ${schema.aiLead.scoreLevel} = 'low')::int`,
          inCrm: sql<number>`count(*) filter (where ${schema.aiLead.inCrm})::int`,
        })
        .from(schema.aiLead)
        .where(eq(schema.aiLead.orgId, ctx.orgId));
      return row ?? { all: 0, high: 0, medium: 0, low: 0, inCrm: 0 };
    });
  }

  /** B2 §5 发现客户详情 */
  async detail(ctx: OrgScopeContext, leadId: string): Promise<LeadDetail> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [lead] = await tx
        .select()
        .from(schema.aiLead)
        .where(and(eq(schema.aiLead.id, leadId), eq(schema.aiLead.orgId, ctx.orgId)))
        .limit(1);
      if (!lead) {
        throw new BizException(ErrorCode.NOT_FOUND, '发现客户不存在');
      }

      const contacts = await tx
        .select({
          name: schema.aiLeadContact.name,
          title: schema.aiLeadContact.title,
          email: schema.aiLeadContact.email,
        })
        .from(schema.aiLeadContact)
        .where(eq(schema.aiLeadContact.leadId, leadId));

      return {
        leadId: lead.id,
        companyName: lead.companyName,
        country: lead.country,
        industry: lead.industry,
        website: lead.website,
        matchPct: lead.matchPct,
        scoreLevel: lead.scoreLevel,
        inCrm: lead.inCrm,
        convertedCustomerId: lead.convertedCustomerId,
        matchReasons: lead.insight,
        overview: lead.overview ?? null,
        contacts: contacts.map((c) => ({ name: c.name, title: c.title, email: c.email })),
        createdAt: lead.createdAt.toISOString(),
      };
    });
  }

  /** B2 §6 加入 CRM（三级去重） */
  async addToCrm(ctx: OrgScopeContext, dto: AddToCrmDto): Promise<AddToCrmResult> {
    // ownerId 校验：sales 不可指定他人
    const ownerId = dto.ownerId ?? ctx.userId;
    if (ownerId !== ctx.userId && ctx.role === 'sales') {
      throw new BizException(ErrorCode.FORBIDDEN, '负责人指派仅经理/管理员可操作');
    }

    return withOrg(this.db, ctx.orgId, async (tx) => {
      // 归属校验：显式指定的负责人必须属本租户（与 05 §1.2 创建客户 assertOwnerExists 同口径），
      // 否则会把客户落到不存在/他租户用户下（此前静默创建，列表 ownerName 兜底为 raw id）。
      if (ownerId !== ctx.userId) {
        const [owner] = await tx
          .select({ id: schema.userAccount.id })
          .from(schema.userAccount)
          .where(and(eq(schema.userAccount.id, ownerId), eq(schema.userAccount.orgId, ctx.orgId)))
          .limit(1);
        if (!owner) {
          throw new BizException(ErrorCode.NOT_FOUND, `负责人不存在: ${ownerId}`);
        }
      }

      const leads = await tx
        .select()
        .from(schema.aiLead)
        .where(and(eq(schema.aiLead.orgId, ctx.orgId), inArray(schema.aiLead.id, dto.leadIds)));

      const result: AddToCrmResult = { created: 0, duplicated: 0, customers: [], mapped: [] };

      for (const lead of leads) {
        if (lead.inCrm) {
          result.duplicated++;
          if (lead.convertedCustomerId) {
            result.mapped.push({ leadId: lead.id, mappedCustomerId: lead.convertedCustomerId });
          }
          continue;
        }

        // 三级去重：归一化域名 → 公司名 → 邮箱域
        let matchedCustomerId: string | undefined;
        // 第一级：通过 ai_lead 的 companyDomain 查找已关联的 customer
        if (lead.companyDomain) {
          // 查找已通过此 domain 转成 CRM 的 customer
          const [viaLead] = await tx
            .select({ id: schema.customer.id })
            .from(schema.customer)
            .innerJoin(schema.aiLead, eq(schema.aiLead.convertedCustomerId, schema.customer.id))
            .where(
              and(
                eq(schema.customer.orgId, ctx.orgId),
                eq(schema.aiLead.companyDomain, lead.companyDomain),
                sql`${schema.aiLead.inCrm} = true`,
              ),
            )
            .limit(1);
          if (viaLead) {
            matchedCustomerId = viaLead.id;
          }
        }
        // 第二级：公司名兜底
        if (!matchedCustomerId) {
          const [matched] = await tx
            .select({ id: schema.customer.id })
            .from(schema.customer)
            .where(
              and(
                eq(schema.customer.orgId, ctx.orgId),
                sql`lower(${schema.customer.companyName}) = lower(${lead.companyName})`,
              ),
            )
            .limit(1);
          if (matched) {
            matchedCustomerId = matched.id;
          }
        }
        // 第三级：联系人邮箱域辅助
        if (!matchedCustomerId) {
          const [contact] = await tx
            .select({ email: schema.aiLeadContact.email })
            .from(schema.aiLeadContact)
            .where(
              and(
                eq(schema.aiLeadContact.leadId, lead.id),
                sql`${schema.aiLeadContact.email} is not null`,
              ),
            )
            .limit(1);
          if (contact?.email) {
            const domain = contact.email.split('@')[1]?.toLowerCase();
            if (domain) {
              const [viaLeadDomain] = await tx
                .select({ id: schema.customer.id })
                .from(schema.customer)
                .innerJoin(schema.aiLead, eq(schema.aiLead.convertedCustomerId, schema.customer.id))
                .where(
                  and(
                    eq(schema.customer.orgId, ctx.orgId),
                    eq(schema.aiLead.companyDomain, domain),
                    sql`${schema.aiLead.inCrm} = true`,
                  ),
                )
                .limit(1);
              if (viaLeadDomain) {
                matchedCustomerId = viaLeadDomain.id;
              }
            }
          }
        }

        if (matchedCustomerId) {
          // 命中已有客户：mapped，不改归属
          result.mapped.push({ leadId: lead.id, mappedCustomerId: matchedCustomerId });
          await tx
            .update(schema.aiLead)
            .set({ inCrm: true, convertedCustomerId: matchedCustomerId, updatedAt: new Date() })
            .where(eq(schema.aiLead.id, lead.id));
        } else {
          // 新建 customer
          const customerId = createId('cus');
          await tx.insert(schema.customer).values({
            id: customerId,
            orgId: ctx.orgId,
            companyName: lead.companyName,
            country: lead.country,
            industry: lead.industry ?? null,
            website: lead.website ?? null,
            stage: 'new_lead',
            isFormal: false,
            ownerId,
            createdBy: ctx.userId,
            sourceLeadId: lead.id,
          });
          await tx
            .update(schema.aiLead)
            .set({ inCrm: true, convertedCustomerId: customerId, updatedAt: new Date() })
            .where(eq(schema.aiLead.id, lead.id));
          result.created++;
          result.customers.push({ customerId, leadId: lead.id });
        }
      }

      return result;
    });
  }

  /** B2 §7 批量 AI 分析（异步 → product_analysis 任务） */
  async batchAnalyze(ctx: OrgScopeContext, dto: BatchAnalyzeDto): Promise<{ taskId: string }> {
    let employeeId = '';
    await withOrg(this.db, ctx.orgId, async (tx) => {
      const [employee] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(
          and(
            eq(schema.aiEmployee.orgId, ctx.orgId),
            inArray(schema.aiEmployee.role, ['lead_hunter', 'customer_researcher']),
          ),
        )
        .limit(1);
      if (!employee) {
        throw new BizException(ErrorCode.NOT_FOUND, '未找到可用 AI 员工');
      }
      employeeId = employee.id;
    });

    return this.tasks.create(ctx.orgId, ctx.userId, {
      employeeId: employeeId,
      type: 'product_analysis',
      title: `批量分析 ${dto.leadIds.length} 个客户`,
      input: { leadIds: dto.leadIds, action: 'batch_analyze' },
    });
  }

  /**
   * 04 §2 POST /leads/{id}/convert 单条 lead 转 CRM。
   * 出参是单条结果 + `mapped` 布尔（前端据此区分「新建客户档案 / 归并已有客户」文案），
   * 与批量 add-to-crm 的 `{created,duplicated,customers,mapped[]}` 汇总形状不同，故此处做映射。
   */
  async convert(
    ctx: OrgScopeContext,
    leadId: string,
    dto: ConvertLeadDto,
  ): Promise<ConvertLeadResult> {
    const lead = await withOrg(this.db, ctx.orgId, async (tx) => {
      const [row] = await tx
        .select({
          companyName: schema.aiLead.companyName,
          convertedCustomerId: schema.aiLead.convertedCustomerId,
        })
        .from(schema.aiLead)
        .where(and(eq(schema.aiLead.id, leadId), eq(schema.aiLead.orgId, ctx.orgId)))
        .limit(1);
      return row;
    });
    if (!lead) {
      throw new BizException(ErrorCode.NOT_FOUND, '发现客户不存在');
    }

    const result = await this.addToCrm(ctx, { leadIds: [leadId], ownerId: dto.ownerId });
    const created = result.customers[0];
    // 已转化 lead 重复 convert 时 customers/mapped 皆空 → 回退 lead 上记录的归属客户
    const customerId =
      created?.customerId ?? result.mapped[0]?.mappedCustomerId ?? lead.convertedCustomerId;
    if (!customerId) {
      throw new BizException(ErrorCode.NOT_FOUND, '发现客户不存在');
    }

    const customerName = await withOrg(this.db, ctx.orgId, async (tx) => {
      const [row] = await tx
        .select({ companyName: schema.customer.companyName })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), eq(schema.customer.orgId, ctx.orgId)))
        .limit(1);
      return row?.companyName ?? lead.companyName;
    });

    return { leadId, customerId, customerName, mapped: !created };
  }

  /** 简单规则解析（MVP 暂替 LLM） */
  private simpleParse(text: string): {
    targetMarket: string;
    customerType: string;
    targetProduct: string;
    companySize?: string;
  } {
    let targetMarket = 'Global';
    let customerType = 'Company';
    let targetProduct = text;
    let companySize: string | undefined;

    // 国家关键词
    const countryMap: Array<{ pattern: string; value: string }> = [
      { pattern: '美国|USA|US|America|北美', value: 'USA' },
      { pattern: '德国|Germany|DE|欧洲', value: 'Germany' },
      { pattern: '日本|Japan|JP', value: 'Japan' },
      { pattern: '英国|UK|Britain|England', value: 'UK' },
      { pattern: '法国|France|FR', value: 'France' },
    ];
    for (const entry of countryMap) {
      if (new RegExp(entry.pattern, 'i').test(text)) {
        targetMarket = entry.value;
        break;
      }
    }
    if (targetMarket === 'Global') {
      // 尝试提取"在...做/找/寻找"模式
      const m = text.match(/在(.+?)(?:做|找|寻找|的)/);
      if (m?.[1]) {
        targetMarket = m[1].trim();
      }
    }

    // 提取"做...的"或"...品牌"模式
    const typeMatch = text.match(/(?:做|生产|制造|经营)(.+?)(?:的|品牌)/);
    if (typeMatch?.[1]) {
      customerType = typeMatch[1].trim();
    }

    // 提取产品关键词（"匹配/需要/可能需要"后）
    const prodMatch = text.match(/(?:匹配|需要|可能需要|推销|卖)(.+?)(?:$|，|。)/);
    if (prodMatch?.[1]) {
      targetProduct = prodMatch[1].trim();
    }

    // 公司规模
    const sizeMatch = text.match(/(\d+\s*[-~]\s*\d+\+?)/);
    if (sizeMatch) {
      companySize = sizeMatch[1];
    }

    return { targetMarket, customerType, targetProduct, companySize };
  }
}
