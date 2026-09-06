import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { orderRisk, orderStatus, quoteStatus } from './enums.js';
import { org, userAccount } from './01-org-user.js';
import { contact, customer } from './04-customer.js';
import { product } from './06-product-knowledge.js';

/**
 * ER 07 · 报价与订单模块（6 表）。
 * quotation.approval_id 的 FK 由 manual 迁移补齐（08 建表后，ER 07 §3 注）。
 */

/** 五项成本快照（09 §7）：purchase/freight/insurance/tax/fx */
export interface CostSnapshot {
  purchase?: number;
  freight?: number;
  insurance?: number;
  tax?: number;
  fx?: number;
  [k: string]: unknown;
}

export const quotation = pgTable(
  'quotation',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    quoteNo: text('quote_no').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customer.id),
    contactId: text('contact_id').references(() => contact.id),
    currency: char('currency', { length: 3 }).notNull(),
    incoterms: text('incoterms').notNull(),
    validUntil: date('valid_until').notNull(),
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }).notNull(),
    exchangeRateDate: date('exchange_rate_date').notNull(),
    exchangeRateSource: text('exchange_rate_source').notNull(),
    paymentTerms: text('payment_terms').notNull(),
    totalAmount: numeric('total_amount', { precision: 18, scale: 2 }).notNull(),
    status: quoteStatus('status').notNull().default('draft'),
    aiPricing: jsonb('ai_pricing').$type<Record<string, unknown>>(),
    profitMarginPct: numeric('profit_margin_pct', { precision: 5, scale: 2 }),
    // FK→approval_request 由 manual 迁移补齐（08 建表后）
    approvalId: text('approval_id'),
    ownerId: text('owner_id')
      .notNull()
      .references(() => userAccount.id),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    wonAt: timestamp('won_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    createdBy: text('created_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_quote_org_no').on(t.orgId, t.quoteNo),
    index('idx_quote_org_status').on(t.orgId, t.status, t.createdAt.desc()),
    index('idx_quote_customer').on(t.customerId),
    index('idx_quote_owner').on(t.orgId, t.ownerId),
  ],
);

export const quotationItem = pgTable(
  'quotation_item',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    quotationId: text('quotation_id')
      .notNull()
      .references(() => quotation.id),
    seq: smallint('seq').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    /** 产品名快照（防产品改名影响历史单据） */
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 18, scale: 2 }).notNull(),
    costSnapshot: jsonb('cost_snapshot').$type<CostSnapshot>().notNull().default({}),
  },
  (t) => [unique('uq_quote_item_seq').on(t.quotationId, t.seq)],
);

export const salesOrder = pgTable(
  'sales_order',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    orderNo: text('order_no').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customer.id),
    contactId: text('contact_id').references(() => contact.id),
    /** 来源报价（须 won，10 §3.1） */
    quotationId: text('quotation_id').references(() => quotation.id),
    deliveryDate: date('delivery_date').notNull(),
    paymentTerms: text('payment_terms'),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: orderStatus('status').notNull().default('pending_payment'),
    risk: orderRisk('risk').notNull().default('normal'),
    progressPoConfirmed: boolean('progress_po_confirmed').notNull().default(false),
    progressPayment: boolean('progress_payment').notNull().default(false),
    productionPct: smallint('production_pct').notNull().default(0),
    progressShipping: boolean('progress_shipping').notNull().default(false),
    ownerId: text('owner_id')
      .notNull()
      .references(() => userAccount.id),
    createdBy: text('created_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_order_org_no').on(t.orgId, t.orderNo),
    index('idx_order_org_status').on(t.orgId, t.status, t.createdAt.desc()),
    index('idx_order_org_risk')
      .on(t.orgId, t.risk)
      .where(sql`risk = 'at_risk'`),
    index('idx_order_customer').on(t.customerId),
    index('idx_order_delivery').on(t.orgId, t.deliveryDate),
  ],
);

export const salesOrderItem = pgTable(
  'sales_order_item',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    salesOrderId: text('sales_order_id')
      .notNull()
      .references(() => salesOrder.id),
    seq: smallint('seq').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 18, scale: 2 }).notNull(),
    /** 转订单从报价行原样复制；手工建单由定价引擎核算（10 v0.2.1） */
    costSnapshot: jsonb('cost_snapshot').$type<CostSnapshot>().notNull().default({}),
  },
  (t) => [unique('uq_order_item_seq').on(t.salesOrderId, t.seq)],
);

export const orderRiskInsight = pgTable(
  'order_risk_insight',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    salesOrderId: text('sales_order_id')
      .notNull()
      .references(() => salesOrder.id),
    delayDays: smallint('delay_days').notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    suggestions: jsonb('suggestions')
      .$type<{ suggestionId: string; type: string; label: string }[]>()
      .notNull()
      .default([]),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    status: text('status').notNull().default('active'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_orisk_order').on(t.salesOrderId, t.generatedAt.desc())],
);

export const orderProgressLog = pgTable(
  'order_progress_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    salesOrderId: text('sales_order_id')
      .notNull()
      .references(() => salesOrder.id),
    productionPct: smallint('production_pct').notNull(),
    note: text('note'),
    updatedBy: text('updated_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_oplog_order').on(t.salesOrderId, t.createdAt.desc())],
);
