/**
 * 环境变量契约（后端技术方案 09 §4，Zod fail-fast）。
 * 配置差异全部经环境变量；业务配置（org 级）一律读库，不进环境变量。
 */
import { z } from 'zod';

/** api 与 worker 共享的基础变量 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL 必填'),
  REDIS_URL: z.string().min(1, 'REDIS_URL 必填'),

  /** 雪花机器位（02 §9，多实例按序分配） */
  WORKER_INDEX: z.coerce.number().int().min(0).max(1023).default(1),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** apps/api 专用 */
export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符'),
  /** 凭据加密主密钥：64 位 hex（32 字节，08 §2） */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY 必须为 64 位 hex'),
  SCHED_DATABASE_URL: z.string().min(1).optional(),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** apps/worker 专用 */
export const workerEnvSchema = baseEnvSchema.extend({
  /** 该实例消费的队列组（逗号分隔；缺省 = 全部队列） */
  WORKER_QUEUES: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((q) => q.trim())
        .filter((q) => q.length > 0),
    ),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * 解析并校验环境变量（fail-fast：缺失/不合法直接抛错终止启动）。
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`环境变量校验失败（fail-fast）→ ${issues}`);
  }
  return result.data;
}
