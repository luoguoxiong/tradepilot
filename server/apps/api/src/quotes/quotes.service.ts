import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import {
  BizException,
  COST_ITEM_KEYS,
  aggregateCostBreakdown,
  amountToScaledBigInt,
  assertProfitFloor,
  buildExchangeRateSnapshot,
  buildNegotiationLadder,
  buildPricingReasons,
  computeProfitMarginPct,
  computeQuoteProfit,
  computeUnitCosts,
  createId,
  mergeCostSnapshot,
  normalizeAmount,
  scaledToAmount,
  sumCostSnapshot,
  type CostItemKey,
  type CostSnapshot,
  type ExchangeRateSnapshot,
  type PricingReason,
} from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import {
  createMailboxDriver,
  isMailboxAuthError,
  type MailboxDriverOptions,
} from '@tradepilot/integrations';
import { TaskEnqueuer } from '@tradepilot/runtime';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import { SettingsService, type PricingRulesView } from '../settings/settings.service.js';
import { renderQuotePdf, type QuotePdfItem } from './quote-pdf.js';
import type {
  AiPricingRequestDto,
  CreateQuoteDto,
  ListQuotesQuery,
  MarkLostDto,
  QuoteItemDto,
  UpdateQuoteDto,
} from './quotes.dto.js';

/** 审批类型 = quote 的缺省超时（12 §7.2；16 未配置时回落 48h） */
const DEFAULT_APPROVAL_TTL_HOURS = 48;

/** 历史成交价回溯窗口（§3.2 reasons「近 90 天同产品成交价」） */
const HISTORY_WINDOW_DAYS = 90;

/** 明细行（引擎核算后的落库形态） */
interface ResolvedLine {
  seq: number;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  costSnapshot: CostSnapshot;
}

/** 产品核算所需投影 */
interface ProductRow {
  id: string;
  name: string;
  moq: number;
  costPrice: string;
  currency: string;
  suggestedPrice: string | null;
}

/**
 * 报价中心服务（接口 09 §2/§3 / 需求 09）：
 * - 读：列表（status Tab + keyword）+ 详情 + 议价梯度（只读）；
 * - 写：新建/编辑（仅 draft；quantity < MOQ、validUntil <= 今天 → 42201）；
 * - 定价：成本快照（行级）/汇率快照（报价头）由定价引擎核算并固化，draft 可人工覆盖；
 *   利润红线 100% 拦截（保存 / 提交，§3.2）；
 * - 状态机：draft → waiting_approval（submit 生成 quote/high 审批）→ sent（须 approved）→ won；
 *   draft/waiting_approval/sent → lost（原因选填）；lost → draft（revive）；won/lost 不可编辑（40901）；
 * - 联动：send/mark-won/mark-lost/PDF 导出均写客户活动流水；mark-won 自动升级潜在客户为正式客户；
 * - 红线：价格数字只由结构化定价引擎产出，LLM 仅表达 reasons（§4）。
 */
@Injectable()
export class QuotesService {
  private readonly enqueuer: TaskEnqueuer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(EnvService) private readonly env: EnvService,
  ) {
    this.enqueuer = new TaskEnqueuer(env.env.REDIS_URL);
  }

  // ===== 列表 / 详情 =====

  /** 09 §1.1/§2 报价列表（status Tab + keyword=编号/客户名；附各档数量） */
  async list(
    orgId: string,
    query: ListQuotesQuery & { page: number; pageSize: number; keyword?: string },
  ): Promise<{
    items: {
      quoteId: string;
      quoteNo: string;
      customerId: string;
      customerName: string;
      totalAmount: string;
      currency: string;
      status: string;
      createdAt: string;
    }[];
    total: number;
    page: number;
    pageSize: number;
    counts: Record<string, number>;
  }> {
    return withOrg(this.db, orgId, async (tx) => {
      const conds = [eq(schema.quotation.orgId, orgId)];
      if (query.status) {
        conds.push(eq(schema.quotation.status, query.status));
      }
      if (query.customerId) {
        conds.push(eq(schema.quotation.customerId, query.customerId));
      }
      if (query.keyword) {
        const like = `%${query.keyword}%`;
        conds.push(
          or(ilike(schema.quotation.quoteNo, like), ilike(schema.customer.companyName, like))!,
        );
      }
      const where = and(...conds);
      const rows = await tx
        .select({
          id: schema.quotation.id,
          quoteNo: schema.quotation.quoteNo,
          customerId: schema.quotation.customerId,
          customerName: schema.customer.companyName,
          totalAmount: schema.quotation.totalAmount,
          currency: schema.quotation.currency,
          status: schema.quotation.status,
          createdAt: schema.quotation.createdAt,
        })
        .from(schema.quotation)
        .leftJoin(schema.customer, eq(schema.customer.id, schema.quotation.customerId))
        .where(where)
        .orderBy(desc(schema.quotation.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await tx
        .select({ n: count() })
        .from(schema.quotation)
        .leftJoin(schema.customer, eq(schema.customer.id, schema.quotation.customerId))
        .where(where);
      const counts = await this.tabCounts(tx, orgId);
      return {
        items: rows.map((r) => ({
          quoteId: r.id,
          quoteNo: r.quoteNo,
          customerId: r.customerId,
          customerName: r.customerName ?? '—',
          totalAmount: r.totalAmount,
          currency: r.currency,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(total?.n ?? 0),
        page: query.page,
        pageSize: query.pageSize,
        counts,
      };
    });
  }

  /** 09 §1.1 各档 Tab 数量（all + 五状态） */
  async summary(orgId: string): Promise<{ tabs: { status: string; count: number }[] }> {
    return withOrg(this.db, orgId, async (tx) => {
      const counts = await this.tabCounts(tx, orgId);
      return {
        tabs: ['all', 'draft', 'waiting_approval', 'sent', 'won', 'lost'].map((status) => ({
          status,
          count: counts[status] ?? 0,
        })),
      };
    });
  }

  /** 09 §1.2/§1.3 报价详情（报价头 + 明细行 + 客户投影） */
  async detail(orgId: string, quoteId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      const [customer] = await tx
        .select({
          companyName: schema.customer.companyName,
          country: schema.customer.country,
          score: schema.customer.score,
          isFormal: schema.customer.isFormal,
        })
        .from(schema.customer)
        .where(eq(schema.customer.id, quote.customerId))
        .limit(1);
      const [contact] = quote.contactId
        ? await tx
            .select({
              name: schema.contact.name,
              email: schema.contact.email,
            })
            .from(schema.contact)
            .where(eq(schema.contact.id, quote.contactId))
            .limit(1)
        : [undefined];
      const [owner] = await tx
        .select({ name: schema.userAccount.name })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.id, quote.ownerId))
        .limit(1);
      const items = await this.loadItems(tx, quoteId);
      const breakdown = aggregateCostBreakdown(
        items.map((i) => ({ quantity: i.quantity, costSnapshot: i.costSnapshot })),
      );
      const approval = quote.approvalId
        ? (
            await tx
              .select({
                approvalId: schema.approvalRequest.id,
                status: schema.approvalRequest.status,
                riskLevel: schema.approvalRequest.riskLevel,
              })
              .from(schema.approvalRequest)
              .where(eq(schema.approvalRequest.id, quote.approvalId))
              .limit(1)
          )[0]
        : undefined;
      return {
        quoteId: quote.id,
        quoteNo: quote.quoteNo,
        status: quote.status,
        customerId: quote.customerId,
        customerName: customer?.companyName ?? '—',
        customer: customer
          ? { score: customer.score, isFormal: customer.isFormal, country: customer.country }
          : null,
        contactId: quote.contactId,
        contact: contact ? { name: contact.name, email: contact.email } : null,
        currency: quote.currency,
        incoterms: quote.incoterms,
        validUntil: quote.validUntil,
        exchangeRate: {
          rate: quote.exchangeRate,
          date: quote.exchangeRateDate,
          source: quote.exchangeRateSource,
        },
        paymentTerms: quote.paymentTerms,
        totalAmount: quote.totalAmount,
        profitMarginPct: quote.profitMarginPct ? Number(quote.profitMarginPct) : null,
        costBreakdown: breakdown,
        aiPricing: quote.aiPricing ?? null,
        items: items.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
          costSnapshot: toCoreCostSnapshot(i.costSnapshot),
        })),
        approval: approval
          ? {
              approvalId: approval.approvalId,
              status: approval.status,
              riskLevel: approval.riskLevel,
            }
          : null,
        ownerId: quote.ownerId,
        ownerName: owner?.name ?? null,
        sentAt: quote.sentAt?.toISOString() ?? null,
        wonAt: quote.wonAt?.toISOString() ?? null,
        lostReason: quote.lostReason ?? null,
        createdAt: quote.createdAt.toISOString(),
        updatedAt: quote.updatedAt.toISOString(),
      };
    });
  }

  // ===== 新建 / 编辑 =====

  /** 09 §3.1 新建报价（MOQ/有效期校验 + 成本与汇率快照固化 + 利润红线拦截） */
  async create(
    orgId: string,
    userId: string,
    dto: CreateQuoteDto,
  ): Promise<{ quoteId: string; quoteNo: string; status: string }> {
    const rules = await this.settings.getPricingRules(orgId);
    assertValidUntil(dto.validUntil);
    const exchange = resolveExchangeRate(dto.exchangeRate, null, rules);
    const quoteId = createId('quote');
    const now = new Date();

    return withOrg(this.db, orgId, async (tx) => {
      await this.assertCustomerExists(tx, orgId, dto.customerId);
      if (dto.contactId) {
        await this.assertContactExists(tx, orgId, dto.contactId);
      }
      const products = await this.loadProducts(
        tx,
        orgId,
        dto.items.map((i) => i.productId),
      );
      const lines = buildLines(dto.items, products, dto.currency, exchange, rules);
      const breakdown = aggregateCostBreakdown(
        lines.map((l) => ({ quantity: l.quantity, costSnapshot: l.costSnapshot })),
      );
      const totalAmount = sumLineTotals(lines);
      const profit = computeQuoteProfit({ totalAmount, costBreakdown: breakdown });
      assertProfitFloor({
        profitMarginPct: profit.profitMarginPct,
        profitFloorPct: rules.profitFloorPct,
      });

      const quoteNo = await this.allocateQuoteNo(tx, orgId);
      await tx.insert(schema.quotation).values({
        id: quoteId,
        orgId,
        quoteNo,
        customerId: dto.customerId,
        contactId: dto.contactId ?? null,
        currency: dto.currency,
        incoterms: dto.incoterms,
        validUntil: dto.validUntil,
        exchangeRate: exchange.rate,
        exchangeRateDate: exchange.date,
        exchangeRateSource: exchange.source,
        paymentTerms: dto.paymentTerms,
        totalAmount,
        status: 'draft',
        aiPricing: { costBreakdown: breakdown },
        profitMarginPct: profit.profitMarginPct,
        ownerId: userId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      await insertItems(tx, orgId, quoteId, lines);
      return { quoteId, quoteNo, status: 'draft' as const };
    });
  }

  /** 09 §2 编辑报价（仅 draft；整体替换明细并重算快照/利润） */
  async update(
    orgId: string,
    userId: string,
    quoteId: string,
    dto: UpdateQuoteDto,
  ): Promise<{ quoteId: string; quoteNo: string; status: string }> {
    const rules = await this.settings.getPricingRules(orgId);
    const now = new Date();
    return withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      if (quote.status !== 'draft') {
        throw BizException.conflict(
          `仅草稿报价可编辑（当前状态: ${quote.status}），won/lost 不可改（09 §3.7）`,
        );
      }
      const currency = dto.currency ?? quote.currency;
      const validUntil = dto.validUntil ?? quote.validUntil;
      if (dto.validUntil) {
        assertValidUntil(validUntil);
      }
      const exchange = resolveExchangeRate(
        dto.exchangeRate,
        {
          rate: quote.exchangeRate,
          date: quote.exchangeRateDate,
          source: quote.exchangeRateSource,
        },
        rules,
      );
      if (dto.customerId && dto.customerId !== quote.customerId) {
        await this.assertCustomerExists(tx, orgId, dto.customerId);
      }
      if (dto.contactId) {
        await this.assertContactExists(tx, orgId, dto.contactId);
      }
      const itemInputs: QuoteItemDto[] = dto.items ?? (await this.toItemInputs(tx, quoteId));
      const products = await this.loadProducts(
        tx,
        orgId,
        itemInputs.map((i) => i.productId),
      );
      const lines = buildLines(itemInputs, products, currency, exchange, rules);
      const breakdown = aggregateCostBreakdown(
        lines.map((l) => ({ quantity: l.quantity, costSnapshot: l.costSnapshot })),
      );
      const totalAmount = sumLineTotals(lines);
      const profit = computeQuoteProfit({ totalAmount, costBreakdown: breakdown });
      assertProfitFloor({
        profitMarginPct: profit.profitMarginPct,
        profitFloorPct: rules.profitFloorPct,
      });

      await tx
        .update(schema.quotation)
        .set({
          ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
          ...(dto.contactId !== undefined ? { contactId: dto.contactId } : {}),
          currency,
          ...(dto.incoterms !== undefined ? { incoterms: dto.incoterms } : {}),
          validUntil,
          exchangeRate: exchange.rate,
          exchangeRateDate: exchange.date,
          exchangeRateSource: exchange.source,
          ...(dto.paymentTerms !== undefined ? { paymentTerms: dto.paymentTerms } : {}),
          totalAmount,
          aiPricing: { costBreakdown: breakdown },
          profitMarginPct: profit.profitMarginPct,
          updatedAt: now,
        })
        .where(eq(schema.quotation.id, quoteId));
      await tx.delete(schema.quotationItem).where(eq(schema.quotationItem.quotationId, quoteId));
      await insertItems(tx, orgId, quoteId, lines);
      return { quoteId, quoteNo: quote.quoteNo, status: 'draft' as const };
    });
  }

  // ===== AI 定价建议（结构化引擎，非 LLM；§3.2）=====

  /** 09 §3.2 获取 AI 定价建议（只读、不落库、不改报价） */
  async aiPricing(orgId: string, quoteId: string, dto: AiPricingRequestDto) {
    const rules = await this.settings.getPricingRules(orgId);
    return withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      const items = await this.loadItems(tx, quoteId);
      const focus = await this.resolveFocusItem(tx, orgId, quoteId, items, dto);
      const products = await this.loadProducts(tx, orgId, [focus.productId]);
      const product = products.get(focus.productId);
      if (!product) {
        throw BizException.notFound(`产品不存在: ${focus.productId}`);
      }
      const tiers = await tx
        .select({
          minQty: schema.productPriceTier.minQty,
          unitPrice: schema.productPriceTier.unitPrice,
        })
        .from(schema.productPriceTier)
        .where(eq(schema.productPriceTier.productId, product.id))
        .orderBy(asc(schema.productPriceTier.minQty));
      const matchedTier = [...tiers]
        .filter((t) => t.minQty <= focus.quantity)
        .sort((a, b) => b.minQty - a.minQty)[0];
      const suggestedUnitPrice = normalizeAmount(
        product.suggestedPrice ?? matchedTier?.unitPrice ?? focus.unitPrice,
        4,
      );
      const purchase = purchaseCostInCurrency(product, quote.currency, quote.exchangeRate);
      const engine = computeUnitCosts({
        unitPrice: suggestedUnitPrice,
        purchaseCost: purchase,
        enabledCostItems: enabledCostItems(rules),
      });
      const profitMarginPct = computeProfitMarginPct(suggestedUnitPrice, sumCostSnapshot(engine));
      const [customer] = await tx
        .select({ score: schema.customer.score })
        .from(schema.customer)
        .where(eq(schema.customer.id, quote.customerId))
        .limit(1);
      const history = await this.loadHistory(tx, orgId, product.id);
      const reasons: PricingReason[] = buildPricingReasons({
        quantity: focus.quantity,
        matchedTier: matchedTier
          ? { minQty: matchedTier.minQty, unitPrice: matchedTier.unitPrice }
          : undefined,
        customerScore: customer?.score ?? undefined,
        history,
      });
      const costBreakdown = aggregateCostBreakdown(
        items.map((i) => ({ quantity: i.quantity, costSnapshot: i.costSnapshot })),
      );
      return {
        suggestedUnitPrice,
        profitMarginPct: Number(profitMarginPct),
        costBreakdown,
        reasons,
      };
    });
  }

  // ===== 状态流转 =====

  /** 09 §3.3 提交审核（draft → waiting_approval，生成 quote/high 审批单） */
  async submit(
    orgId: string,
    userId: string,
    role: string,
    quoteId: string,
  ): Promise<{
    quoteId: string;
    status: string;
    approval: { approvalId: string; approvalType: string; riskLevel: string; status: string };
  }> {
    const rules = await this.settings.getPricingRules(orgId);
    const now = new Date();
    const result = await withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      if (quote.status !== 'draft') {
        throw BizException.conflict(`仅草稿报价可提交审核（当前状态: ${quote.status}，09 §4）`);
      }
      // 提交前再校验利润红线（100% 拦截，§3.2）
      assertProfitFloor({
        profitMarginPct: quote.profitMarginPct ?? '0',
        profitFloorPct: rules.profitFloorPct,
      });
      const expireHours = await resolveQuoteExpireHours(tx, orgId, role);
      const approvalId = createId('appr');
      await tx.insert(schema.approvalRequest).values({
        id: approvalId,
        orgId,
        approvalType: 'quote',
        riskLevel: 'high',
        title: `报价审核 ${quote.quoteNo}`,
        bizType: 'quotation',
        bizId: quoteId,
        context: {
          quoteId,
          quoteNo: quote.quoteNo,
          customerId: quote.customerId,
          totalAmount: quote.totalAmount,
          currency: quote.currency,
        },
        aiProposal: {
          totalAmount: quote.totalAmount,
          currency: quote.currency,
          profitMarginPct: quote.profitMarginPct,
        },
        status: 'pending',
        requestedByUserId: userId,
        expiresAt: new Date(now.getTime() + expireHours * 3600 * 1000),
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(schema.quotation)
        .set({ status: 'waiting_approval', approvalId, updatedAt: now })
        .where(eq(schema.quotation.id, quoteId));
      return { quoteNo: quote.quoteNo, approvalId };
    });

    await this.enqueuer
      .enqueueNotify({
        type: 'approval_pending',
        orgId,
        title: `审批待处理：报价审核 ${result.quoteNo}`,
        content: '报价单已提交审核，请及时处置（12 审核中心）',
        refType: 'approval',
        refId: result.approvalId,
      })
      .catch(() => undefined);

    return {
      quoteId,
      status: 'waiting_approval',
      approval: {
        approvalId: result.approvalId,
        approvalType: 'quote',
        riskLevel: 'high',
        status: 'pending',
      },
    };
  }

  /** 09 §3.4 发送报价（须关联审批 approved/edited_approved；走 16 邮箱通道外发 + 客户活动） */
  async send(
    orgId: string,
    userId: string,
    quoteId: string,
  ): Promise<{ status: string; sentAt: string }> {
    const now = new Date();
    const result = await withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      if (quote.status === 'won' || quote.status === 'lost') {
        throw BizException.conflict(`报价已终态（${quote.status}），不可发送（09 §4）`);
      }
      if (!quote.approvalId) {
        throw BizException.conflict('报价尚未提交审核，无法发送（09 §3.4）');
      }
      const [approval] = await tx
        .select({ status: schema.approvalRequest.status })
        .from(schema.approvalRequest)
        .where(eq(schema.approvalRequest.id, quote.approvalId))
        .limit(1);
      if (!approval || (approval.status !== 'approved' && approval.status !== 'edited_approved')) {
        throw BizException.conflict(
          `关联审批未通过（当前状态: ${approval?.status ?? 'missing'}），不可发送（09 §3.4）`,
        );
      }
      const [customer] = await tx
        .select({
          companyName: schema.customer.companyName,
          isFormal: schema.customer.isFormal,
        })
        .from(schema.customer)
        .where(eq(schema.customer.id, quote.customerId))
        .limit(1);
      const contact = await this.resolveContact(tx, orgId, quote.contactId, quote.customerId);
      const externalId = await this.sendQuoteEmail(
        tx,
        orgId,
        quote,
        contact?.email ?? null,
        customer?.companyName ?? '',
      );
      const [org] = await tx
        .select({ name: schema.org.name })
        .from(schema.org)
        .where(eq(schema.org.id, orgId))
        .limit(1);
      await tx
        .update(schema.quotation)
        .set({ status: 'sent', sentAt: now, updatedAt: now })
        .where(eq(schema.quotation.id, quoteId));
      await this.writeActivity(tx, {
        orgId,
        userId,
        customerId: quote.customerId,
        type: 'quote',
        summary: `报价单 ${quote.quoteNo} 已发送至客户（${contact?.email ?? '—'}）`,
        refId: quoteId,
        refType: 'quotation',
        extra: { externalId, orgName: org?.name ?? null },
      });
      return { sentAt: now };
    });
    return { status: 'sent', sentAt: result.sentAt.toISOString() };
  }

  /** 09 §3.5 标记成交（sent → won；潜在客户自动升级为正式客户 + 活动流水） */
  async markWon(
    orgId: string,
    userId: string,
    quoteId: string,
  ): Promise<{ status: string; wonAt: string; customerUpgraded: boolean }> {
    const now = new Date();
    return withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      if (quote.status !== 'sent') {
        throw BizException.conflict(`仅已发送报价可标记成交（当前状态: ${quote.status}，09 §3.5）`);
      }
      const [customer] = await tx
        .select({ isFormal: schema.customer.isFormal })
        .from(schema.customer)
        .where(eq(schema.customer.id, quote.customerId))
        .limit(1);
      const customerUpgraded = customer ? !customer.isFormal : false;
      if (customerUpgraded) {
        // 05 §7：潜在客户 → 正式客户（成交触发，AI 不得变更）
        await tx
          .update(schema.customer)
          .set({ isFormal: true, updatedAt: now })
          .where(eq(schema.customer.id, quote.customerId));
      }
      await tx
        .update(schema.quotation)
        .set({ status: 'won', wonAt: now, updatedAt: now })
        .where(eq(schema.quotation.id, quoteId));
      await this.writeActivity(tx, {
        orgId,
        userId,
        customerId: quote.customerId,
        type: 'quote',
        summary: `报价单 ${quote.quoteNo} 已成交${customerUpgraded ? '，客户升级为正式客户' : ''}`,
        refId: quoteId,
        refType: 'quotation',
        extra: { customerUpgraded },
      });
      return { status: 'won' as const, wonAt: now.toISOString(), customerUpgraded };
    });
  }

  /** 09 §3.7 标记失效（draft/waiting_approval/sent → lost；原因选填） */
  async markLost(
    orgId: string,
    userId: string,
    quoteId: string,
    dto: MarkLostDto,
  ): Promise<{ status: string; lostAt: string; lostReason?: string }> {
    const now = new Date();
    return withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      if (quote.status === 'won' || quote.status === 'lost') {
        throw BizException.conflict(`报价已终态（${quote.status}），不可标记失效（09 §3.7）`);
      }
      await tx
        .update(schema.quotation)
        .set({ status: 'lost', lostReason: dto.reason ?? null, updatedAt: now })
        .where(eq(schema.quotation.id, quoteId));
      await this.writeActivity(tx, {
        orgId,
        userId,
        customerId: quote.customerId,
        type: 'quote',
        summary: `报价单 ${quote.quoteNo} 已标记失效${dto.reason ? `（原因: ${dto.reason}）` : ''}`,
        refId: quoteId,
        refType: 'quotation',
        extra: { reason: dto.reason ?? null },
      });
      // 表结构无 lost_at 列（ER 07）：以 updated_at 作为失效时点回显
      return {
        status: 'lost' as const,
        lostAt: now.toISOString(),
        ...(dto.reason ? { lostReason: dto.reason } : {}),
      };
    });
  }

  /** 09 §3.7 复活失效报价（仅 lost → draft；won 不可 revive） */
  async revive(orgId: string, userId: string, quoteId: string): Promise<{ status: string }> {
    const now = new Date();
    return withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      if (quote.status !== 'lost') {
        throw BizException.conflict(`仅已失效报价可复活（当前状态: ${quote.status}，09 §3.7）`);
      }
      await tx
        .update(schema.quotation)
        .set({ status: 'draft', lostReason: null, approvalId: null, updatedAt: now })
        .where(eq(schema.quotation.id, quoteId));
      await this.writeActivity(tx, {
        orgId,
        userId,
        customerId: quote.customerId,
        type: 'quote',
        summary: `报价单 ${quote.quoteNo} 已复活为草稿`,
        refId: quoteId,
        refType: 'quotation',
      });
      return { status: 'draft' };
    });
  }

  /** 09 §3.8 议价梯度建议（只读；不落库、不改报价；绝不返回底价/剩余底线） */
  async negotiationLadder(
    orgId: string,
    quoteId: string,
  ): Promise<{
    ladder: { round: number; discountPct: number; suggestedUnitPrice: string }[];
    source: string;
  }> {
    const rules = await this.settings.getPricingRules(orgId);
    return withOrg(this.db, orgId, async (tx) => {
      // 归属校验（不存在 → 40401），报价本体不参与梯度计算
      await this.getQuoteOrThrow(tx, orgId, quoteId);
      if (!rules.discountLadder || rules.discountLadder.length === 0) {
        return { ladder: [], source: 'setting.discountLadder' };
      }
      const [first] = await tx
        .select({ unitPrice: schema.quotationItem.unitPrice })
        .from(schema.quotationItem)
        .where(eq(schema.quotationItem.quotationId, quoteId))
        .orderBy(asc(schema.quotationItem.seq))
        .limit(1);
      if (!first) {
        return { ladder: [], source: 'setting.discountLadder' };
      }
      return {
        ladder: buildNegotiationLadder(first.unitPrice, rules.discountLadder),
        source: 'setting.discountLadder',
      };
    });
  }

  // ===== PDF 导出（§3.6）=====

  /** 09 §3.6 服务端渲染报价单 PDF（导出动作写客户活动流水 activity_type=quote） */
  async exportPdf(
    orgId: string,
    userId: string,
    quoteId: string,
  ): Promise<{ filename: string; buffer: Buffer }> {
    const payload = await withOrg(this.db, orgId, async (tx) => {
      const quote = await this.getQuoteOrThrow(tx, orgId, quoteId);
      const items = await this.loadItems(tx, quoteId);
      const [org] = await tx
        .select({ name: schema.org.name, country: schema.org.country, logoUrl: schema.org.logoUrl })
        .from(schema.org)
        .where(eq(schema.org.id, orgId))
        .limit(1);
      const [customer] = await tx
        .select({ companyName: schema.customer.companyName, country: schema.customer.country })
        .from(schema.customer)
        .where(eq(schema.customer.id, quote.customerId))
        .limit(1);
      const contact = await this.resolveContact(tx, orgId, quote.contactId, quote.customerId);
      await this.writeActivity(tx, {
        orgId,
        userId,
        customerId: quote.customerId,
        type: 'quote',
        summary: `导出报价单 ${quote.quoteNo} PDF`,
        refId: quoteId,
        refType: 'quotation',
      });
      const pdfItems: QuotePdfItem[] = items.map((i) => ({
        seq: i.seq,
        productName: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      }));
      return {
        quoteNo: quote.quoteNo,
        status: quote.status,
        createdAt: quote.createdAt.toISOString(),
        currency: quote.currency,
        incoterms: quote.incoterms,
        validUntil: quote.validUntil,
        paymentTerms: quote.paymentTerms,
        exchangeRate: {
          rate: quote.exchangeRate,
          date: quote.exchangeRateDate,
          source: quote.exchangeRateSource,
        },
        totalAmount: quote.totalAmount,
        profitMarginPct: quote.profitMarginPct,
        items: pdfItems,
        company: {
          name: org?.name ?? '',
          country: org?.country ?? null,
          logoUrl: org?.logoUrl ?? null,
        },
        customerName: customer?.companyName ?? '—',
        customerCountry: customer?.country ?? null,
        contactName: contact?.name ?? null,
        contactEmail: contact?.email ?? null,
      };
    });
    const buffer = renderQuotePdf(payload);
    return { filename: `${payload.quoteNo}.pdf`, buffer };
  }

  // ===== 内部实现 =====

  /** 各档 Tab 计数（all + 五状态） */
  private async tabCounts(tx: Tx, orgId: string): Promise<Record<string, number>> {
    const rows = await tx
      .select({ status: schema.quotation.status, n: count() })
      .from(schema.quotation)
      .where(eq(schema.quotation.orgId, orgId))
      .groupBy(schema.quotation.status);
    const counts: Record<string, number> = {
      all: 0,
      draft: 0,
      waiting_approval: 0,
      sent: 0,
      won: 0,
      lost: 0,
    };
    for (const row of rows) {
      const n = Number(row.n);
      counts[row.status] = n;
      counts.all = (counts.all ?? 0) + n;
    }
    return counts;
  }

  /** 读取报价头（org 隔离；不存在 → 404） */
  private async getQuoteOrThrow(tx: Tx, orgId: string, quoteId: string) {
    const [row] = await tx
      .select()
      .from(schema.quotation)
      .where(and(eq(schema.quotation.id, quoteId), eq(schema.quotation.orgId, orgId)))
      .limit(1);
    if (!row) {
      throw BizException.notFound(`报价不存在: ${quoteId}`);
    }
    return row;
  }

  private async loadItems(tx: Tx, quoteId: string) {
    return tx
      .select()
      .from(schema.quotationItem)
      .where(eq(schema.quotationItem.quotationId, quoteId))
      .orderBy(asc(schema.quotationItem.seq));
  }

  /** 编辑时未传 items → 复用现有明细行作为入参（保持快照语义） */
  private async toItemInputs(tx: Tx, quoteId: string): Promise<QuoteItemDto[]> {
    const rows = await this.loadItems(tx, quoteId);
    return rows.map((r) => ({
      productId: r.productId,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      costSnapshot: r.costSnapshot as QuoteItemDto['costSnapshot'],
    }));
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
        moq: schema.product.moq,
        costPrice: schema.product.costPrice,
        currency: schema.product.currency,
        suggestedPrice: schema.product.suggestedPrice,
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

  private async assertContactExists(tx: Tx, orgId: string, contactId: string): Promise<void> {
    const [row] = await tx
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(and(eq(schema.contact.id, contactId), eq(schema.contact.orgId, orgId)))
      .limit(1);
    if (!row) {
      throw BizException.notFound(`联系人不存在: ${contactId}`);
    }
  }

  /** 解析报价单收件联系人（quote.contactId → 客户主联系人） */
  private async resolveContact(
    tx: Tx,
    orgId: string,
    contactId: string | null,
    customerId: string,
  ): Promise<{ name: string; email: string | null } | null> {
    if (contactId) {
      const [row] = await tx
        .select({ name: schema.contact.name, email: schema.contact.email })
        .from(schema.contact)
        .where(and(eq(schema.contact.id, contactId), eq(schema.contact.orgId, orgId)))
        .limit(1);
      if (row) {
        return row;
      }
    }
    const [primary] = await tx
      .select({ name: schema.contact.name, email: schema.contact.email })
      .from(schema.contact)
      .where(and(eq(schema.contact.customerId, customerId), eq(schema.contact.isPrimary, true)))
      .limit(1);
    return primary ?? null;
  }

  /** focus 明细行（AI 定价入参：按 productId 命中，否则取首行） */
  private async resolveFocusItem(
    tx: Tx,
    orgId: string,
    quoteId: string,
    items: { seq: number; productId: string; quantity: number; unitPrice: string }[],
    dto: AiPricingRequestDto,
  ): Promise<{ productId: string; quantity: number; unitPrice: string }> {
    if (dto.productId) {
      const hit = items.find((i) => i.productId === dto.productId);
      return {
        productId: dto.productId,
        quantity: dto.quantity ?? hit?.quantity ?? 1,
        unitPrice: dto.unitPrice ?? hit?.unitPrice ?? '0.0000',
      };
    }
    const first = items[0];
    if (!first) {
      throw BizException.bizValidation('报价单无明细行，无法生成定价建议（09 §3.2）');
    }
    await this.assertProductExists(tx, orgId, first.productId);
    return {
      productId: first.productId,
      quantity: dto.quantity ?? first.quantity,
      unitPrice: dto.unitPrice ?? first.unitPrice,
    };
  }

  private async assertProductExists(tx: Tx, orgId: string, productId: string): Promise<void> {
    const [row] = await tx
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(and(eq(schema.product.id, productId), eq(schema.product.orgId, orgId)))
      .limit(1);
    if (!row) {
      throw BizException.notFound(`产品不存在: ${productId}`);
    }
  }

  /** 近 90 天同产品成交价区间（sent/won 报价明细；样本 <1 条不产出 reason） */
  private async loadHistory(
    tx: Tx,
    orgId: string,
    productId: string,
  ): Promise<
    { minPrice: string; maxPrice: string; windowDays: number; sampleSize: number } | undefined
  > {
    const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 3600 * 1000);
    const [row] = await tx
      .select({
        minPrice: sql<string>`min(${schema.quotationItem.unitPrice})`,
        maxPrice: sql<string>`max(${schema.quotationItem.unitPrice})`,
        n: count(),
      })
      .from(schema.quotationItem)
      .innerJoin(schema.quotation, eq(schema.quotation.id, schema.quotationItem.quotationId))
      .where(
        and(
          eq(schema.quotation.orgId, orgId),
          eq(schema.quotationItem.productId, productId),
          inArray(schema.quotation.status, ['sent', 'won']),
          gte(schema.quotation.createdAt, since),
        ),
      );
    if (!row || row.minPrice === null || Number(row.n) < 1) {
      return undefined;
    }
    return {
      minPrice: normalizeAmount(row.minPrice, 4),
      maxPrice: normalizeAmount(row.maxPrice, 4),
      windowDays: HISTORY_WINDOW_DAYS,
      sampleSize: Number(row.n),
    };
  }

  /**
   * 外发报价单（走 16 系统设置邮箱通道；无可用邮箱/收件人 → 42201，发送失败 → 50301）。
   * 与 06 §2.4 唯一发信出口同源：createMailboxDriver 真实驱动 sendMessage。
   */
  private async sendQuoteEmail(
    tx: Tx,
    orgId: string,
    quote: {
      quoteNo: string;
      currency: string;
      totalAmount: string;
      validUntil: string;
      incoterms: string;
      paymentTerms: string;
    },
    recipient: string | null,
    customerName: string,
  ): Promise<string> {
    if (!recipient) {
      throw BizException.bizValidation('客户缺少联系人邮箱，无法外发报价（09 §3.4）');
    }
    const [mailboxRow] = await tx
      .select()
      .from(schema.mailbox)
      .where(and(eq(schema.mailbox.orgId, orgId), eq(schema.mailbox.status, 'connected')))
      .limit(1);
    if (!mailboxRow) {
      throw BizException.bizValidation('无可用邮箱连接，无法外发（16 系统设置）');
    }
    const driver = createMailboxDriver(
      {
        mailboxId: mailboxRow.id,
        orgId: mailboxRow.orgId,
        provider: mailboxRow.provider,
        account: mailboxRow.account,
        imap: mailboxRow.imap,
        smtp: mailboxRow.smtp,
        oauth: mailboxRow.oauth,
        syncScope: mailboxRow.syncScope,
      },
      this.driverOptions,
    );
    const subject = `Quotation ${quote.quoteNo}`;
    const text = [
      `Dear ${customerName},`,
      '',
      `Please find our quotation ${quote.quoteNo}:`,
      `- Amount: ${quote.currency} ${quote.totalAmount}`,
      `- Incoterms: ${quote.incoterms}`,
      `- Valid Until: ${quote.validUntil}`,
      `- Payment Terms: ${quote.paymentTerms}`,
      '',
      'Best regards',
    ].join('\n');
    try {
      const sent = await driver.sendMessage({
        from: mailboxRow.account,
        to: [recipient.toLowerCase()],
        subject,
        text,
      });
      return sent.externalId;
    } catch (err) {
      const authFailed = isMailboxAuthError(err);
      const detail = err instanceof Error ? err.message : String(err);
      throw BizException.dependencyUnavailable(
        `${authFailed ? '邮箱凭据失效或授权过期' : '报价发送失败'}: ${detail}`,
      );
    }
  }

  /** 邮箱驱动选项（凭据解密 + OAuth 客户端凭据，06 §2.4） */
  private get driverOptions(): MailboxDriverOptions {
    const env = this.env.env;
    return {
      encryptionKey: env.ENCRYPTION_KEY,
      oauth: {
        googleClientId: env.GOOGLE_CLIENT_ID || undefined,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
        microsoftClientId: env.MICROSOFT_CLIENT_ID || undefined,
        microsoftClientSecret: env.MICROSOFT_CLIENT_SECRET || undefined,
      },
    };
  }

  /** 写客户活动流水（05 §2；operatorType=user） */
  private async writeActivity(
    tx: Tx,
    input: {
      orgId: string;
      userId: string;
      customerId: string;
      type: 'quote' | 'stage_change' | 'note';
      summary: string;
      refId: string;
      refType: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<void> {
    const [user] = await tx
      .select({ name: schema.userAccount.name })
      .from(schema.userAccount)
      .where(eq(schema.userAccount.id, input.userId))
      .limit(1);
    await tx.insert(schema.customerActivity).values({
      id: createId('act'),
      orgId: input.orgId,
      customerId: input.customerId,
      type: input.type,
      summary: input.summary,
      operatorType: 'user',
      operatorId: input.userId,
      operatorName: user?.name ?? null,
      refType: input.refType,
      refId: input.refId,
    });
  }

  /** 报价编号分配 `QT-YYYYMMDD-NNN`（同 org 同日递增；DB uq_quote_org_no 兜底） */
  private async allocateQuoteNo(tx: Tx, orgId: string): Promise<string> {
    const datePart = todayIso().replace(/-/g, '');
    const prefix = `QT-${datePart}-`;
    const [row] = await tx
      .select({ quoteNo: schema.quotation.quoteNo })
      .from(schema.quotation)
      .where(
        and(
          eq(schema.quotation.orgId, orgId),
          sql`${schema.quotation.quoteNo} like ${`${prefix}%`}`,
        ),
      )
      .orderBy(desc(schema.quotation.quoteNo))
      .limit(1);
    const lastSeq = row ? Number(row.quoteNo.slice(prefix.length)) : 0;
    const next = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;
    return `${prefix}${String(next).padStart(3, '0')}`;
  }
}

// ===== 模块级辅助 =====

/** 今天 `YYYY-MM-DD`（UTC；报价有效期比较口径与编号规则一致） */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `validUntil <= 今天` → 42201（§3.1） */
function assertValidUntil(validUntil: string): void {
  if (validUntil <= todayIso()) {
    throw BizException.bizValidation(`有效期必须晚于今天（当前: ${validUntil}，09 §3.1）`);
  }
}

/** 汇率快照（缺省回落 16 `exchangeRateSource` + 当天 + 1.0 同币种，MVP 人工维护） */
function resolveExchangeRate(
  dto: { rate: string; date?: string; source?: string } | undefined,
  fallback: ExchangeRateSnapshot | null,
  rules: PricingRulesView,
): ExchangeRateSnapshot {
  return buildExchangeRateSnapshot({
    rate: dto?.rate ?? fallback?.rate ?? '1',
    date: dto?.date ?? fallback?.date ?? todayIso(),
    source: dto?.source ?? fallback?.source ?? rules.exchangeRateSource,
  });
}

/** 启用成本项（16 `costItems` ∩ 引擎五项；缺省五项全启用） */
function enabledCostItems(rules: PricingRulesView): CostItemKey[] {
  const picked = rules.costItems.filter((item): item is CostItemKey =>
    (COST_ITEM_KEYS as readonly string[]).includes(item),
  );
  return picked.length > 0 ? picked : [...COST_ITEM_KEYS];
}

/** 采购成本换算到报价币种（同币种直接取；MVP 汇率源为报价时点快照） */
function purchaseCostInCurrency(product: ProductRow, quoteCurrency: string, rate: string): string {
  if (product.currency.toUpperCase() === quoteCurrency.toUpperCase()) {
    return normalizeAmount(product.costPrice, 2);
  }
  return normalizeAmount(Number(product.costPrice) * Number(rate), 2);
}

/** 明细行核算（MOQ 校验 + 单价/行总价 + 五项成本快照；draft 可人工覆盖） */
function buildLines(
  items: QuoteItemDto[],
  products: Map<string, ProductRow>,
  quoteCurrency: string,
  exchange: ExchangeRateSnapshot,
  rules: PricingRulesView,
): ResolvedLine[] {
  return items.map((item, index) => {
    const product = products.get(item.productId);
    if (!product) {
      throw BizException.notFound(`产品不存在: ${item.productId}`);
    }
    if (item.quantity < product.moq) {
      throw BizException.bizValidation(
        `数量 ${item.quantity} 低于起订量 MOQ ${product.moq}（产品 ${product.name}，09 §3.1）`,
      );
    }
    const unitPrice = normalizeAmount(item.unitPrice, 4);
    const lineTotal = scaledToAmount(
      (amountToScaledBigInt(unitPrice, 4) * BigInt(item.quantity) + 50n) / 100n,
      2,
    );
    const engine = computeUnitCosts({
      unitPrice,
      purchaseCost: purchaseCostInCurrency(product, quoteCurrency, exchange.rate),
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

/** 行级快照归一（schema 侧 jsonb → core 五项快照，缺项补 0；避免跨包类型不可命名） */
function toCoreCostSnapshot(raw: Record<string, unknown> | null | undefined): CostSnapshot {
  const snapshot: CostSnapshot = {};
  for (const key of COST_ITEM_KEYS) {
    snapshot[key] = Number(raw?.[key] ?? 0);
  }
  return snapshot;
}

/** 报价总额（各行 lineTotal 汇总，定标 2 位） */
function sumLineTotals(lines: ResolvedLine[]): string {
  const total = lines.reduce((acc, line) => acc + amountToScaledBigInt(line.lineTotal, 2), 0n);
  return scaledToAmount(total, 2);
}

/** 落库明细行（seq 连续，满足 uq_quote_item_seq） */
async function insertItems(
  tx: Tx,
  orgId: string,
  quoteId: string,
  lines: ResolvedLine[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }
  await tx.insert(schema.quotationItem).values(
    lines.map((line) => ({
      id: createId('qitem'),
      orgId,
      quotationId: quoteId,
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

/** quote 审批超时小时（16 role_permission.approval_rules；缺省 48h，12 §7.2） */
async function resolveQuoteExpireHours(tx: Tx, orgId: string, role: string): Promise<number> {
  const [row] = await tx
    .select({ approvalRules: schema.rolePermission.approvalRules })
    .from(schema.rolePermission)
    .where(
      and(eq(schema.rolePermission.orgId, orgId), sql`${schema.rolePermission.role} = ${role}`),
    )
    .limit(1);
  const rule = row?.approvalRules?.find((r) => r.approvalType === 'quote');
  return typeof rule?.expireHours === 'number' && rule.expireHours > 0
    ? rule.expireHours
    : DEFAULT_APPROVAL_TTL_HOURS;
}
