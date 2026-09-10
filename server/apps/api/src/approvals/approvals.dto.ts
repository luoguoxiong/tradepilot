import { z } from 'zod';

/**
 * 审核中心契约（接口 12 §3，P0）：
 * summary/list/detail/approve/reject/logs；仅 pending 可处置，expired 处置返回 42201（12 §3.3）。
 * P0 实际来源 = email_send（medium）+ customer_delete（high）；其余类型枚举保留（低风险不进审批中心）。
 */

export const approvalTypeSchema = z.enum([
  'quote',
  'email_send',
  'contract',
  'order_change',
  'bulk_marketing',
  'customer_delete',
]);
export type ApprovalTypeDto = z.infer<typeof approvalTypeSchema>;

export const approvalStatusSchema = z.enum([
  'pending',
  'auto_approved',
  'approved',
  'edited_approved',
  'rejected',
  'expired',
]);

/**
 * 12 §3.2 列表状态筛选：`pending`（待审）/ `processed`（已处置历史）。
 * processed = approved / edited_approved / rejected / auto_approved
 * （与前端 mock 契约一致；expired 为系统超时终态，不进入「已处置」列表）。
 */
export const listApprovalsStatusSchema = z.union([z.literal('pending'), z.literal('processed')]);

export const listApprovalsQuerySchema = z.object({
  type: approvalTypeSchema.optional(),
  status: listApprovalsStatusSchema.optional(),
});
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;

/** 12 §3.3 批准（二选一：approve / edited_approved + editedContent.aiProposal） */
export const approveApprovalSchema = z
  .object({
    action: z.enum(['approve', 'edited_approved']),
    /** edited_approved 时必填：编辑后的 aiProposal 字段（字段级合并，editedDiff 留痕） */
    editedContent: z
      .object({
        aiProposal: z.record(z.unknown()),
      })
      .optional(),
  })
  .refine((v) => v.action !== 'edited_approved' || v.editedContent !== undefined, {
    message: 'edited_approved 必须携带 editedContent',
  });
export type ApproveApprovalDto = z.infer<typeof approveApprovalSchema>;

/** 12 §3.4 拒绝（必填原因，缺失 42201） */
export const rejectApprovalSchema = z.object({
  reason: z.string().trim().min(1, '拒绝原因必填（12 §3.4）').max(500),
});
export type RejectApprovalDto = z.infer<typeof rejectApprovalSchema>;
