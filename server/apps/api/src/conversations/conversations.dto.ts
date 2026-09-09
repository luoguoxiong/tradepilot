/**
 * 06 AI 销售工作台 DTO（接口 06 §2/§3，M5-A3 读侧 + M5-C1/C2 写侧）：
 * - 读侧：列表（§3.1）/ 详情（§2）/ copilot（§1.3）；
 * - 写侧：ai-draft / regenerate（§3.2）、PUT /messages（编辑留痕）、send（§3.3 双分支）、
 *   copilot/suggestions/apply（§3.4）、ask-ai（§3.5）。
 */
import { z } from 'zod';

/** query 布尔参数：仅认 'true'（'false'/缺省均视为未开启） */
const trueOnlyQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

export const listConversationsQuerySchema = z.object({
  priority: z.enum(['high', 'normal', 'pending']).optional(),
  /** 仅未读会话（FR-01） */
  unreadOnly: trueOnlyQuery,
  /** 多邮箱来源筛选（FR-11） */
  mailboxId: z.string().min(1).optional(),
  /** 数据范围（缺省取角色上限，接口总览 §4.4） */
  scope: z.enum(['self', 'team', 'all']).optional(),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

// ===== M5-C1/C2 写侧 DTO（06 §3.2~§3.5）=====

/** §3.2 POST /conversations/{id}/ai-draft（regenerate 同构）；basedOnMessageId 必填（缺失 40001） */
export const aiDraftSchema = z.object({
  basedOnMessageId: z.string().trim().min(1, 'basedOnMessageId 必填（06 §3.2）'),
  /** 附加生成指示（语气/强调点等，可选） */
  instruction: z.string().trim().max(2000).optional(),
});
export type AiDraftDto = z.infer<typeof aiDraftSchema>;

/** PUT /messages/{id}：编辑/保存草稿（content 空 → 42201 由服务层判定，编辑差异留痕） */
export const updateMessageSchema = z.object({
  content: z.string().max(100_000).optional(),
});
export type UpdateMessageDto = z.infer<typeof updateMessageSchema>;

/** §3.3 POST /conversations/{id}/send：messageId 必填；content 可选（非空则回写最终编辑） */
export const sendMessageSchema = z.object({
  messageId: z.string().trim().min(1, 'messageId 必填（06 §3.3）'),
  content: z.string().max(100_000).optional(),
});
export type SendMessageDto = z.infer<typeof sendMessageSchema>;

/** §3.5 POST /conversations/{id}/ask-ai：question 非空（缺失 40001） */
export const askAiSchema = z.object({
  question: z.string().trim().min(1, 'question 必填（06 §3.5）').max(2000),
});
export type AskAiDto = z.infer<typeof askAiSchema>;

/** §3.4 POST /copilot/suggestions/apply：内容型插入草稿 / 流程型创建任务 */
export const suggestionsApplySchema = z.object({
  conversationId: z.string().trim().min(1, 'conversationId 必填（06 §3.4）'),
  suggestionIds: z.array(z.string().trim().min(1)).min(1, 'suggestionIds 至少一项'),
  mode: z.enum(['insert_draft', 'create_tasks']),
});
export type SuggestionsApplyDto = z.infer<typeof suggestionsApplySchema>;
