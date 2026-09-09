import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
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
import type {
  BatchDeleteDto,
  BatchOwnerDto,
  CreateContactDto,
  CreateCustomerDto,
  CustomerStage,
  ListActivitiesQuery,
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

export interface CustomerListItem {
  customerId: string;
  companyName: string;
  stage: string;
  lastActivityAt: string | null;
  nextAction: { type: string; label: string; targetId?: string } | null;
  country: string;
  ownerId: string;
  reactivateSuggestion: { reasons: { text: string; evidence?: string; source?: string }[]; confidence: number } | null;
}

export interface ActivityItem {
  activityId: string;
  customerId: string;
  companyName: string;
  type: string;
  summary: string;
  operatorName: string | null;
  createdAt: string;
  refType: string | null;
  refId: string | null;
}

@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: Db) {}

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
          createdAt: schema.customer.createdAt,
          lastActivityAt: lastActivityExpr,
        })
        .from(schema.customer)
        .where(where)
        .orderBy(desc(schema.customer.updatedAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.customer)
        .where(where);

      // Cold 客户的 AI 重新激活建议（customer_insight.insight_type='reactivation'，取最新）
      const reactivateByCustomer = new Map<string, { reasons: { text: string; evidence?: string; source?: string }[]; confidence: number }>();
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
          lastActivityAt: (r.lastActivityAt ?? r.createdAt).toISOString(),
          nextAction: r.nextAction ?? null,
          country: r.country,
          ownerId: r.ownerId,
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
        .select({ id: schema.customer.id, stage: schema.customer.stage, ownerId: schema.customer.ownerId })
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

  /** B1 §1 单条软删：锁定态走审批，非锁定态直接删 */
  async delete(ctx: OrgScopeContext, customerId: string): Promise<{ customerId: string; approvalId?: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [raw] = await tx
        .select()
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      const row = assertResourceAccess(raw, ctx);

      const now = new Date();
      await tx
        .update(schema.customer)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.customer.id, customerId));

      let approvalId: string | undefined;
      if (row.deleteLocked) {
        approvalId = createId('appr');
        const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
        await tx.insert(schema.approvalRequest).values({
          id: approvalId,
          orgId: ctx.orgId,
          approvalType: 'customer_delete',
          riskLevel: 'medium',
          title: `删除客户：${row.companyName}`,
          bizType: 'customer',
          bizId: customerId,
          context: { companyName: row.companyName, deletedBy: ctx.userId, deletedAt: now.toISOString() },
          aiProposal: {},
          requestedByUserId: ctx.userId,
          expiresAt,
        });
      }

      return { customerId, approvalId };
    });
  }

  /** B1 §1 批量删除（逐客户走 delete 逻辑） */
  async batchDelete(
    ctx: OrgScopeContext,
    dto: BatchDeleteDto,
  ): Promise<{ results: { customerId: string; approvalId?: string }[] }> {
    if (ctx.role === 'sales') {
      throw new BizException(ErrorCode.FORBIDDEN, '批量删除仅经理/管理员可操作');
    }
    const results: { customerId: string; approvalId?: string }[] = [];
    for (const cid of dto.customerIds) {
      try {
        const r = await this.delete(ctx, cid);
        results.push(r);
      } catch {
        results.push({ customerId: cid });
      }
    }
    return { results };
  }

  // ===== B1-2 batch-owner =====

  /** B1 §2 批量转交负责人（仅 manager/admin；逐客户写 owner_change 活动） */
  async batchOwner(
    ctx: OrgScopeContext,
    dto: BatchOwnerDto,
  ): Promise<{ results: { customerId: string; ownerId: string }[] }> {
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
      const results: { customerId: string; ownerId: string }[] = [];

      for (const row of rows) {
        if (row.ownerId === dto.ownerId) {
          results.push({ customerId: row.id, ownerId: dto.ownerId });
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

        results.push({ customerId: row.id, ownerId: dto.ownerId });
      }

      return { results };
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
        .select({ id: schema.customer.id, ownerId: schema.customer.ownerId, deletedAt: schema.customer.deletedAt })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
        .limit(1);
      assertResourceAccess(raw, ctx);

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
        .select({ id: schema.customer.id, ownerId: schema.customer.ownerId, deletedAt: schema.customer.deletedAt })
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
        .select({ id: schema.customer.id, ownerId: schema.customer.ownerId, deletedAt: schema.customer.deletedAt })
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

  // ===== B1-4 activities 全局列表 =====

  /** B1 §4 活动全局列表（refType+refId 跳转语义 + type 筛选 + 分页） */
  async listActivities(
    ctx: OrgScopeContext,
    query: ListActivitiesQuery & { page: number; pageSize: number },
  ): Promise<{ items: ActivityItem[]; total: number; page: number; pageSize: number }> {
    const scope = resolveScope(ctx.role, ctx.scope);
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conditions: SQL[] = [
        eq(schema.customerActivity.orgId, ctx.orgId),
      ];
      if (query.refType) {
        conditions.push(eq(schema.customerActivity.refType, query.refType));
      }
      if (query.refId) {
        conditions.push(eq(schema.customerActivity.refId, query.refId));
      }
      if (query.type) {
        conditions.push(eq(schema.customerActivity.type, query.type));
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
}