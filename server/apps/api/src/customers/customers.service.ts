import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { BizException, ErrorCode, createId } from '@tradepilot/core';
import {
  schema,
  withOrg,
  applyOwnerScope,
  assertResourceAccess,
  notDeleted,
  resolveScope,
  scopeAnd,
  type Db,
  type OrgScopeContext,
  type Tx,
} from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { TasksService } from '../tasks/tasks.service.js';
import type {
  AnalyzeDto,
  BatchDeleteDto,
  BatchOwnerDto,
  CreateContactDto,
  CreateCustomerDto,
  CustomerStage,
  GenerateOutreachDto,
  ListActivitiesQuery,
  ListContactsQuery,
  ListCustomersQuery,
  StageTransitionDto,
  UpdateContactDto,
  UpdateCustomerDto,
} from './customers.dto.js';

/**
 * 05 CRM 客户中心服务（接口 05 §3，M5-A4/B1）：
 * - 列表：tab(potential/formal) / keyword / country / stage / ownerId / overdueDays + scope 注入；
 * - 创建/编辑：ownerId 指派与转交仅 manager/admin（sales 越权 40301）；转交写 owner_change 活动；
 * - stage 流转：沿阶段机正向或回退 contacted（非法 40901），写 stage_change 活动留痕；
 * - B1 软删/batch-delete（锁定态走审批联动）/batch-owner/contacts/activities。
 */

/** 阶段机顺序（05 §3.2：正向 = 序号递增；仅允许回退到 contacted） */
const STAGE_INDEX: Record<CustomerStage, number> = {
  new_lead: 0,
  contacted: 1,
  negotiation: 2,
  cold: 3,
};

/** 04 §1.3 推荐动作 type 枚举（前端 Customer360NextAction 三值） */
const NEXT_ACTION_TYPES = ['contact_decision_maker', 'generate_outreach', 'send_quote'] as const;

/**
 * 归一化 AI 洞察 nextAction：DB 可能存流程内部语义（如 follow_up）→ 收敛到前端枚举，
 * 并补 targetId（主联系人）；无联系人时退化为「联系决策人」引导。
 */
function normalizeCustomer360NextAction(
  raw: { type: string; label: string; targetId?: string } | null,
  fallbackTargetId?: string,
): { type: string; label: string; targetId?: string } | null {
  if (!raw || !raw.label) return null;
  const targetId = raw.targetId ?? fallbackTargetId;
  const type = (NEXT_ACTION_TYPES as readonly string[]).includes(raw.type)
    ? raw.type
    : targetId
      ? 'generate_outreach'
      : 'contact_decision_maker';
  return { type, label: raw.label, ...(targetId ? { targetId } : {}) };
}

export interface CustomerListItem {
  customerId: string;
  companyName: string;
  stage: string;
  lastActivityAt: string | null;
  nextAction: { type: string; label: string; targetId?: string } | null;
  country: string;
  ownerId: string;
  /** 05 §1.1 负责人姓名（列表直出，编辑表单预填） */
  ownerName: string;
  industry: string | null;
  isFormal: boolean;
  customerType: string | null;
  website: string | null;
  remark: string | null;
  /** 05 §1.1 删除待审锁定态（审批拒绝自动解锁） */
  deleteLocked: boolean;
  createdAt: string;
  updatedAt: string;
  reactivateSuggestion: {
    reasons: { text: string; evidence?: string; source?: string }[];
    confidence: number;
  } | null;
}

/** 04 §3.1 客户详情（复用 05 §1.1 客户行口径 + 360° 头部 / Overview） */
export interface CustomerDetailView extends CustomerListItem {
  score: number | null;
  industryTags: string[];
  contactsCount: number;
  inCrm: boolean;
  overview: {
    companySize?: string;
    foundedYear?: number;
    customerType?: string;
    mainProducts?: string[];
    productMatches: unknown[];
  };
}

/**
 * 04 §3.1 lead 预览态（inCrm=false 的发现池 lead 作为 360° 数据源）。
 * 字段与 mock 契约一致（web/src/mocks/data/customers360.ts build360Profile 的 lead 分支）：
 * 仅公司信息 + 评分 + 标签 + Overview，不返回客户主数据子集（不可编辑/推进阶段/删除）。
 * productMatches 为 04 §1.2 选填项：产品目录表未落地前不返回（前端 `?? []` 降级为空）。
 */
export interface LeadPreviewView {
  customerId: string;
  companyName: string;
  score: number;
  country: string;
  website: string | null;
  industry: string | null;
  industryTags: string[];
  inCrm: false;
  overview: {
    customerType?: string;
    productMatches: unknown[];
  };
}

export interface ActivityItem {
  activityId: string;
  customerId: string;
  companyName: string;
  type: string;
  summary: string;
  operatorType: string;
  operatorName: string | null;
  createdAt: string;
  refType: string | null;
  refId: string | null;
}

/** 05 §1.3 联系人行（全局列表与 04 客户 360° 同源） */
export interface ContactListItem {
  contactId: string;
  name: string;
  title: string;
  email: string | null;
  customerId: string;
  companyName: string;
  decisionInfluencePct: number | null;
  decisionInfluenceReasons: { text: string; evidence?: string; source?: string }[];
  isPrimary: boolean;
}

/**
 * 时间戳归一化 → ISO 字符串。
 * 原始 SQL 聚合表达式（如 `select max(created_at) ...`）在 pg 驱动下以 string 返回，
 * 无法直接 `.toISOString()`，统一在此兜底。
 */
function toIso(value: Date | string | null | undefined, fallback: Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return fallback.toISOString();
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  /** 05 §3.1 客户列表（tab 区分潜在/正式 + 筛选 + scope 裁剪 + 分页） */
  async list(
    ctx: OrgScopeContext,
    query: ListCustomersQuery & { page: number; pageSize: number; keyword?: string },
  ): Promise<{ items: CustomerListItem[]; total: number; page: number; pageSize: number }> {
    const scope = resolveScope(ctx.role, ctx.scope);
    const lastActivityExpr = sql<Date | null>`(select max(${schema.customerActivity.createdAt}) from ${schema.customerActivity} where ${schema.customerActivity.customerId} = ${schema.customer.id})`;

    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conditions: (SQL | undefined)[] = [
        notDeleted(schema.customer.deletedAt),
        applyOwnerScope(schema.customer.ownerId, { ...ctx, scope }),
      ];
      if (query.tab === 'potential') {
        conditions.push(eq(schema.customer.isFormal, false));
      }
      if (query.tab === 'formal') {
        conditions.push(eq(schema.customer.isFormal, true));
      }
      if (query.country) {
        conditions.push(eq(schema.customer.country, query.country));
      }
      if (query.stage) {
        conditions.push(eq(schema.customer.stage, query.stage));
      }
      if (query.ownerId) {
        conditions.push(eq(schema.customer.ownerId, query.ownerId));
      }
      if (query.keyword) {
        conditions.push(ilike(schema.customer.companyName, `%${query.keyword}%`));
      }
      if (query.overdueDays !== undefined) {
        conditions.push(
          sql`coalesce(${lastActivityExpr}, ${schema.customer.createdAt}) < now() - make_interval(days => ${query.overdueDays})`,
        );
      }
      const where = scopeAnd(...conditions);

      const rows = await tx
        .select({
          customerId: schema.customer.id,
          companyName: schema.customer.companyName,
          stage: schema.customer.stage,
          nextAction: schema.customer.nextAction,
          country: schema.customer.country,
          ownerId: schema.customer.ownerId,
          ownerName: schema.userAccount.name,
          industry: schema.customer.industry,
          isFormal: schema.customer.isFormal,
          customerType: schema.customer.customerType,
          website: schema.customer.website,
          remark: schema.customer.remark,
          deleteLocked: schema.customer.deleteLocked,
          createdAt: schema.customer.createdAt,
          updatedAt: schema.customer.updatedAt,
          lastActivityAt: lastActivityExpr,
        })
        .from(schema.customer)
        .leftJoin(schema.userAccount, eq(schema.userAccount.id, schema.customer.ownerId))
        .where(where)
        .orderBy(desc(schema.customer.updatedAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.customer)
        .where(where);

      // Cold 客户的 AI 重新激活建议（customer_insight.insight_type='reactivation'，取最新）
      const reactivateByCustomer = new Map<
        string,
        { reasons: { text: string; evidence?: string; source?: string }[]; confidence: number }
      >();
      if (rows.length > 0) {
        const insights = await tx
          .select({
            customerId: schema.customerInsight.customerId,
            reasons: schema.customerInsight.reasons,
            confidence: schema.customerInsight.confidence,
            generatedAt: schema.customerInsight.generatedAt,
          })
          .from(schema.customerInsight)
          .where(
            and(
              eq(schema.customerInsight.orgId, ctx.orgId),
              eq(schema.customerInsight.insightType, 'reactivation'),
              inArray(
                schema.customerInsight.customerId,
                rows.map((r) => r.customerId),
              ),
            ),
          )
          .orderBy(desc(schema.customerInsight.generatedAt));
        for (const ins of insights) {
          if (!reactivateByCustomer.has(ins.customerId)) {
            reactivateByCustomer.set(ins.customerId, {
              reasons: ins.reasons,
              confidence: Number(ins.confidence ?? 0),
            });
          }
        }
      }

      return {
        items: rows.map((r) => ({
          customerId: r.customerId,
          companyName: r.companyName,
          stage: r.stage,
          lastActivityAt: toIso(r.lastActivityAt, r.createdAt),
          nextAction: r.nextAction ?? null,
          country: r.country,
          ownerId: r.ownerId,
          ownerName: r.ownerName ?? r.ownerId,
          industry: r.industry ?? null,
          isFormal: r.isFormal,
          customerType: r.customerType ?? null,
          website: r.website ?? null,
          remark: r.remark ?? null,
          deleteLocked: r.deleteLocked,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          reactivateSuggestion:
            r.stage === 'cold' ? (reactivateByCustomer.get(r.customerId) ?? null) : null,
        })),
        total: countRow?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 05 §1.2 添加客户（手工录入；ownerId 指派他人仅 manager/admin） */
  async create(
    ctx: OrgScopeContext,
    dto: CreateCustomerDto,
  ): Promise<{ customerId: string; stage: string; ownerId: string }> {
    const ownerId = dto.ownerId ?? ctx.userId;
    if (ownerId !== ctx.userId && ctx.role === 'sales') {
      throw new BizException(ErrorCode.FORBIDDEN, '负责人指派仅经理/管理员可操作');
    }

    return withOrg(this.db, ctx.orgId, async (tx) => {
      await this.assertOwnerExists(tx, ctx.orgId, ownerId);

      // 同名去重（uq_customer_org_name 软删范围内的唯一索引兜底竞态）
      const [dup] = await tx
        .select({ id: schema.customer.id })
        .from(schema.customer)
        .where(
          and(
            eq(schema.customer.orgId, ctx.orgId),
            sql`lower(${schema.customer.companyName}) = lower(${dto.companyName})`,
            notDeleted(schema.customer.deletedAt),
          ),
        )
        .limit(1);
      if (dup) {
        throw new BizException(ErrorCode.CONFLICT, '同名客户已存在');
      }

      const customerId = createId('cus');
      await tx.insert(schema.customer).values({
        id: customerId,
        orgId: ctx.orgId,
        companyName: dto.companyName,
        country: dto.country,
        website: dto.website ?? null,
        industry: dto.industry ?? null,
        customerType: dto.customerType ?? null,
        stage: dto.stage,
        isFormal: dto.isFormal,
        ownerId,
        remark: dto.remark ?? null,
        createdBy: ctx.userId,
      });

      if (dto.contacts && dto.contacts.length > 0) {
        // 05 §1.2 子表单联系人同样受 org 内邮箱唯一约束（批量内 + 库内预检，避免 50001）
        const seenEmails = new Set<string>();
        for (const c of dto.contacts) {
          if (!c.email) continue;
          const key = c.email.toLowerCase();
          if (seenEmails.has(key)) {
            throw BizException.conflict('该邮箱已被其他联系人使用');
          }
          seenEmails.add(key);
          await this.assertContactEmailUnique(tx, ctx.orgId, c.email);
        }
        await tx.insert(schema.contact).values(
          dto.contacts.map((c) => ({
            id: createId('cont'),
            orgId: ctx.orgId,
            customerId,
            name: c.name,
            title: c.title,
            email: c.email ?? null,
          })),
        );
      }

      return { customerId, stage: dto.stage, ownerId };
    });
  }

  /** 05 §2 编辑客户资料（改 ownerId 即转交：仅经理/管理员 + owner_change 活动留痕） */
  async update(
    ctx: OrgScopeContext,
    customerId: string,
    dto: UpdateCustomerDto,
  ): Promise<{ customerId: string; ownerId: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select()
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      const row = assertResourceAccess(raw, ctx);

      // 05 §3.3：删除待审锁定期间不可编辑（与 mock 口径一致）
      if (row.deleteLocked) {
        throw BizException.conflict('该客户删除审批处理中，锁定期间不可编辑');
      }

      const now = new Date();
      let ownerChanged = false;
      let newOwnerId = row.ownerId;

      if (dto.ownerId !== undefined && dto.ownerId !== row.ownerId) {
        if (ctx.role === 'sales') {
          throw new BizException(ErrorCode.FORBIDDEN, '客户转交仅经理/管理员可操作');
        }
        await this.assertOwnerExists(tx, ctx.orgId, dto.ownerId);
        ownerChanged = true;
        newOwnerId = dto.ownerId;

        const [oldOwner] = await tx
          .select({ name: schema.userAccount.name })
          .from(schema.userAccount)
          .where(eq(schema.userAccount.id, row.ownerId))
          .limit(1);
        const [newOwner] = await tx
          .select({ name: schema.userAccount.name })
          .from(schema.userAccount)
          .where(eq(schema.userAccount.id, dto.ownerId))
          .limit(1);
        const operatorName = await this.userName(tx, ctx.orgId, ctx.userId);
        await tx.insert(schema.customerActivity).values({
          id: createId('act'),
          orgId: ctx.orgId,
          customerId,
          type: 'owner_change',
          summary: `负责人变更：${oldOwner?.name ?? row.ownerId} → ${newOwner?.name ?? newOwnerId}`,
          operatorType: 'user',
          operatorId: ctx.userId,
          operatorName,
          refType: 'customer',
          refId: customerId,
        });
      }

      if (dto.companyName !== undefined && dto.companyName !== row.companyName) {
        const [dup] = await tx
          .select({ id: schema.customer.id })
          .from(schema.customer)
          .where(
            and(
              eq(schema.customer.orgId, ctx.orgId),
              sql`lower(${schema.customer.companyName}) = lower(${dto.companyName})`,
              notDeleted(schema.customer.deletedAt),
              sql`${schema.customer.id} <> ${customerId}`,
            ),
          )
          .limit(1);
        if (dup) {
          throw new BizException(ErrorCode.CONFLICT, '同名客户已存在');
        }
      }

      await tx
        .update(schema.customer)
        .set({
          ...(dto.companyName !== undefined && { companyName: dto.companyName }),
          ...(dto.country !== undefined && { country: dto.country }),
          ...(dto.website !== undefined && { website: dto.website }),
          ...(dto.industry !== undefined && { industry: dto.industry }),
          ...(dto.customerType !== undefined && { customerType: dto.customerType }),
          ...(dto.isFormal !== undefined && { isFormal: dto.isFormal }),
          ...(ownerChanged && { ownerId: newOwnerId }),
          ...(dto.remark !== undefined && { remark: dto.remark }),
          updatedAt: now,
        })
        .where(eq(schema.customer.id, customerId));

      return { customerId, ownerId: newOwnerId };
    });
  }

  /** 05 §3.2 阶段流转（正向或回退 contacted；非法 40901；写 stage_change 活动） */
  async stage(
    ctx: OrgScopeContext,
    customerId: string,
    dto: StageTransitionDto,
  ): Promise<{ customerId: string; stage: string; activityId: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          stage: schema.customer.stage,
          ownerId: schema.customer.ownerId,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      const row = assertResourceAccess(raw, ctx);

      const from = row.stage as CustomerStage;
      const to = dto.stage;
      if (to === from || !(STAGE_INDEX[to] > STAGE_INDEX[from] || to === 'contacted')) {
        throw new BizException(
          ErrorCode.CONFLICT,
          `非法阶段流转：${from} → ${to}（仅允许正向流转或回退 contacted）`,
        );
      }

      const now = new Date();
      await tx
        .update(schema.customer)
        .set({ stage: to, updatedAt: now })
        .where(eq(schema.customer.id, customerId));

      const activityId = createId('act');
      await tx.insert(schema.customerActivity).values({
        id: activityId,
        orgId: ctx.orgId,
        customerId,
        type: 'stage_change',
        summary: `阶段流转 ${from} → ${to}${dto.reason ? `：${dto.reason}` : ''}`,
        operatorType: 'user',
        operatorId: ctx.userId,
        operatorName: await this.userName(tx, ctx.orgId, ctx.userId),
        refType: 'customer',
        refId: customerId,
      });

      return { customerId, stage: to, activityId };
    });
  }

  // ===== B1-1 软删 / batch-delete =====

  /**
   * 05 §3.3 单条删除：**不直接删除**，生成 customer_delete（riskLevel=high，永远人工审）审批，
   * 客户进入「删除待审」锁定态（deleteLocked=true）；批准后由审核中心落 deletedAt，拒绝自动解锁。
   * 已锁定（已在待审）→ 40901（05 §3.5 计入 failed 口径）。
   */
  async delete(
    ctx: OrgScopeContext,
    customerId: string,
  ): Promise<{
    customerId: string;
    approvalId: string;
    approvalType: 'customer_delete';
    status: 'pending';
  }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select()
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      const row = assertResourceAccess(raw, ctx);

      if (row.deleteLocked) {
        throw BizException.conflict('客户已在删除待审中，请先在审核中心处置（05 §3.5）');
      }

      const now = new Date();
      await tx
        .update(schema.customer)
        .set({ deleteLocked: true, updatedAt: now })
        .where(eq(schema.customer.id, customerId));

      const approvalId = createId('appr');
      await tx.insert(schema.approvalRequest).values({
        id: approvalId,
        orgId: ctx.orgId,
        approvalType: 'customer_delete',
        riskLevel: 'high',
        title: `删除客户：${row.companyName}`,
        bizType: 'customer',
        bizId: customerId,
        context: {
          customerId,
          customerName: row.companyName,
          relatedCounts: await this.relatedCounts(tx, customerId),
          requestedBy: ctx.userId,
          requestedAt: now.toISOString(),
        },
        aiProposal: {},
        requestedByUserId: ctx.userId,
        expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      });

      return {
        customerId,
        approvalId,
        approvalType: 'customer_delete' as const,
        status: 'pending' as const,
      };
    });
  }

  /** 05 §3.5 批量删除：逐客户生成审批并锁定；已锁定/已删除客户计入 failed */
  async batchDelete(
    ctx: OrgScopeContext,
    dto: BatchDeleteDto,
  ): Promise<{
    approvals: { customerId: string; approvalId: string }[];
    failed: { customerId: string; reason: string }[];
  }> {
    if (ctx.role === 'sales') {
      throw new BizException(ErrorCode.FORBIDDEN, '批量删除仅经理/管理员可操作');
    }
    const approvals: { customerId: string; approvalId: string }[] = [];
    const failed: { customerId: string; reason: string }[] = [];
    for (const cid of dto.customerIds) {
      try {
        const r = await this.delete(ctx, cid);
        approvals.push({ customerId: r.customerId, approvalId: r.approvalId });
      } catch (err) {
        failed.push({ customerId: cid, reason: err instanceof Error ? err.message : '删除失败' });
      }
    }
    return { approvals, failed };
  }

  // ===== B1-2 batch-owner =====

  /** 05 §3.5 批量转交负责人（仅 manager/admin；逐客户写 owner_change 活动留痕） */
  async batchOwner(ctx: OrgScopeContext, dto: BatchOwnerDto): Promise<{ updated: number }> {
    if (ctx.role === 'sales') {
      throw new BizException(ErrorCode.FORBIDDEN, '批量转交仅经理/管理员可操作');
    }
    return withOrg(this.db, ctx.orgId, async (tx) => {
      await this.assertOwnerExists(tx, ctx.orgId, dto.ownerId);

      const rows = await tx
        .select()
        .from(schema.customer)
        .where(
          and(
            eq(schema.customer.orgId, ctx.orgId),
            inArray(schema.customer.id, dto.customerIds),
            notDeleted(schema.customer.deletedAt),
          ),
        );

      const now = new Date();
      let updated = 0;

      for (const row of rows) {
        if (row.ownerId === dto.ownerId) {
          continue;
        }
        // 转交前校验权限（sales 不可操作他人客户）
        assertResourceAccess(row, ctx);

        const [oldOwner] = await tx
          .select({ name: schema.userAccount.name })
          .from(schema.userAccount)
          .where(eq(schema.userAccount.id, row.ownerId))
          .limit(1);
        const [newOwner] = await tx
          .select({ name: schema.userAccount.name })
          .from(schema.userAccount)
          .where(eq(schema.userAccount.id, dto.ownerId))
          .limit(1);
        const operatorName = await this.userName(tx, ctx.orgId, ctx.userId);

        await tx
          .update(schema.customer)
          .set({ ownerId: dto.ownerId, updatedAt: now })
          .where(eq(schema.customer.id, row.id));

        await tx.insert(schema.customerActivity).values({
          id: createId('act'),
          orgId: ctx.orgId,
          customerId: row.id,
          type: 'owner_change',
          summary: `负责人变更：${oldOwner?.name ?? row.ownerId} → ${newOwner?.name ?? dto.ownerId}`,
          operatorType: 'user',
          operatorId: ctx.userId,
          operatorName,
          refType: 'customer',
          refId: row.id,
        });

        updated += 1;
      }

      return { updated };
    });
  }

  // ===== B1-3 contacts CRUD =====

  /** B1 §3 创建联系人（单条） */
  async createContact(
    ctx: OrgScopeContext,
    customerId: string,
    dto: CreateContactDto,
  ): Promise<{ contactId: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);
      await this.assertContactEmailUnique(tx, ctx.orgId, dto.email);

      const contactId = createId('cont');
      await tx.insert(schema.contact).values({
        id: contactId,
        orgId: ctx.orgId,
        customerId,
        name: dto.name,
        title: dto.title,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        isPrimary: dto.isPrimary,
      });
      return { contactId };
    });
  }

  /** B1 §3 编辑联系人 */
  async updateContact(
    ctx: OrgScopeContext,
    customerId: string,
    contactId: string,
    dto: UpdateContactDto,
  ): Promise<{ contactId: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);

      const [contact] = await tx
        .select()
        .from(schema.contact)
        .where(and(eq(schema.contact.id, contactId), eq(schema.contact.customerId, customerId)))
        .limit(1);
      if (!contact) {
        throw new BizException(ErrorCode.NOT_FOUND, '联系人不存在');
      }
      await this.assertContactEmailUnique(tx, ctx.orgId, dto.email, contactId);

      await tx
        .update(schema.contact)
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.isPrimary !== undefined && { isPrimary: dto.isPrimary }),
          updatedAt: new Date(),
        })
        .where(eq(schema.contact.id, contactId));

      return { contactId };
    });
  }

  /** B1 §3 删除单条联系人（不走审批） */
  async deleteContact(
    ctx: OrgScopeContext,
    customerId: string,
    contactId: string,
  ): Promise<{ contactId: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);

      const [contact] = await tx
        .select({ id: schema.contact.id })
        .from(schema.contact)
        .where(and(eq(schema.contact.id, contactId), eq(schema.contact.customerId, customerId)))
        .limit(1);
      if (!contact) {
        throw new BizException(ErrorCode.NOT_FOUND, '联系人不存在');
      }

      await tx.delete(schema.contact).where(eq(schema.contact.id, contactId));
      return { contactId };
    });
  }

  /** 05 §2 PUT /contacts/{id}：路径不含 customerId，按 contactId 反查归属后复用带客户校验的编辑逻辑 */
  async updateContactById(
    ctx: OrgScopeContext,
    contactId: string,
    dto: UpdateContactDto,
  ): Promise<{ contactId: string }> {
    const customerId = await this.resolveContactCustomerId(ctx, contactId);
    return this.updateContact(ctx, customerId, contactId, dto);
  }

  /** 05 §2 DELETE /contacts/{id}：同上；单条删除不走审批、不写客户活动 */
  async deleteContactById(ctx: OrgScopeContext, contactId: string): Promise<{ contactId: string }> {
    const customerId = await this.resolveContactCustomerId(ctx, contactId);
    return this.deleteContact(ctx, customerId, contactId);
  }

  /**
   * 05 §2 联系人邮箱 org 内唯一（ER uq_contact_org_email + mock 同口径，POST/PUT 一致）：
   * 显式预检返回 40901，避免依赖 DB 唯一约束抛出未捕获异常（50001）。
   */
  private async assertContactEmailUnique(
    tx: Tx,
    orgId: string,
    email: string | undefined,
    excludeContactId?: string,
  ): Promise<void> {
    if (!email) return;
    const conditions: (SQL | undefined)[] = [
      eq(schema.contact.orgId, orgId),
      sql`lower(${schema.contact.email}) = lower(${email})`,
    ];
    if (excludeContactId !== undefined) {
      conditions.push(ne(schema.contact.id, excludeContactId));
    }
    const [dup] = await tx
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(and(...conditions))
      .limit(1);
    if (dup) {
      throw BizException.conflict('该邮箱已被其他联系人使用');
    }
  }

  /** 按 contactId 反查所属客户（org 内）；不存在 → 404 */
  private async resolveContactCustomerId(ctx: OrgScopeContext, contactId: string): Promise<string> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [row] = await tx
        .select({ customerId: schema.contact.customerId })
        .from(schema.contact)
        .where(and(eq(schema.contact.id, contactId), eq(schema.contact.orgId, ctx.orgId)))
        .limit(1);
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, '联系人不存在');
      }
      return row.customerId;
    });
  }

  /** 05 §2 GET /contacts 全局联系人列表（scope 按所属客户 owner 裁剪 + keyword 命中姓名/邮箱/公司名 + 分页） */
  async listContacts(
    ctx: OrgScopeContext,
    query: ListContactsQuery & { page: number; pageSize: number },
  ): Promise<{ items: ContactListItem[]; total: number; page: number; pageSize: number }> {
    const scope = resolveScope(ctx.role, ctx.scope);
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conditions: (SQL | undefined)[] = [
        eq(schema.contact.orgId, ctx.orgId),
        notDeleted(schema.customer.deletedAt),
        applyOwnerScope(schema.customer.ownerId, { ...ctx, scope }),
      ];
      if (query.keyword) {
        const kw = `%${query.keyword}%`;
        conditions.push(
          or(
            ilike(schema.contact.name, kw),
            ilike(schema.contact.email, kw),
            ilike(schema.customer.companyName, kw),
          ),
        );
      }
      const where = and(...conditions);

      const rows = await tx
        .select({
          contactId: schema.contact.id,
          name: schema.contact.name,
          title: schema.contact.title,
          email: schema.contact.email,
          customerId: schema.contact.customerId,
          companyName: schema.customer.companyName,
          decisionInfluencePct: schema.contact.decisionInfluencePct,
          decisionInfluenceReasons: schema.contact.decisionInfluenceReasons,
          isPrimary: schema.contact.isPrimary,
        })
        .from(schema.contact)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.contact.customerId))
        .where(where)
        .orderBy(desc(schema.contact.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.contact)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.contact.customerId))
        .where(where);

      return {
        items: rows,
        total: countRow?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  // ===== B1-4 activities 全局列表 =====

  /** B1 §4 活动全局列表（refType+refId 跳转语义 + type 筛选 + 分页） */
  async listActivities(
    ctx: OrgScopeContext,
    query: ListActivitiesQuery & { page: number; pageSize: number },
  ): Promise<{ items: ActivityItem[]; total: number; page: number; pageSize: number }> {
    const scope = resolveScope(ctx.role, ctx.scope);
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conditions: SQL[] = [eq(schema.customerActivity.orgId, ctx.orgId)];
      if (query.customerId) {
        conditions.push(eq(schema.customerActivity.customerId, query.customerId));
      }
      if (query.refType) {
        conditions.push(eq(schema.customerActivity.refType, query.refType));
      }
      if (query.refId) {
        conditions.push(eq(schema.customerActivity.refId, query.refId));
      }
      if (query.type) {
        conditions.push(eq(schema.customerActivity.type, query.type));
      }
      if (query.operatorType) {
        conditions.push(eq(schema.customerActivity.operatorType, query.operatorType));
      }
      if (query.startDate) {
        conditions.push(gte(schema.customerActivity.createdAt, new Date(query.startDate)));
      }
      if (query.endDate) {
        // 闭区间：endDate 当天的 23:59:59.999（与 mock 口径一致）
        conditions.push(
          lte(schema.customerActivity.createdAt, new Date(`${query.endDate}T23:59:59.999Z`)),
        );
      }

      // scope 注入：通过 customer.ownerId 过滤
      const scopeCond = applyOwnerScope(schema.customer.ownerId, { ...ctx, scope });
      if (scopeCond) {
        conditions.push(scopeCond);
      }

      const where = and(...conditions);

      const rows = await tx
        .select({
          activityId: schema.customerActivity.id,
          customerId: schema.customerActivity.customerId,
          companyName: schema.customer.companyName,
          type: schema.customerActivity.type,
          summary: schema.customerActivity.summary,
          operatorType: schema.customerActivity.operatorType,
          operatorName: schema.customerActivity.operatorName,
          createdAt: schema.customerActivity.createdAt,
          refType: schema.customerActivity.refType,
          refId: schema.customerActivity.refId,
        })
        .from(schema.customerActivity)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.customerActivity.customerId))
        .where(where)
        .orderBy(desc(schema.customerActivity.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.customerActivity)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.customerActivity.customerId))
        .where(where);

      return {
        items: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
        })),
        total: countRow?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  // ===== B3 04 客户360° =====

  /**
   * B3 §3.1 GET /customers/{id} 头部 + Overview（含 productMatches）。
   * 04 §3.1 双数据源：入参可传 customerId 或 leadId（获客发现列表「查看详情」直达 360°），
   * 此前仅按 customer 表查询 → lead 入口恒 40401。
   */
  async detail(
    ctx: OrgScopeContext,
    entityId: string,
  ): Promise<CustomerDetailView | LeadPreviewView> {
    const ref = await this.resolve360Entity(ctx, entityId);
    if (!ref) {
      throw new BizException(ErrorCode.NOT_FOUND, '资源不存在');
    }
    return ref.kind === 'customer'
      ? this.buildCustomerDetail(ctx, ref.key)
      : this.buildLeadPreview(ctx, ref.key);
  }

  /**
   * 04 §3.1 入口 id 解析（与 mock resolve360Entity 同口径）：
   * customerId 命中 → 客户档案；否则按 leadId 查发现池，
   * 已转化（inCrm）的 lead 归并到其归属客户，未转化则走预览态。
   */
  private async resolve360Entity(
    ctx: OrgScopeContext,
    raw: string,
  ): Promise<{ kind: 'customer' | 'lead'; key: string } | null> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [customer] = await tx
        .select({ id: schema.customer.id })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, raw), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      if (customer) {
        return { kind: 'customer' as const, key: customer.id };
      }

      const [lead] = await tx
        .select({
          id: schema.aiLead.id,
          inCrm: schema.aiLead.inCrm,
          convertedCustomerId: schema.aiLead.convertedCustomerId,
        })
        .from(schema.aiLead)
        .where(and(eq(schema.aiLead.id, raw), eq(schema.aiLead.orgId, ctx.orgId)))
        .limit(1);
      if (!lead) return null;
      if (lead.inCrm && lead.convertedCustomerId) {
        return { kind: 'customer' as const, key: lead.convertedCustomerId };
      }
      return { kind: 'lead' as const, key: lead.id };
    });
  }

  /** 04 §3.1 lead 预览态：发现池 lead 的 360° 头部 / Overview 数据（只读，无客户主数据子集） */
  private async buildLeadPreview(ctx: OrgScopeContext, leadId: string): Promise<LeadPreviewView> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [lead] = await tx
        .select()
        .from(schema.aiLead)
        .where(and(eq(schema.aiLead.id, leadId), eq(schema.aiLead.orgId, ctx.orgId)))
        .limit(1);
      if (!lead) {
        throw new BizException(ErrorCode.NOT_FOUND, '资源不存在');
      }
      return {
        customerId: lead.id,
        companyName: lead.companyName,
        score: lead.matchPct,
        country: lead.country,
        website: lead.website,
        industry: lead.industry ?? null,
        industryTags: lead.industry ? [lead.industry] : [],
        inCrm: false,
        overview: { productMatches: [] },
      };
    });
  }

  /** B3 §3.1 客户档案详情（customerId 命中路径；sales 越权经 assertResourceAccess → 40301） */
  private async buildCustomerDetail(
    ctx: OrgScopeContext,
    customerId: string,
  ): Promise<CustomerDetailView> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select()
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      const row = assertResourceAccess(raw, ctx);

      const [owner] = await tx
        .select({ name: schema.userAccount.name })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.id, row.ownerId))
        .limit(1);
      const [contactsCountRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.contact)
        .where(eq(schema.contact.customerId, customerId));
      const [lastAct] = await tx
        .select({ at: sql<Date | null>`max(${schema.customerActivity.createdAt})` })
        .from(schema.customerActivity)
        .where(eq(schema.customerActivity.customerId, customerId));

      return {
        customerId: row.id,
        companyName: row.companyName,
        score: row.score,
        country: row.country,
        website: row.website,
        industry: row.industry ?? null,
        industryTags: row.industryTags ?? [],
        stage: row.stage,
        isFormal: row.isFormal,
        ownerId: row.ownerId,
        ownerName: owner?.name ?? row.ownerId,
        customerType: row.customerType ?? null,
        remark: row.remark ?? null,
        // 05 §1.1 编辑表单锁定态（04 §3.1 复用同客户行口径）
        deleteLocked: row.deleteLocked,
        contactsCount: contactsCountRow?.n ?? 0,
        lastActivityAt: toIso(lastAct?.at, row.createdAt),
        nextAction: row.nextAction ?? null,
        reactivateSuggestion: null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        inCrm: true,
        overview: {
          companySize: undefined,
          foundedYear: undefined,
          customerType: row.customerType ?? undefined,
          mainProducts: undefined,
          productMatches: [],
        },
      };
    });
  }

  /** B3 §3.3 POST /customers/{id}/analyze 触发 AI 分析（异步 → product_analysis 任务） */
  async analyze(
    ctx: OrgScopeContext,
    customerId: string,
    dto: AnalyzeDto,
  ): Promise<{ taskId: string }> {
    // 确认客户存在
    await withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({ id: schema.customer.id, ownerId: schema.customer.ownerId })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);
    });

    // 查找可用 AI 员工
    let employeeId = '';
    await withOrg(this.db, ctx.orgId, async (tx) => {
      const [employee] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(
          and(
            eq(schema.aiEmployee.orgId, ctx.orgId),
            eq(schema.aiEmployee.role, 'customer_researcher'),
          ),
        )
        .limit(1);
      if (!employee) {
        throw new BizException(ErrorCode.NOT_FOUND, '未找到可用 AI 员工（customer_researcher）');
      }
      employeeId = employee.id;
    });

    return this.tasks.create(ctx.orgId, ctx.userId, {
      employeeId,
      type: 'product_analysis',
      title: `分析客户：${customerId}`,
      input: { customerId, scope: dto.scope, action: 'analyze' },
    });
  }

  /**
   * B3 §3.2 GET /customers/{id}/insights AI 客户洞察。
   * 响应契约（04 §3.2 / web Customer360Insight）：`{ purchaseProbability, nextAction }`。
   * 数据源 customer_insight（product_analysis 写回；uq_customer_insight_type 每类型单行）；
   * 无 purchase_probability 行 → 双 null（前端引导「重新分析」空态）。
   */
  async insights(
    ctx: OrgScopeContext,
    customerId: string,
  ): Promise<{
    purchaseProbability: {
      value: number;
      confidence: number;
      reasons: { text: string; evidence?: string; source?: string }[];
      citations: { docId: string; chunkId?: string }[];
      generatedAt: string;
    } | null;
    nextAction: { type: string; label: string; targetId?: string } | null;
  }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({ id: schema.customer.id, ownerId: schema.customer.ownerId })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);

      const [row] = await tx
        .select()
        .from(schema.customerInsight)
        .where(
          and(
            eq(schema.customerInsight.customerId, customerId),
            eq(schema.customerInsight.orgId, ctx.orgId),
            eq(schema.customerInsight.insightType, 'purchase_probability'),
          ),
        )
        .limit(1);

      if (!row) {
        return { purchaseProbability: null, nextAction: null };
      }

      // targetId 兜底主联系人（04 §1.3：推荐动作点击执行 → 联系决策人 / 生成开发信）
      const [primaryContact] = await tx
        .select({ id: schema.contact.id })
        .from(schema.contact)
        .where(and(eq(schema.contact.customerId, customerId), eq(schema.contact.orgId, ctx.orgId)))
        .orderBy(desc(schema.contact.isPrimary), desc(schema.contact.createdAt))
        .limit(1);

      return {
        purchaseProbability: {
          value: row.value === null ? 0 : Number(row.value),
          confidence: row.confidence === null ? 0 : Number(row.confidence),
          reasons: row.reasons ?? [],
          citations: row.citations ?? [],
          generatedAt: row.generatedAt.toISOString(),
        },
        nextAction: normalizeCustomer360NextAction(row.nextAction ?? null, primaryContact?.id),
      };
    });
  }

  /**
   * B3 GET /customers/{id}/products 产品匹配列表（04 §1.5 Products 页签；D7 行内抽屉）。
   * 产品目录表未落地前（08 产品中心 P1）复用 detail.overview.productMatches 口径 → 返回 []。
   */
  async listCustomerProducts(ctx: OrgScopeContext, customerId: string): Promise<unknown[]> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);
      return [];
    });
  }

  /** B3 GET /customers/{id}/contacts 联系人列表 */
  async listCustomerContacts(
    ctx: OrgScopeContext,
    customerId: string,
    page: number,
    pageSize: number,
  ) {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          companyName: schema.customer.companyName,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);

      const rows = await tx
        .select()
        .from(schema.contact)
        .where(and(eq(schema.contact.customerId, customerId), eq(schema.contact.orgId, ctx.orgId)))
        .orderBy(desc(schema.contact.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.contact)
        .where(and(eq(schema.contact.customerId, customerId), eq(schema.contact.orgId, ctx.orgId)));

      return {
        items: rows.map((r) => ({
          contactId: r.id,
          customerId: r.customerId,
          companyName: raw?.companyName ?? '',
          name: r.name,
          title: r.title,
          email: r.email,
          phone: r.phone,
          decisionInfluencePct: r.decisionInfluencePct,
          decisionInfluenceReasons: r.decisionInfluenceReasons,
          isPrimary: r.isPrimary,
        })),
        total: countRow?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  /** B3 GET /customers/{id}/conversations 会话列表 */
  async listCustomerConversations(
    ctx: OrgScopeContext,
    customerId: string,
    page: number,
    pageSize: number,
  ) {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);

      const rows = await tx
        .select({
          conversationId: schema.conversation.id,
          channel: schema.conversation.channel,
          subject: schema.conversation.subject,
          lastMessageAt: schema.conversation.lastMessageAt,
          unreadCount: schema.conversation.unreadCount,
        })
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.customerId, customerId),
            eq(schema.conversation.orgId, ctx.orgId),
          ),
        )
        .orderBy(desc(schema.conversation.lastMessageAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.customerId, customerId),
            eq(schema.conversation.orgId, ctx.orgId),
          ),
        );

      return {
        items: rows.map((r) => ({
          conversationId: r.conversationId,
          channel: r.channel,
          subject: r.subject,
          lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
          unreadCount: r.unreadCount,
        })),
        total: countRow?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  /** B3 GET /customers/{id}/quotes 历史报价（D6 降级 → 未启用） */
  async listCustomerQuotes(
    _ctx: OrgScopeContext,
    _customerId: string,
    page: number,
    pageSize: number,
  ) {
    return {
      items: [],
      total: 0,
      page,
      pageSize,
      disabled: true,
      message: '报价中心模块未启用（D6 降级）',
    };
  }

  /** B3 GET /customers/{id}/orders 历史订单（D6 降级 → 未启用） */
  async listCustomerOrders(
    _ctx: OrgScopeContext,
    _customerId: string,
    page: number,
    pageSize: number,
  ) {
    return {
      items: [],
      total: 0,
      page,
      pageSize,
      disabled: true,
      message: '订单中心模块未启用（D6 降级）',
    };
  }

  /** B3 GET /customers/{id}/activities 活动时间线 */
  async listCustomerActivities(
    ctx: OrgScopeContext,
    customerId: string,
    page: number,
    pageSize: number,
  ) {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select({
          id: schema.customer.id,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);

      const rows = await tx
        .select()
        .from(schema.customerActivity)
        .where(
          and(
            eq(schema.customerActivity.customerId, customerId),
            eq(schema.customerActivity.orgId, ctx.orgId),
          ),
        )
        .orderBy(desc(schema.customerActivity.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.customerActivity)
        .where(
          and(
            eq(schema.customerActivity.customerId, customerId),
            eq(schema.customerActivity.orgId, ctx.orgId),
          ),
        );

      return {
        items: rows.map((r) => ({
          activityId: r.id,
          type: r.type,
          summary: r.summary,
          operatorType: r.operatorType,
          operatorName: r.operatorName,
          refType: r.refType,
          refId: r.refId,
          createdAt: r.createdAt.toISOString(),
        })),
        total: countRow?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  /** B3 §3.4 POST /contacts/{id}/generate-outreach AI 生成开发信（产出草稿） */
  async generateOutreach(
    ctx: OrgScopeContext,
    contactId: string,
    dto: GenerateOutreachDto,
  ): Promise<{ draftId: string; conversationId: string; content: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      // 查找联系人
      const [contact] = await tx
        .select()
        .from(schema.contact)
        .where(and(eq(schema.contact.id, contactId), eq(schema.contact.orgId, ctx.orgId)))
        .limit(1);
      if (!contact) {
        throw new BizException(ErrorCode.NOT_FOUND, '联系人不存在');
      }

      const [raw] = await tx
        .select({
          id: schema.customer.id,
          ownerId: schema.customer.ownerId,
          deletedAt: schema.customer.deletedAt,
        })
        .from(schema.customer)
        .where(
          and(eq(schema.customer.id, contact.customerId), notDeleted(schema.customer.deletedAt)),
        )
        .limit(1);
      assertResourceAccess(raw, ctx);

      // 查找已有会话或创建新 outbound 会话
      const [existingConv] = await tx
        .select({ id: schema.conversation.id })
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.customerId, contact.customerId),
            eq(schema.conversation.contactId, contactId),
            eq(schema.conversation.orgId, ctx.orgId),
          ),
        )
        .limit(1);

      let conversationId = existingConv?.id ?? '';
      if (!conversationId) {
        conversationId = createId('conv');
        const now = new Date();
        await tx.insert(schema.conversation).values({
          id: conversationId,
          orgId: ctx.orgId,
          customerId: contact.customerId,
          contactId,
          channel: 'email',
          subject: dto.scenario === 'cold_outreach' ? '业务合作探讨' : '关于报价的跟进',
          priority: 'high',
          unreadCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      // 创建草稿消息
      const draftId = createId('msg');
      const content =
        dto.language === 'en'
          ? `Dear ${contact.name},\n\nWe are pleased to reach out to you regarding potential business cooperation.\n\nBest regards,\n${ctx.userId}`
          : `尊敬的 ${contact.name}，\n\n很高兴与您联系，期待探讨业务合作机会。\n\n此致\n敬礼`;

      await tx.insert(schema.message).values({
        id: draftId,
        orgId: ctx.orgId,
        conversationId,
        direction: 'out',
        senderType: 'user',
        senderName: ctx.userId,
        content,
        language: dto.language,
        status: 'draft',
        sentAt: new Date(),
        createdAt: new Date(),
      });

      return { draftId, conversationId, content };
    });
  }

  // ===== helpers =====

  /** 负责人必须在同 org 内（user_account.org_id） */
  private async assertOwnerExists(tx: Tx, orgId: string, ownerId: string): Promise<void> {
    const [owner] = await tx
      .select({ id: schema.userAccount.id })
      .from(schema.userAccount)
      .where(and(eq(schema.userAccount.id, ownerId), eq(schema.userAccount.orgId, orgId)))
      .limit(1);
    if (!owner) {
      throw new BizException(ErrorCode.NOT_FOUND, `负责人不存在: ${ownerId}`);
    }
  }

  private async userName(tx: Tx, orgId: string, userId: string): Promise<string> {
    const [row] = await tx
      .select({ name: schema.userAccount.name })
      .from(schema.userAccount)
      .where(and(eq(schema.userAccount.id, userId), eq(schema.userAccount.orgId, orgId)))
      .limit(1);
    return row?.name ?? userId;
  }

  /** 客户关联资源计数（customer_delete 审批上下文，12 §1.3 relatedCounts） */
  private async relatedCounts(
    tx: Tx,
    customerId: string,
  ): Promise<{ quotes: number; orders: number }> {
    const [quotes] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.quotation)
      .where(eq(schema.quotation.customerId, customerId));
    const [orders] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.customerId, customerId));
    return { quotes: quotes?.n ?? 0, orders: orders?.n ?? 0 };
  }
}
