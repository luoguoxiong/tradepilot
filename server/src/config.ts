import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3020),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6393'),
  APP_ENCRYPTION_KEY: z.string().default(''), // 阶段 5 integrations 加密用；空则启动时警告
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars').default('dev-insecure-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  LLM_BASE_URL: z.string().default('https://api.deepseek.com/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('deepseek-chat'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** 环境变量经 zod 校验后唯一出口；启动即 fail-fast */
export function getEnv(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid environment variables: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
