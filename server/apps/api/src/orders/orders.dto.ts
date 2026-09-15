/**
 * 10 订单中心 DTO（页面级字段与接口文档 10 §1/§2/§3，P1）。
 *
 * 边界说明（10 §4 AI 边界）：
 * - 金额/交期/数量（items）变更一律走 order_change 高危审批，不直接落库；
 * - 状态与进度由 PUT /orders/{id}/progress 写进度四要素后推导（决策 A3）。
 */
import { z } from 'zod';

/** §1.2 状态 Tab 取值（all 为聚合 Tab） */
export const ORDER_STATUS_VALUES = [
  'pending_payment',
  'in_production',
  'ready_to_ship',
  'completed',
] as const;
export type OrderStatusValue = (typeof ORDER_STATUS_VALUES)[number];

export const ORDER_TAB_VALUES = ['all', ...ORDER_STATUS_VALUES] as const;
export type OrderTabValue = (typeof ORDER_TAB_VALUES)[number];

/** §1.2 风险徽标取值 */
export const ORDER_RISK_VALUES = ['normal', 'at_risk'] as const;
export type OrderRiskValue = (typeof ORDER_RISK_VALUES)[number];

const CURRENCY_VALUES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'AUD', 'CAD'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dateSchema = z.string().trim().regex(DATE_PATTERN, '日期格式应为 YYYY-MM-DD');

/** 金额输入：接受 number 或数字字符串，统一转 number（精度由服务端 scaled 计算兜底） */
function amountInput(message: string, positive = false) {
  return z
    .union([z.number(), z.string().trim().min(1)])
    .transform((value) => (typeof value === 'number' ? value : Number(value)))
    .refine((value) => Number.isFinite(value), { message: '金额必须为数字' })
    .refine((value) => (positive ? value > 0 : value >= 0), { message });
}

/** 成本快照（手工建单可显式传，缺省由定价规则引擎核算，10 FR-03） */
export const costSnapshotSchema = z.record(z.string(), z.number()).optional();

/** §1.2 progress 进度四要素（PUT 为部分更新） */
export const orderProgressSchema = z.object({
  poConfirmed: z.boolean().optional(),
  payment: z.boolean().optional(),
  productionPct: z.number().int().min(0).max(100).optional(),
  shipping: z.boolean().optional(),
});
export type OrderProgressDto = z.infer<typeof orderProgressSchema>;

/** §1.2 明细行（转单时缺省从报价单快照复制） */
export const orderItemSchema = z.object({
  productId: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive('数量需为正整数'),
  unitPrice: amountInput('unitPrice 需为正数', true),
  costSnapshot: costSnapshotSchema,
});
export type OrderItemDto = z.infer<typeof orderItemSchema>;

/** §3.1 创建订单：fromQuoteId 转单（前置报价 state=won）或手工建单 */
export const createOrderSchema = z
  .object({
    customerId: z.string().trim().min(1).max(64).optional(),
    items: z.array(orderItemSchema).min(1).max(200).optional(),
    deliveryDate: dateSchema,
    paymentTerms: z.string().trim().max(500).optional(),
    currency: z.enum(CURRENCY_VALUES).default('USD'),
    fromQuoteId: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.fromQuoteId) return;
    if (!value.customerId) {
      ctx.addIssue({ code: 'custom', path: ['customerId'], message: '手工建单需提供 customerId' });
    }
    if (!value.items || value.items.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: '手工建单至少需要一条明细行' });
    }
  });
export type CreateOrderDto = z.infer<typeof createOrderSchema>;

/** §3.2 变更订单：交期/金额/数量任一 → order_change 审批（10 FR-03） */
export const updateOrderSchema = z
  .object({
    deliveryDate: dateSchema.optional(),
    amount: amountInput('amount 需为非负数').optional(),
    items: z.array(orderItemSchema).min(1).max(200).optional(),
  })
  .refine(
    (value) =>
      value.deliveryDate !== undefined || value.amount !== undefined || value.items !== undefined,
    { message: '至少提交一项变更（deliveryDate / amount / items）' },
  );
export type UpdateOrderDto = z.infer<typeof updateOrderSchema>;

/** §3.3 更新履约进度（状态由四要素推导，决策 A3） */
export const updateOrderProgressSchema = z.object({
  progress: orderProgressSchema,
});
export type UpdateOrderProgressDto = z.infer<typeof updateOrderProgressSchema>;

/** §3.5 执行风险建议（internal → 建任务；customer → 建审批/草稿） */
export const executeOrderRiskSchema = z.object({
  suggestionIds: z.array(z.string().trim().min(1).max(32)).min(1).max(10),
});
export type ExecuteOrderRiskDto = z.infer<typeof executeOrderRiskSchema>;

/** §2 列表筛选（tab 与 status 二选一，tab 优先） */
export const listOrdersQuerySchema = z.object({
  tab: z.enum(ORDER_TAB_VALUES).optional(),
  status: z.enum(ORDER_STATUS_VALUES).optional(),
  customerId: z.string().trim().min(1).max(64).optional(),
  risk: z.enum(ORDER_RISK_VALUES).optional(),
});
export type ListOrdersQueryDto = z.infer<typeof listOrdersQuerySchema>;
