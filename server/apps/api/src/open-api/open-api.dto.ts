/**
 * 开放 API 与出站 Webhook DTO（16 FR-11 / 后端技术方案 06 §5）。
 * 白名单取自 @tradepilot/shared 注册表，避免脏 scope / 脏事件写入。
 */
import { z } from 'zod';
import { API_SCOPE_LIST, WEBHOOK_EVENT_LIST } from '@tradepilot/shared';

const scopeSchema = z.string().refine((v) => API_SCOPE_LIST.includes(v), { message: '未知 scope' });

const eventSchema = z
  .string()
  .refine((v) => WEBHOOK_EVENT_LIST.includes(v), { message: '未支持的事件类型' });

/** 创建 API Key（明文仅响应体返回一次，06 §5.1） */
export const createApiKeySchema = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(scopeSchema).min(1).max(API_SCOPE_LIST.length),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

/** 创建 Webhook 订阅（secret 入库前 AES-256-GCM 加密，06 §5.2） */
export const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(eventSchema).min(1).max(WEBHOOK_EVENT_LIST.length),
  /** 签名密钥：订阅方自行保管并验签；接口永不回显 */
  secret: z.string().min(16).max(128),
});
export type CreateWebhookDto = z.infer<typeof createWebhookSchema>;
