import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  BizException,
  COST_ITEM_KEYS,
  EMPTY_ORDER_PROGRESS,
  amountToScaledBigInt,
  computeOrderRisk,
  computeUnitCosts,
  createId,
  deriveOrderStatus,
  mergeCostSnapshot,
  normalizeAmount,
  normalizeOrderProgress,
  scaledToAmount,
  type CostItemKey,
  type CostSnapshot,
  type OrderProgress,
  type OrderRiskAssessment,
  type OrderRiskSuggestion,
  type OrderStatus,
} from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import { TaskEnqueuer } from '@tradepilot/runtime';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import { SettingsService, type PricingRulesView } from '../settings/settings.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import type {
  CreateOrderDto,
  ExecuteOrderRiskDto,
  ListOrdersQueryDto,
  OrderItemDto,
  UpdateOrderDto,
  UpdateOrderProgressDto,
} from './orders.dto.js';

/** order_change 审批缺省超时（10 FR-03；16 role_permission.approval_rules 未配置时回落 48h） */
const DEFAULT_APPROVAL_TTL_HOURS = 48;

/** 状态中文标签（进度流水 note / 通知文案） */
const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: '待付款',
  in_production: '生产中',
  ready_to_ship: '待发货',
  completed: '已完成',
};

/** 明细行（核算后的落库形态） */
interface ResolvedOrderLine {
  seq: number;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  costSnapshot: CostSnapshot;
}

interface ProductRow {
  id: string;
  name: string;
  costPrice: string;
  currency: string;
}

/** 变更审批 context（approvals 侧按此落库，10 FR-03） */
export interface OrderChangeContext {
  orderId: string;
  orderNo: string;
  before: { deliveryDate: string; amount: string };
  changes: {
    deliveryDate?: string;
    amount?: string;
    items?: {
      seq: number;
      productId: string;
      productName: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
      costSnapshot: Record<string, number>;
    }[];
  };
}

/**
 * 订单中心服务（接口 10 §2/§3 / 需求 10）：
 * - 读：列表（状态 Tab + 客户 + 风险筛选，附 Tab/风险计数）+ 详情（头/进度/明细/风险/变更中审批）；
 * - 建单：fromQuoteId 转单（前置报价 state=won 且未转过单）或手工建单（定价引擎核算成本快照）；
 * - 变更：交期/金额/数量一律生成 order_change 高危审批（10 FR-03），审批通过由 12 审核中心落库；
 * - 进度：四要素部分更新 → 状态确定性推导（决策 A3）→ 写 order_progress_log；
 * - 风险：规则引擎（时间线性计划进度，planSource=linear_by_time，决策 A4）判定 at_risk，
 *   自动产出 order_risk_insight 并回写 sales_order.risk；LLM 仅覆盖原因表达与建议文案（10 §4）。
 */
@Injectable()
export class OrdersService {
  private readonly enqueuer: TaskEnqueuer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(EnvService) env: EnvService,
  ) {
    this.enqueuer = new TaskEnqueuer(env.env.REDIS_URL);
  }

  // ===== 列表 / 详情 =====

  /** 10 §1.1/§2 订单列表（状态 Tab + 客户 + 风险筛选，附状态/风险计数） */
  async list(
    orgId: string,
    query: ListOrdersQueryDto & { page: number; pageSize: number },
  ): Promise<{
    items: {
      orderId: string;
      orderNo: string;
      customerId: string;
      customerName: string;
      amount: string;
      currency: string;
      status: string;
      risk: string;
      deliveryDate: string;
      createdAt: string;
    }[];
    total: number;
    page: number;
    pageSize: number;
    counts: Record<string, number>;
    riskCounts: Record<string, number>;
  }> {
    return withOrg(this.db, orgId, async (tx) => {
      const status = resolveStatusFilter(query);
      const conds = [eq(schema.salesOrder.orgId, orgId)];
      if (status) {
        conds.push(eq(schema.salesOrder.status, status));
      }
      if (query.customerId) {
        conds.push(eq(schema.salesOrder.customerId, query.customerId));
      }
      if (query.risk) {
        conds.push(eq(schema.salesOrder.risk, query.risk));
      }
      const where = and(...conds);
      const rows = await tx
        .select({
          id: schema.salesOrder.id,
          orderNo: schema.salesOrder.orderNo,
          customerId: schema.salesOrder.customerId,
          customerName: schema.customer.companyName,
          amount: schema.salesOrder.amount,
          currency: schema.salesOrder.currency,
          status: schema.salesOrder.status,
          risk: schema.salesOrder.risk,
          deliveryDate: schema.salesOrder.deliveryDate,
          createdAt: schema.salesOrder.createdAt,
        })
        .from(schema.salesOrder)
        .leftJoin(schema.customer, eq(schema.customer.id, schema.salesOrder.customerId))
        .where(where)
        .orderBy(desc(schema.salesOrder.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await tx.select({ n: count() }).from(schema.salesOrder).where(where);
      const counts = await this.tabCounts(tx, orgId);
      const riskCounts = await this.riskCounts(tx, orgId);
      return {
        items: rows.map((r) => ({
          orderId: r.id,
          orderNo: r.orderNo,
          customerId: r.customerId,
          customerName: r.customerName ?? '—',
          amount: normalizeAmount(r.amount, 2),
          currency: r.currency,
          status: r.status,
          risk: r.risk,
          deliveryDate: r.deliveryDate,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(total?.n ?? 0),
        page: query.page,
        pageSize: query.pageSize,
        counts,
        riskCounts,
      };
    });
  }

  /** 10 §1.1 各档 Tab 数量（all + 四状态） */
  async summary(orgId: string): Promise<{
    tabs: { status: string; count: number }[];
    risks: { risk: string; count: number }[];
  }> {
    return withOrg(this.db, orgId, async (tx) => {
      const counts = await this.tabCounts(tx, orgId);
      const riskCounts = await this.riskCounts(tx, orgId);
      return {
        tabs: ['all', 'pending_payment', 'in_production', 'ready_to_ship', 'completed'].map(
          (status) => ({ status, count: counts[status] ?? 0 }),
        ),
        risks: [
          { risk: 'normal', count: riskCounts.normal ?? 0 },
          { risk: 'at_risk', count: riskCounts.at_risk ?? 0 },
        ],
      };
    });
  }

  /** 10 §1.2 订单详情（头 + 进度四要素 + 明细行 + 风险洞察 + 变更中审批） */
  async detail(orgId: string, orderId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const order = await this.getOrderOrThrow(tx, orgId, orderId);
      const [customer] = await tx
        .select({
          companyName: schema.customer.companyName,
          country: schema.customer.country,
          isFormal: schema.customer.isFormal,
        })
        .from(schema.customer)
        .where(eq(schema.customer.id, order.customerId))
        .limit(1);
      const [contact] = order.contactId
        ? await tx
            .select({ name: schema.contact.name, email: schema.contact.email })
            .from(schema.contact)
            .where(eq(schema.contact.id, order.contactId))
            .limit(1)
        : [undefined];
      const [owner] = await tx
        .select({ name: schema.userAccount.name })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.id, order.ownerId))
        .limit(1);
      const items = await this.loadItems(tx, orderId);
      const progress = normalizeOrderProgress(order);
      const assessment = computeOrderRisk({
        createdAt: order.createdAt,
        deliveryDate: order.deliveryDate,
        progress,
      });
      const [insight] = await tx
        .select()
        .from(schema.orderRiskInsight)
        .where(
          and(
            eq(schema.orderRiskInsight.salesOrderId, orderId),
            eq(schema.orderRiskInsight.status, 'active'),
          ),
        )
        .orderBy(desc(schema.orderRiskInsight.generatedAt))
        .limit(1);
      const [pendingChange] = await tx
        .select({
          approvalId: schema.approvalRequest.id,
          title: schema.approvalRequest.title,
          status: schema.approvalRequest.status,
          createdAt: schema.approvalRequest.createdAt,
        })
        .from(schema.approvalRequest)
        .where(
          and(
            eq(schema.approvalRequest.orgId, orgId),
            eq(schema.approvalRequest.approvalType, 'order_change'),
            eq(schema.approvalRequest.bizType, 'sales_order'),
            eq(schema.approvalRequest.bizId, orderId),
            eq(schema.approvalRequest.status, 'pending'),
          ),
        )
        .orderBy(desc(schema.approvalRequest.createdAt))
        .limit(1);
      const timeline = await tx
        .select({
          id: schema.orderProgressLog.id,
          productionPct: schema.orderProgressLog.productionPct,
          note: schema.orderProgressLog.note,
          createdAt: schema.orderProgressLog.createdAt,
        })
        .from(schema.orderProgressLog)
        .where(eq(schema.orderProgressLog.salesOrderId, orderId))
        .orderBy(desc(schema.orderProgressLog.createdAt))
        .limit(20);

      return {
        orderId: order.id,
        orderNo: order.orderNo,
        status: order.status,
        risk: order.risk,
        customerId: order.customerId,
        customerName: customer?.companyName ?? '—',
        customer: customer ? { country: customer.country, isFormal: customer.isFormal } : null,
        contactId: order.contactId,
        contact: contact ? { name: contact.name, email: contact.email } : null,
        quotationId: order.quotationId,
        deliveryDate: order.deliveryDate,
        paymentTerms: order.paymentTerms,
        amount: normalizeAmount(order.amount, 2),
        currency: order.currency,
        progress,
        items: items.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
          costSnapshot: toCoreCostSnapshot(i.costSnapshot),
        })),
        riskInsight: buildRiskView(assessment, insight),
        pendingChange: pendingChange
          ? {
              approvalId: pendingChange.approvalId,
              title: pendingChange.title,
              status: pendingChange.status,
              createdAt: pendingChange.createdAt.toISOString(),
            }
          : null,
        timeline: timeline.map((t) => ({
          id: t.id,
          productionPct: t.productionPct,
          note: t.note,
          createdAt: t.createdAt.toISOString(),
        })),
        ownerId: order.ownerId,
        ownerName: owner?.name ?? null,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
      };
    });
  }

  // ===== 建单（转单 / 手工） =====

  /** 10 §3.1 创建订单（fromQuoteId 转单须报价 won 且未转；手工建单走定价引擎核算） */
  async create(
    orgId: string,
    userId: string,
    dto: CreateOrderDto,
  ): Promise<{ orderId: string; orderNo: string; status: string; fromQuote: boolean }> {
    const rules = await this.settings.getPricingRules(orgId);
    const now = new Date();
    const orderId = createId('order');

    const created = await withOrg(this.db, orgId, async (tx) => {
      const resolved = dto.fromQuoteId
        ? await this.resolveFromQuote(tx, orgId, dto.fromQuoteId, dto)
        : await this.resolveManualItems(tx, orgId, dto, rules);

      const amount = resolved.preserveQuoteAmount ? resolved.amount : sumLineTotals(resolved.lines);
      const progress: OrderProgress = { ...EMPTY_ORDER_PROGRESS };
      const status = deriveOrderStatus(progress);
      const orderNo = await this.allocateOrderNo(tx, orgId);

      await tx.insert(schema.salesOrder).values({
        id: orderId,
        orgId,
        orderNo,
        customerId: resolved.customerId,
        contactId: resolved.contactId,
        quotationId: resolved.quotationId,
        deliveryDate: dto.deliveryDate,
        paymentTerms: dto.paymentTerms ?? resolved.paymentTerms,
        amount: normalizeAmount(amount, 2),
        currency: resolved.currency,
        status,
        risk: 'normal',
        progressPoConfirmed: progress.poConfirmed,
        progressPayment: progress.payment,
        productionPct: progress.productionPct,
        progressShipping: progress.shipping,
        ownerId: userId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      await insertOrderItems(tx, orgId, orderId, resolved.lines);
      await tx.insert(schema.orderProgressLog).values({
        id: createId('oplog'),
        orgId,
        salesOrderId: orderId,
        productionPct: progress.productionPct,
        note: resolved.quotationId
          ? `订单创建（来源报价转单，金额 ${resolved.currency} ${normalizeAmount(amount, 2)}）`
          : '订单创建',
        updatedBy: userId,
        createdAt: now,
      });
      return {
        orderNo,
        amount,
        currency: resolved.currency,
        status,
        customerId: resolved.customerId,
      };
    });

    await this.writeActivity(this.db, {
      orgId,
      userId,
      customerId: created.customerId,
      type: 'note',
      summary: `订单 ${created.orderNo} 创建成功（${created.currency} ${created.amount}）`,
      refId: orderId,
      refType: 'sales_order',
    });

    return {
      orderId,
      orderNo: created.orderNo,
      status: created.status,
      fromQuote: Boolean(dto.fromQuoteId),
    };
  }

  // ===== 变更（order_change 高危审批） =====

  /** 10 §3.2 变更订单 → 生成 order_change 高危审批（AI 身份由 controller 拦截为 40301） */
  async update(
    orgId: string,
    userId: string,
    role: string,
    orderId: string,
    dto: UpdateOrderDto,
  ): Promise<{
    orderId: string;
    approvalId: string;
    approvalType: string;
    riskLevel: string;
    status: string;
    changes: Record<string, unknown>;
  }> {
    const rules = await this.settings.getPricingRules(orgId);
    const now = new Date();
    const result = await withOrg(this.db, orgId, async (tx) => {
      const order = await this.getOrderOrThrow(tx, orgId, orderId);
      const [pending] = await tx
        .select({ id: schema.approvalRequest.id })
        .from(schema.approvalRequest)
        .where(
          and(
            eq(schema.approvalRequest.orgId, orgId),
            eq(schema.approvalRequest.approvalType, 'order_change'),
            eq(schema.approvalRequest.bizType, 'sales_order'),
            eq(schema.approvalRequest.bizId, orderId),
            eq(schema.approvalRequest.status, 'pending'),
          ),
        )
        .limit(1);
      if (pending) {
        throw BizException.conflict('该订单已有变更审批在处理中，请先完成审批（10 FR-03）');
      }

      const lines = dto.items
        ? await this.buildOrderLines(tx, orgId, dto.items, order.currency, rules)
        : undefined;
      const changes: OrderChangeContext['changes'] = {};
      if (dto.deliveryDate !== undefined) {
        changes.deliveryDate = dto.deliveryDate;
      }
      if (lines) {
        changes.items = lines.map((l) => ({
          seq: l.seq,
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          costSnapshot: l.costSnapshot as Record<string, number>,
        }));
        // 数量/单价变更后总额由明细行重算（金额随明细联动）
        changes.amount = normalizeAmount(sumLineTotals(lines), 2);
      } else if (dto.amount !== undefined) {
        changes.amount = normalizeAmount(dto.amount, 2);
      }

      const context: OrderChangeContext = {
        orderId,
        orderNo: order.orderNo,
        before: { deliveryDate: order.deliveryDate, amount: normalizeAmount(order.amount, 2) },
        changes,
      };
      const expireHours = await resolveApprovalExpireHours(tx, orgId, role, 'order_change');
      const approvalId = createId('appr');
      await tx.insert(schema.approvalRequest).values({
        id: approvalId,
        orgId,
        approvalType: 'order_change',
        riskLevel: 'high',
        title: `订单变更 ${order.orderNo}`,
        bizType: 'sales_order',
        bizId: orderId,
        context: context as unknown as Record<string, unknown>,
        aiProposal: changes as unknown as Record<string, unknown>,
        status: 'pending',
        requestedByUserId: userId,
        expiresAt: new Date(now.getTime() + expireHours * 3600 * 1000),
        createdAt: now,
        updatedAt: now,
      });
      return { orderNo: order.orderNo, approvalId };
    });

    await this.enqueuer
      .enqueueNotify({
        type: 'approval_pending',
        orgId,
        title: `审批待处理：订单变更 ${result.orderNo}`,
        content: '订单交期/金额/数量变更已提交审核（12 审核中心）',
        refType: 'approval',
        refId: result.approvalId,
      })
      .catch(() => undefined);

    return {
      orderId,
      approvalId: result.approvalId,
      approvalType: 'order_change',
      riskLevel: 'high',
      status: 'pending',
      changes: dto as unknown as Record<string, unknown>,
    };
  }

  // ===== 进度（状态推导 + 风险自动评估） =====

  /** 10 FR-02 更新履约进度：四要素落库 → 状态推导 → 写流水 → 风险自动评估（FR-04） */
  async updateProgress(
    orgId: string,
    userId: string,
    orderId: string,
    dto: UpdateOrderProgressDto,
  ): Promise<{
    orderId: string;
    status: string;
    progress: OrderProgress;
    risk: { status: string; delayDays: number };
  }> {
    const now = new Date();
    const result = await withOrg(this.db, orgId, async (tx) => {
      const order = await this.getOrderOrThrow(tx, orgId, orderId);
      const current = normalizeOrderProgress(order);
      const progress = mergeProgress(current, dto.progress);
      const status = deriveOrderStatus(progress);
      const assessment = computeOrderRisk({
        createdAt: order.createdAt,
        deliveryDate: order.deliveryDate,
        progress,
        now,
      });

      await tx
        .update(schema.salesOrder)
        .set({
          progressPoConfirmed: progress.poConfirmed,
          progressPayment: progress.payment,
          productionPct: progress.productionPct,
          progressShipping: progress.shipping,
          status,
          risk: assessment.status,
          updatedAt: now,
        })
        .where(eq(schema.salesOrder.id, orderId));

      const note = buildProgressNote(progress, status);
      await tx.insert(schema.orderProgressLog).values({
        id: createId('oplog'),
        orgId,
        salesOrderId: orderId,
        productionPct: progress.productionPct,
        note,
        updatedBy: userId,
        createdAt: now,
      });
      await this.syncRiskInsight(tx, orgId, orderId, assessment, now, {
        insightId: createId('orisk'),
        confidence: null,
      });
      return {
        status,
        progress,
        risk: assessment,
        orderNo: order.orderNo,
        customerId: order.customerId,
        wasAtRisk: order.risk === 'at_risk',
      };
    });

    await this.writeActivity(this.db, {
      orgId,
      userId,
      customerId: result.customerId,
      type: 'note',
      summary: `订单 ${result.orderNo} 进度更新为「${ORDER_STATUS_LABELS[result.status as OrderStatus]}」（生产 ${result.progress.productionPct}%）`,
      refId: orderId,
      refType: 'sales_order',
    });

    if (result.risk.status === 'at_risk' && !result.wasAtRisk) {
      await this.enqueuer
        .enqueueNotify({
          type: 'risk_alert',
          orgId,
          title: `订单延期风险：${result.orderNo}`,
          content: `${result.risk.reason}（预计延期 ${result.risk.delayDays} 天，10 FR-04）`,
          refType: 'order',
          refId: orderId,
        })
        .catch(() => undefined);
    }

    return {
      orderId,
      status: result.status,
      progress: result.progress,
      risk: { status: result.risk.status, delayDays: result.risk.delayDays },
    };
  }

  /**
   * 10 §3.4 订单风险分析（规则引擎实时评估；若已有 AI 产出洞察则覆盖原因表达与建议文案）。
   */
  async risk(orgId: string, orderId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const order = await this.getOrderOrThrow(tx, orgId, orderId);
      const progress = normalizeOrderProgress(order);
      const assessment = computeOrderRisk({
        createdAt: order.createdAt,
        deliveryDate: order.deliveryDate,
        progress,
      });
      const [insight] = await tx
        .select()
        .from(schema.orderRiskInsight)
        .where(
          and(
            eq(schema.orderRiskInsight.salesOrderId, orderId),
            eq(schema.orderRiskInsight.status, 'active'),
          ),
        )
        .orderBy(desc(schema.orderRiskInsight.generatedAt))
        .limit(1);
      return {
        orderId,
        orderNo: order.orderNo,
        customerId: order.customerId,
        ...buildRiskView(assessment, insight),
      };
    });
  }

  // ===== 建议执行（FR-06 / FR-07） =====

  /** 10 §3.5 执行风险建议：internal → 建订单监控任务；customer → 生成沟通草稿 + message_send 审批 */
  async executeRisk(
    orgId: string,
    userId: string,
    role: string,
    orderId: string,
    dto: ExecuteOrderRiskDto,
  ): Promise<{
    orderId: string;
    taskIds: string[];
    approvalIds: string[];
    draft: { draftId: string; conversationId: string; content: string } | null;
  }> {
    const view = await this.risk(orgId, orderId);
    if (view.suggestions.length === 0) {
      throw BizException.bizValidation('当前订单无风险建议可执行（10 FR-06）');
    }
    const picked = dto.suggestionIds.map((id) => {
      const hit = view.suggestions.find((s) => s.suggestionId === id);
      if (!hit) {
        throw BizException.bizValidation(`建议不存在: ${id}（10 FR-06）`);
      }
      return hit;
    });

    const taskIds: string[] = [];
    const approvalIds: string[] = [];
    let draft: { draftId: string; conversationId: string; content: string } | null = null;

    const internalPicked = picked.filter((p) => p.type === 'internal');
    if (internalPicked.length > 0) {
      const employeeId = await this.resolveMonitorEmployee(orgId);
      for (const suggestion of internalPicked) {
        const task = await this.tasks.create(orgId, userId, {
          employeeId,
          type: 'order_monitor',
          title: `订单风险跟进 ${view.orderNo}·${suggestion.label}`,
          input: {
            orderId,
            orderNo: view.orderNo,
            suggestionId: suggestion.suggestionId,
            delayDays: view.delayDays,
          },
        });
        taskIds.push(task.taskId);
      }
    }

    const customerPicked = picked.filter((p) => p.type === 'customer');
    if (customerPicked.length > 0) {
      const created = await this.createDelayDraft(orgId, userId, orderId);
      draft = {
        draftId: created.draftId,
        conversationId: created.conversationId,
        content: created.content,
      };
      approvalIds.push(created.approvalId);
    }

    await this.writeActivity(this.db, {
      orgId,
      userId,
      customerId: view.customerId,
      type: 'note',
      summary: `订单 ${view.orderNo} 风险建议已执行（内部任务 ${taskIds.length} 项 / 客户沟通 ${approvalIds.length} 项）`,
      refId: orderId,
      refType: 'sales_order',
    });

    return { orderId, taskIds, approvalIds, draft };
  }

  /** 10 §3.7 生成延期沟通草稿（进入 06 工作台草稿箱，须人工确认后发送） */
  async draftEmail(
    orgId: string,
    userId: string,
    orderId: string,
  ): Promise<{ draftId: string; conversationId: string; content: string }> {
    const created = await this.createDelayDraft(orgId, userId, orderId);
    return {
      draftId: created.draftId,
      conversationId: created.conversationId,
      content: created.content,
    };
  }

  // ===== 内部实现 =====

  /** 各档 Tab 计数（all + 四状态） */
  private async tabCounts(tx: Tx, orgId: string): Promise<Record<string, number>> {
    const rows = await tx
      .select({ status: schema.salesOrder.status, n: count() })
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.orgId, orgId))
      .groupBy(schema.salesOrder.status);
    const counts: Record<string, number> = {
      all: 0,
      pending_payment: 0,
      in_production: 0,
      ready_to_ship: 0,
      completed: 0,
    };
    for (const row of rows) {
      const n = Number(row.n);
      counts[row.status] = n;
      counts.all = (counts.all ?? 0) + n;
    }
    return counts;
  }

  private async riskCounts(tx: Tx, orgId: string): Promise<Record<string, number>> {
    const rows = await tx
      .select({ risk: schema.salesOrder.risk, n: count() })
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.orgId, orgId))
      .groupBy(schema.salesOrder.risk);
    const counts: Record<string, number> = { normal: 0, at_risk: 0 };
    for (const row of rows) {
      counts[row.risk] = Number(row.n);
    }
    return counts;
  }

  /** 读取订单头（org 隔离；不存在 → 40401） */
  private async getOrderOrThrow(tx: Tx, orgId: string, orderId: string) {
    const [row] = await tx
      .select()
      .from(schema.salesOrder)
      .where(and(eq(schema.salesOrder.id, orderId), eq(schema.salesOrder.orgId, orgId)))
      .limit(1);
    if (!row) {
      throw BizException.notFound(`订单不存在: ${orderId}`);
    }
    return row;
  }

  private async loadItems(tx: Tx, orderId: string) {
    return tx
      .select()
      .from(schema.salesOrderItem)
      .where(eq(schema.salesOrderItem.salesOrderId, orderId))
      .orderBy(asc(schema.salesOrderItem.seq));
  }

  /** 转单：报价须 won 且未转过单；明细行与成本快照原样复制（10 FR-01/FR-08） */
  private async resolveFromQuote(
    tx: Tx,
    orgId: string,
    quoteId: string,
    dto: CreateOrderDto,
  ): Promise<{
    customerId: string;
    contactId: string | null;
    quotationId: string | null;
    currency: string;
    paymentTerms: string | null;
    amount: string;
    preserveQuoteAmount: boolean;
    lines: ResolvedOrderLine[];
  }> {
    const [quote] = await tx
      .select()
      .from(schema.quotation)
      .where(and(eq(schema.quotation.id, quoteId), eq(schema.quotation.orgId, orgId)))
      .limit(1);
    if (!quote) {
      throw BizException.notFound(`报价不存在: ${quoteId}`);
    }
    if (quote.status !== 'won') {
      throw BizException.conflict(`仅已成交报价可转订单（当前状态: ${quote.status}，10 FR-01）`);
    }
    const [existing] = await tx
      .select({ id: schema.salesOrder.id })
      .from(schema.salesOrder)
      .where(and(eq(schema.salesOrder.orgId, orgId), eq(schema.salesOrder.quotationId, quoteId)))
      .limit(1);
    if (existing) {
      throw BizException.conflict(`该报价已转订单: ${existing.id}（10 FR-01）`);
    }
    const quoteItems = await tx
      .select()
      .from(schema.quotationItem)
      .where(eq(schema.quotationItem.quotationId, quoteId))
      .orderBy(asc(schema.quotationItem.seq));
    if (quoteItems.length === 0) {
      throw BizException.bizValidation('报价单无明细行，无法转订单（10 FR-01）');
    }
    return {
      customerId: quote.customerId,
      contactId: quote.contactId ?? null,
      quotationId: quote.id,
      currency: dto.currency !== 'USD' ? dto.currency : quote.currency,
      paymentTerms: quote.paymentTerms ?? null,
      amount: normalizeAmount(quote.totalAmount, 2),
      // 转单沿用报价总额（明细行仅作履约快照，金额不重算）
      preserveQuoteAmount: true,
      lines: quoteItems.map((item) => ({
        seq: item.seq,
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: normalizeAmount(item.unitPrice, 4),
        lineTotal: normalizeAmount(item.lineTotal, 2),
        costSnapshot: toCoreCostSnapshot(item.costSnapshot),
      })),
    };
  }

  /** 手工建单：客户校验 + 定价引擎核算成本快照（与 09 报价同源规则） */
  private async resolveManualItems(
    tx: Tx,
    orgId: string,
    dto: CreateOrderDto,
    rules: PricingRulesView,
  ): Promise<{
    customerId: string;
    contactId: string | null;
    quotationId: string | null;
    currency: string;
    paymentTerms: string | null;
    amount: string;
    preserveQuoteAmount: boolean;
    lines: ResolvedOrderLine[];
  }> {
    if (!dto.customerId) {
      throw BizException.bizValidation('手工建单需提供 customerId（10 §3.1）');
    }
    const items: OrderItemDto[] = dto.items ?? [];
    if (items.length === 0) {
      throw BizException.bizValidation('手工建单至少需要一条明细行（10 §3.1）');
    }
    await this.assertCustomerExists(tx, orgId, dto.customerId);
    const lines = await this.buildOrderLines(tx, orgId, items, dto.currency, rules);
    return {
      customerId: dto.customerId,
      contactId: null,
      quotationId: null,
      currency: dto.currency,
      paymentTerms: dto.paymentTerms ?? null,
      amount: sumLineTotals(lines),
      preserveQuoteAmount: false,
      lines,
    };
  }

  /** 明细行核算（产品校验 + 行总价 + 五项成本快照；建单与变更共用） */
  private async buildOrderLines(
    tx: Tx,
    orgId: string,
    items: OrderItemDto[],
    currency: string,
    rules: PricingRulesView,
  ): Promise<ResolvedOrderLine[]> {
    const products = await this.loadProducts(
      tx,
      orgId,
      items.map((i) => i.productId),
    );
    return items.map((item, index) => {
      const product = products.get(item.productId);
      if (!product) {
        throw BizException.notFound(`产品不存在: ${item.productId}`);
      }
      const unitPrice = normalizeAmount(item.unitPrice, 4);
      const lineTotal = scaledToAmount(
        (amountToScaledBigInt(unitPrice, 4) * BigInt(item.quantity) + 50n) / 100n,
        2,
      );
      const engine = computeUnitCosts({
        unitPrice,
        purchaseCost: purchaseCostInCurrency(product, currency, '1'),
        enabledCostItems: enabledCostItems(rules),
      });
      const override: CostSnapshot = {};
      if (item.costSnapshot) {
        for (const key of COST_ITEM_KEYS) {
          const value = item.costSnapshot[key];
          if (value !== undefined) {
            override[key] = Number(value);
          }
        }
      }
      return {
        seq: index + 1,
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
        costSnapshot: mergeCostSnapshot(engine, override),
      };
    });
  }

  private async loadProducts(
    tx: Tx,
    orgId: string,
    productIds: string[],
  ): Promise<Map<string, ProductRow>> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({
        id: schema.product.id,
        name: schema.product.name,
        costPrice: schema.product.costPrice,
        currency: schema.product.currency,
      })
      .from(schema.product)
      .where(and(eq(schema.product.orgId, orgId), inArray(schema.product.id, unique)));
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async assertCustomerExists(tx: Tx, orgId: string, customerId: string): Promise<void> {
    const [row] = await tx
      .select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, customerId), eq(schema.customer.orgId, orgId)))
      .limit(1);
    if (!row) {
      throw BizException.notFound(`客户不存在: ${customerId}`);
    }
  }

  /**
   * 风险洞察落库（10 FR-04）：
   * at_risk → 复用/新建 active 洞察（数值来自规则引擎，reason/suggestions 允许被 AI 覆盖）；
   * normal → 关闭 active 洞察。
   */
  private async syncRiskInsight(
    tx: Tx,
    orgId: string,
    orderId: string,
    assessment: OrderRiskAssessment,
    now: Date,
    meta: { insightId: string; confidence: string | null },
  ): Promise<void> {
    const [active] = await tx
      .select({ id: schema.orderRiskInsight.id })
      .from(schema.orderRiskInsight)
      .where(
        and(
          eq(schema.orderRiskInsight.salesOrderId, orderId),
          eq(schema.orderRiskInsight.status, 'active'),
        ),
      )
      .limit(1);

    if (assessment.status === 'normal') {
      if (active) {
        await tx
          .update(schema.orderRiskInsight)
          .set({ status: 'resolved', resolvedAt: now, updatedAt: now })
          .where(eq(schema.orderRiskInsight.id, active.id));
      }
      return;
    }

    const payload = {
      delayDays: assessment.delayDays,
      reason: assessment.reason,
      evidence: assessment.evidence as unknown as Record<string, unknown>,
      suggestions: assessment.suggestions.map((s) => ({ ...s })),
      generatedAt: now,
      updatedAt: now,
      status: 'active',
      resolvedAt: null,
    };
    if (active) {
      await tx
        .update(schema.orderRiskInsight)
        .set(payload)
        .where(eq(schema.orderRiskInsight.id, active.id));
      return;
    }
    await tx.insert(schema.orderRiskInsight).values({
      id: meta.insightId,
      orgId,
      salesOrderId: orderId,
      confidence: meta.confidence,
      createdAt: now,
      ...payload,
    });
  }

  /** 生成延期沟通草稿 + message_send 审批（10 FR-07 + 06 §2.4） */
  private async createDelayDraft(
    orgId: string,
    userId: string,
    orderId: string,
  ): Promise<{ draftId: string; conversationId: string; approvalId: string; content: string }> {
    const now = new Date();
    const view = await this.risk(orgId, orderId);
    return withOrg(this.db, orgId, async (tx) => {
      const order = await this.getOrderOrThrow(tx, orgId, orderId);
      const [customer] = await tx
        .select({ companyName: schema.customer.companyName })
        .from(schema.customer)
        .where(eq(schema.customer.id, order.customerId))
        .limit(1);
      const [contact] = await tx
        .select({ name: schema.contact.name, email: schema.contact.email })
        .from(schema.contact)
        .where(
          and(eq(schema.contact.customerId, order.customerId), eq(schema.contact.isPrimary, true)),
        )
        .limit(1);

      const [existing] = await tx
        .select({ id: schema.conversation.id })
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.orgId, orgId),
            eq(schema.conversation.customerId, order.customerId),
          ),
        )
        .orderBy(desc(schema.conversation.updatedAt))
        .limit(1);

      const conversationId = existing?.id ?? createId('conv');
      if (!existing) {
        await tx.insert(schema.conversation).values({
          id: conversationId,
          orgId,
          customerId: order.customerId,
          contactId: order.contactId ?? null,
          channel: 'email',
          subject: `Delivery schedule of order ${order.orderNo}`,
          priority: view.risk === 'at_risk' ? 'high' : 'normal',
          unreadCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      const content = buildDelayEmail({
        customerName: customer?.companyName ?? 'there',
        contactName: contact?.name ?? null,
        orderNo: order.orderNo,
        currency: order.currency,
        deliveryDate: order.deliveryDate,
        delayDays: view.delayDays,
        reason: view.reason,
      });
      const draftId = createId('msg');
      await tx.insert(schema.message).values({
        id: draftId,
        orgId,
        conversationId,
        direction: 'out',
        senderType: 'ai',
        senderName: 'AI 跟单员',
        content,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(schema.conversation)
        .set({
          lastMessageAt: now,
          lastMessagePreview: content.slice(0, 120),
          updatedAt: now,
        })
        .where(eq(schema.conversation.id, conversationId));

      const expireHours = await resolveApprovalExpireHours(tx, orgId, 'manager', 'email_send');
      const approvalId = createId('appr');
      await tx.insert(schema.approvalRequest).values({
        id: approvalId,
        orgId,
        approvalType: 'email_send',
        riskLevel: 'high',
        title: `客户延期沟通 ${order.orderNo}`,
        // bizType='message' + bizId=message → 批准后由审批中心真实外发（12 §3.3 send 分支 B）
        bizType: 'message',
        bizId: draftId,
        context: {
          conversationId,
          messageId: draftId,
          customerId: order.customerId,
          orderId,
          orderNo: order.orderNo,
          recipient: contact?.email ?? null,
          subject: `Delivery schedule of order ${order.orderNo}`,
          delayDays: view.delayDays,
        },
        aiProposal: { messageId: draftId, emailContent: content },
        status: 'pending',
        requestedByUserId: userId,
        expiresAt: new Date(now.getTime() + expireHours * 3600 * 1000),
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(schema.message)
        .set({ status: 'waiting_approval', updatedAt: now })
        .where(eq(schema.message.id, draftId));

      return { draftId, conversationId, approvalId, content };
    });
  }

  /** 订单监控任务承接员工（16 种子：role=merchandiser；缺失则取任一可用员工） */
  private async resolveMonitorEmployee(orgId: string): Promise<string> {
    return withOrg(this.db, orgId, async (tx) => {
      const [merchandiser] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(
          and(
            eq(schema.aiEmployee.orgId, orgId),
            eq(schema.aiEmployee.role, 'merchandiser'),
            eq(schema.aiEmployee.status, 'idle'),
          ),
        )
        .limit(1);
      if (merchandiser) {
        return merchandiser.id;
      }
      const [fallback] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.status, 'idle')))
        .limit(1);
      if (!fallback) {
        throw BizException.bizValidation('无可用 AI 员工承接订单监控任务（10 FR-06）');
      }
      return fallback.id;
    });
  }

  /** 订单编号分配 `SO-YYYYMMDD-NNN`（同 org 同日递增；uq_order_org_no 兜底） */
  private async allocateOrderNo(tx: Tx, orgId: string): Promise<string> {
    const prefix = `SO-${todayIso().replace(/-/g, '')}-`;
    const [row] = await tx
      .select({ orderNo: schema.salesOrder.orderNo })
      .from(schema.salesOrder)
      .where(
        and(
          eq(schema.salesOrder.orgId, orgId),
          sql`${schema.salesOrder.orderNo} like ${`${prefix}%`}`,
        ),
      )
      .orderBy(desc(schema.salesOrder.orderNo))
      .limit(1);
    const lastSeq = row ? Number(row.orderNo.slice(prefix.length)) : 0;
    const next = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;
    return `${prefix}${String(next).padStart(3, '0')}`;
  }

  /** 写客户活动流水（05 §2；customerId 为空时跳过，避免 FK 违约） */
  private async writeActivity(
    db: Db,
    input: {
      orgId: string;
      userId: string;
      customerId: string;
      type: 'quote' | 'stage_change' | 'note';
      summary: string;
      refId: string;
      refType: string;
    },
  ): Promise<void> {
    if (!input.customerId) {
      return;
    }
    await withOrg(db, input.orgId, async (tx) => {
      await tx.insert(schema.customerActivity).values({
        id: createId('act'),
        orgId: input.orgId,
        customerId: input.customerId,
        type: input.type,
        summary: input.summary,
        operatorType: 'user',
        operatorId: input.userId,
        refType: input.refType,
        refId: input.refId,
      });
    });
  }
}

// ===== 模块级辅助 =====

/** tab 优先于 status（接口 10 §2） */
function resolveStatusFilter(query: ListOrdersQueryDto): OrderStatus | undefined {
  if (query.tab && query.tab !== 'all') {
    return query.tab;
  }
  return query.status;
}

/** 进度合并（部分更新语义） */
function mergeProgress(current: OrderProgress, patch: Partial<OrderProgress>): OrderProgress {
  return {
    poConfirmed: patch.poConfirmed ?? current.poConfirmed,
    payment: patch.payment ?? current.payment,
    productionPct: patch.productionPct ?? current.productionPct,
    shipping: patch.shipping ?? current.shipping,
  };
}

/** 进度流水备注（P1-10-02：写 progress_log 便于时间线回溯） */
function buildProgressNote(progress: OrderProgress, status: OrderStatus): string {
  const flags = [
    progress.poConfirmed ? 'PO 已确认' : null,
    progress.payment ? '已付款' : null,
    progress.shipping ? '已发货' : null,
  ].filter((v): v is string => Boolean(v));
  return `状态「${ORDER_STATUS_LABELS[status]}」，生产 ${progress.productionPct}%${
    flags.length > 0 ? `，${flags.join(' / ')}` : ''
  }`;
}

/** 风险视图（规则引擎数值 + AI 洞察文案覆盖；无风险时不返回建议） */
function buildRiskView(
  assessment: OrderRiskAssessment,
  insight: typeof schema.orderRiskInsight.$inferSelect | undefined,
): {
  risk: string;
  delayDays: number;
  reason: string;
  evidence: Record<string, unknown>;
  suggestions: OrderRiskSuggestion[];
  confidence: number | null;
  generatedAt: string;
  source: string;
} {
  const aiReason = insight?.status === 'active' ? insight.reason : null;
  const aiSuggestions = insight?.status === 'active' ? insight.suggestions : null;
  return {
    risk: assessment.status,
    delayDays: assessment.delayDays,
    reason: aiReason ?? assessment.reason,
    evidence: assessment.evidence as unknown as Record<string, unknown>,
    suggestions:
      aiSuggestions && aiSuggestions.length > 0
        ? aiSuggestions.map((s) => ({
            suggestionId: s.suggestionId,
            type: s.type === 'customer' ? 'customer' : 'internal',
            label: s.label,
          }))
        : assessment.suggestions,
    confidence: insight?.confidence ? Number(insight.confidence) : null,
    generatedAt: (insight?.generatedAt ?? new Date()).toISOString(),
    source: aiReason ? 'ai_insight' : 'rule_engine',
  };
}

/** 延期沟通邮件草稿（须人工确认后发送，10 FR-07） */
function buildDelayEmail(input: {
  customerName: string;
  contactName: string | null;
  orderNo: string;
  currency: string;
  deliveryDate: string;
  delayDays: number;
  reason: string;
}): string {
  const greeting = input.contactName ?? input.customerName;
  const delayLine =
    input.delayDays > 0
      ? `we expect a delay of approximately ${input.delayDays} day(s) to the original schedule (${input.deliveryDate}).`
      : `we are closely monitoring the production schedule to keep the delivery date ${input.deliveryDate}.`;
  return [
    `Dear ${greeting},`,
    '',
    `We are writing regarding the delivery schedule of order ${input.orderNo}.`,
    `Current status: ${input.reason || 'production is behind the original plan'}.`,
    `As a result, ${delayLine}`,
    '',
    'We are expediting production and will confirm a revised delivery date shortly.',
    'Please let us know if you have any specific deadlines we should prioritise.',
    '',
    'Best regards',
  ].join('\n');
}

/** 行级快照归一（jsonb → core 五项快照，缺项补 0） */
function toCoreCostSnapshot(raw: Record<string, unknown> | null | undefined): CostSnapshot {
  const snapshot: CostSnapshot = {};
  for (const key of COST_ITEM_KEYS) {
    snapshot[key] = Number(raw?.[key] ?? 0);
  }
  return snapshot;
}

/** 订单总额（各行 lineTotal 汇总，定标 2 位） */
function sumLineTotals(lines: ResolvedOrderLine[]): string {
  const total = lines.reduce((acc, line) => acc + amountToScaledBigInt(line.lineTotal, 2), 0n);
  return scaledToAmount(total, 2);
}

/** 落库明细行（seq 连续，满足 uq_order_item_seq） */
async function insertOrderItems(
  tx: Tx,
  orgId: string,
  orderId: string,
  lines: ResolvedOrderLine[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }
  await tx.insert(schema.salesOrderItem).values(
    lines.map((line) => ({
      id: createId('oitem'),
      orgId,
      salesOrderId: orderId,
      seq: line.seq,
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      costSnapshot: line.costSnapshot,
    })),
  );
}

/** 启用成本项（16 costItems ∩ 引擎五项；缺省五项全启用） */
function enabledCostItems(rules: PricingRulesView): CostItemKey[] {
  const picked = rules.costItems.filter((item): item is CostItemKey =>
    (COST_ITEM_KEYS as readonly string[]).includes(item),
  );
  return picked.length > 0 ? picked : [...COST_ITEM_KEYS];
}

/** 采购成本换算到订单币种（同币种直取；MVP 汇率为建单时点快照） */
function purchaseCostInCurrency(product: ProductRow, currency: string, rate: string): string {
  if (product.currency.toUpperCase() === currency.toUpperCase()) {
    return normalizeAmount(product.costPrice, 2);
  }
  return normalizeAmount(Number(product.costPrice) * Number(rate), 2);
}

/** 审批超时小时（16 role_permission.approval_rules；缺省 48h，12 §7.2） */
async function resolveApprovalExpireHours(
  tx: Tx,
  orgId: string,
  role: string,
  approvalType: string,
): Promise<number> {
  const [row] = await tx
    .select({ approvalRules: schema.rolePermission.approvalRules })
    .from(schema.rolePermission)
    .where(
      and(eq(schema.rolePermission.orgId, orgId), sql`${schema.rolePermission.role} = ${role}`),
    )
    .limit(1);
  const rule = row?.approvalRules?.find((r) => r.approvalType === approvalType);
  return typeof rule?.expireHours === 'number' && rule.expireHours > 0
    ? rule.expireHours
    : DEFAULT_APPROVAL_TTL_HOURS;
}

/** 今天 `YYYY-MM-DD`（UTC，与编号规则同口径） */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
