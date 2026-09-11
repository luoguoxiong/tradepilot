/**
 * vitest 全局测试装配（真实 provider，无 mock）：
 * 1) 加载 server/.env.test（自本文件逐级上溯查找）；文件缺失或必需项缺失 → 直接抛错，
 *    全部用例 fail-fast（不再有 mock 兜底）；
 * 2) 按配置注入真实 embedding / search 供应商与 S3 对象存储（本地 MinIO）；
 * 3) 导出真实 LLM / 邮箱配置供用例装配 LlmGateway、SmtpImapDriver 复用。
 *
 * 用例内需按 org 覆盖解析时（如验证「系统设置 → AI 模型配置」路由）可再调
 * setEmbeddingProviderFactory / setSearchProviderFactory，但同样不得回落 mock。
 *
 * 注：apps/worker 有同名文件，两者需保持一致（两个 app 各自独立运行 vitest）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { encryptSecret } from '@tradepilot/core';
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  configureObjectStorage,
  createEmbeddingProvider,
  createS3Storage,
  createSearchProvider,
  setEmbeddingProviderFactory,
  setSearchProviderFactory,
  type MailboxDriverRow,
} from '@tradepilot/integrations';
import type { LlmProvider } from '@tradepilot/runtime';

// ===== 1. 定位并加载 server/.env.test =====

const ENV_TEST_FILENAME = '.env.test';
const ENV_TEST_EXAMPLE = '.env.test.example';

function locateEnvTestFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, ENV_TEST_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `测试配置缺失：未找到 ${ENV_TEST_FILENAME}（自 ${fileURLToPath(import.meta.url)} 逐级上溯）。` +
      `请复制 server/${ENV_TEST_EXAMPLE} 为 server/${ENV_TEST_FILENAME} 并填写真实 provider 配置；` +
      '测试不再提供 mock 兜底，未配置即失败。',
  );
}

/** 极简 .env 解析：`KEY=VALUE` / `export KEY=VALUE`（仅补齐缺失键，shell 已注入优先） */
function applyEnvFile(filePath: string): void {
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, raw = ''] = match;
    if (key === undefined || process.env[key] !== undefined) continue;
    let value = raw.trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(' #');
      if (commentAt !== -1) value = value.slice(0, commentAt).trim();
    }
    process.env[key] = value;
  }
}

applyEnvFile(locateEnvTestFile());

const testEnvSchema = z.object({
  TEST_LLM_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'azure']),
  TEST_LLM_MODEL: z.string().min(1, '不能为空'),
  TEST_LLM_API_KEY: z.string().min(1, '不能为空'),
  TEST_LLM_BASE_URL: z.string().default(''),

  TEST_EMBEDDING_MODEL: z.string().min(1, '不能为空'),
  TEST_EMBEDDING_API_KEY: z.string().min(1, '不能为空'),
  TEST_EMBEDDING_BASE_URL: z.string().min(1).default('https://api.openai.com/v1'),
  TEST_EMBEDDING_DIMENSIONS: z.coerce.number().int().default(KNOWLEDGE_EMBEDDING_DIMENSIONS),

  TEST_SEARCH_BASE_URL: z.string().min(1, '不能为空'),
  TEST_SEARCH_API_KEY: z.string().min(1, '不能为空'),

  TEST_S3_ENDPOINT: z.string().min(1).default('http://localhost:9000'),
  TEST_S3_BUCKET: z.string().min(1).default('tradepilot-test'),
  TEST_S3_REGION: z.string().min(1).default('us-east-1'),
  TEST_S3_ACCESS_KEY_ID: z.string().min(1).default('tradepilot'),
  TEST_S3_SECRET_ACCESS_KEY: z.string().min(1).default('tradepilot_dev'),

  TEST_MAIL_HOST: z.string().min(1).default('127.0.0.1'),
  TEST_MAIL_SMTP_PORT: z.coerce.number().int().default(1025),
  TEST_MAIL_IMAP_PORT: z.coerce.number().int().default(1114),
  TEST_MAIL_USER: z.string().default('greenmail'),
  TEST_MAIL_PASSWORD: z.string().default('greenmail'),
});

const parsed = testEnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(
    `测试 provider 配置不完整（server/${ENV_TEST_FILENAME}）→ ${issues}。` +
      '测试不再提供 mock 兜底，未配置即失败。',
  );
}
export const testEnv = parsed.data;

if (testEnv.TEST_EMBEDDING_DIMENSIONS !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
  throw new Error(
    `测试向量模型维度不匹配：TEST_EMBEDDING_DIMENSIONS=${testEnv.TEST_EMBEDDING_DIMENSIONS}，` +
      `须为 ${KNOWLEDGE_EMBEDDING_DIMENSIONS}（knowledge_chunk.embedding = vector(1536)）。`,
  );
}

// ===== 2. provider 装配（真实实现）=====

setEmbeddingProviderFactory(() =>
  createEmbeddingProvider({
    provider: 'openai',
    baseUrl: testEnv.TEST_EMBEDDING_BASE_URL,
    apiKey: testEnv.TEST_EMBEDDING_API_KEY,
    model: testEnv.TEST_EMBEDDING_MODEL,
    dimensions: testEnv.TEST_EMBEDDING_DIMENSIONS,
  }),
);

setSearchProviderFactory(() =>
  createSearchProvider({
    provider: 'http',
    baseUrl: testEnv.TEST_SEARCH_BASE_URL,
    apiKey: testEnv.TEST_SEARCH_API_KEY,
  }),
);

/** 测试对象存储（本地 MinIO；用例需在 beforeAll 调 ensureTestBucket()） */
export const testObjectStorage = createS3Storage({
  endpoint: testEnv.TEST_S3_ENDPOINT,
  bucket: testEnv.TEST_S3_BUCKET,
  region: testEnv.TEST_S3_REGION,
  accessKeyId: testEnv.TEST_S3_ACCESS_KEY_ID,
  secretAccessKey: testEnv.TEST_S3_SECRET_ACCESS_KEY,
});
configureObjectStorage(testObjectStorage);

let bucketReady: Promise<void> | null = null;

/** 确保测试桶存在（幂等，首次调用真正建桶；失败不缓存以便重试） */
export function ensureTestBucket(): Promise<void> {
  bucketReady ??= testObjectStorage.ensureBucket().catch((err: unknown) => {
    bucketReady = null;
    throw err;
  });
  return bucketReady;
}

/** LlmGateway 构造参数（真实 LLM；用例按需再叠加 encryptionKey 等） */
export const testLlmOptions: {
  provider: LlmProvider;
  defaultModel: string;
  apiKey: string;
  baseUrl?: string;
} = {
  provider: testEnv.TEST_LLM_PROVIDER,
  defaultModel: testEnv.TEST_LLM_MODEL,
  apiKey: testEnv.TEST_LLM_API_KEY,
  ...(testEnv.TEST_LLM_BASE_URL ? { baseUrl: testEnv.TEST_LLM_BASE_URL } : {}),
};

/** 测试邮箱（GreenMail）连接参数 */
export const testMail = {
  host: testEnv.TEST_MAIL_HOST,
  smtpPort: testEnv.TEST_MAIL_SMTP_PORT,
  imapPort: testEnv.TEST_MAIL_IMAP_PORT,
  user: testEnv.TEST_MAIL_USER,
  password: testEnv.TEST_MAIL_PASSWORD,
} as const;

/**
 * 构造 smtp_imap 邮箱驱动行（GreenMail：任意收件人自动建箱、任意凭据可登录，
 * 收件地址即邮箱用户名）。
 */
export function testMailboxRow(
  account: string,
  mailboxId: string,
  orgId: string,
  encryptionKey: string,
): MailboxDriverRow {
  const credential = { credential_enc: encryptSecret(testMail.password, encryptionKey) };
  return {
    mailboxId,
    orgId,
    provider: 'smtp_imap',
    account,
    imap: { host: testMail.host, port: testMail.imapPort, ssl: false, ...credential },
    smtp: { host: testMail.host, port: testMail.smtpPort, ssl: false, ...credential },
    syncScope: { historyDays: 90, folders: ['INBOX'] },
  };
}
