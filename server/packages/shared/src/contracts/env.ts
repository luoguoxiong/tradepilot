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
  /** Gmail OAuth 客户端（gmail 驱动连接测试/同步发信；M4 §2.4） */
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  /** Outlook OAuth 客户端（outlook 驱动；M4 §2.4） */
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  /** S3 兼容对象存储（MinIO，知识原文 07 §2；缺省对齐 docker-compose 本地值） */
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_BUCKET: z.string().default('tradepilot-local'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().default('tradepilot'),
  S3_SECRET_ACCESS_KEY: z.string().default('tradepilot_dev'),
  /** 嵌入服务（07 §2：mock = 确定性向量，测试/离线可用；openai = OpenAI 兼容接口） */
  EMBEDDING_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
  EMBEDDING_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  /** 搜索供应商（06 §3：mock = 确定性 mock；http = Serper 兼容搜索 API） */
  SEARCH_PROVIDER: z.enum(['mock', 'http']).default('mock'),
  SEARCH_BASE_URL: z.string().default('https://google.serper.dev'),
  SEARCH_API_KEY: z.string().default(''),
  /** org 级搜索/抓取日额度（06 §3 令牌桶，按 org 时区日界轮换） */
  ORG_SEARCH_DAILY_LIMIT: z.coerce.number().int().min(1).default(2000),
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
  /** 凭据加密主密钥（收发/同步瞬间解密凭据与 OAuth token，06 §2.4） */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY 必须为 64 位 hex'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  /** S3 兼容对象存储（MinIO，知识原文 07 §2；缺省对齐 docker-compose 本地值） */
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_BUCKET: z.string().default('tradepilot-local'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().default('tradepilot'),
  S3_SECRET_ACCESS_KEY: z.string().default('tradepilot_dev'),
  /** 嵌入服务（07 §2：mock = 确定性向量，测试/离线可用；openai = OpenAI 兼容接口） */
  EMBEDDING_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
  EMBEDDING_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  /** 搜索供应商（06 §3：mock = 确定性 mock；http = Serper 兼容搜索 API） */
  SEARCH_PROVIDER: z.enum(['mock', 'http']).default('mock'),
  SEARCH_BASE_URL: z.string().default('https://google.serper.dev'),
  SEARCH_API_KEY: z.string().default(''),
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
