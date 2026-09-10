/**
 * M5-D3 16 AI 模型配置（扩展）· ai_model 台账 + org 级全局选用：
 * - llm / embedding / search 三类配置清单 CRUD；
 * - 首建自动选中；selection 切换（每 type 至多一个 selected）；
 * - 删除生效模型自动回退；apiKey 加密落库（响应不回显，resolveActiveModel 可解密）；
 * - embedding 必须指定向量维度（且须与知识索引 vector(1536) 一致）；
 * - search（搜索供应商）provider 限 http/mock，http 必须有端点与凭据；
 * - 运行时接入：选用模型驱动 LlmGateway.resolveTarget / Embedding Provider / Search Provider（全服务统一口径）。
 * 前置：docker compose up（PG 5432 / Redis 6379）+ 迁移已执行（含 manual 0011 的 ai_model_type='search'）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import {
  LlmGateway,
  resolveActiveModel,
  toEmbeddingProviderConfig,
  toSearchProviderConfig,
} from '@tradepilot/runtime';
import {
  createEmbeddingProvider,
  createSearchProvider,
  getEmbeddingProvider,
  getSearchProvider,
  HttpSearchProvider,
  MockEmbeddingProvider,
  MockSearchProvider,
  OpenAiEmbeddingProvider,
  setEmbeddingProviderFactory,
  setSearchProviderFactory,
} from '@tradepilot/integrations';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { AiModelsService } from '../src/settings/ai-models.service.js';

const logger = pino({ level: 'silent' });

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let aiModels: AiModelsService;

let orgId = '';
let userId = '';

const adminEmail = `it-m5d3-aimodel-${createId('org')}@test.com`;

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);

  const session = await auth.register({
    companyName: 'IT M5 D3 AI 模型租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  userId = session.user.userId;

  aiModels = new AiModelsService(appDb, env);
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.aiModel).where(eq(schema.aiModel.orgId, orgId));
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx
        .delete(schema.notificationSetting)
        .where(eq(schema.notificationSetting.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('M5-D3 · ai_model 台账 + org 级全局选用（16 FR-10 扩展）', () => {
  it('llm 首建自动选中；embedding 需指定维度', async () => {
    const llm = await aiModels.create(orgId, userId, {
      type: 'llm',
      name: 'GPT-4o',
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.3,
      maxTokens: 4096,
      apiKey: 'sk-test-123',
    });
    expect(llm.isSelected).toBe(true);
    expect(llm.hasApiKey).toBe(true);

    const view = await aiModels.list(orgId);
    expect(view.selection.llm).toBe(llm.id);
    expect(view.selection.embedding).toBeNull();

    await expect(
      aiModels.create(orgId, userId, {
        type: 'embedding',
        name: 'Text Embedding 3',
        provider: 'openai',
        model: 'text-embedding-3-small',
      }),
    ).rejects.toThrow('向量维度');
  });

  it('同名冲突；第二个 llm 默认不选中，切换 selection 后互斥', async () => {
    await expect(
      aiModels.create(orgId, userId, {
        type: 'llm',
        name: 'GPT-4o',
        provider: 'openai',
        model: 'gpt-4o',
      }),
    ).rejects.toThrow('同名');

    const mini = await aiModels.create(orgId, userId, {
      type: 'llm',
      name: 'GPT-4o mini',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(mini.isSelected).toBe(false);

    const afterSelect = await aiModels.select(orgId, { type: 'llm', modelId: mini.id });
    expect(afterSelect.selection.llm).toBe(mini.id);
    expect(afterSelect.models.filter((m) => m.type === 'llm' && m.isSelected)).toHaveLength(1);
  });

  it('embedding 建两个 → 选中第二个 → 删除生效模型自动回退首个', async () => {
    const e1 = await aiModels.create(orgId, userId, {
      type: 'embedding',
      name: 'Embedding A',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    const e2 = await aiModels.create(orgId, userId, {
      type: 'embedding',
      name: 'Embedding B',
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
    });
    expect(e1.isSelected).toBe(true);
    expect(e2.isSelected).toBe(false);

    const selected = await aiModels.select(orgId, { type: 'embedding', modelId: e2.id });
    expect(selected.selection.embedding).toBe(e2.id);

    await aiModels.remove(orgId, e2.id);
    const afterDelete = await aiModels.list(orgId);
    expect(afterDelete.selection.embedding).toBe(e1.id);
  });

  it('resolveActiveModel 返回生效配置，apiKey 解密回填', async () => {
    const active = await aiModels.resolveActiveModel(orgId, 'llm');
    expect(active).not.toBeNull();
    expect(active?.model).toBe('gpt-4o-mini');
    expect(active?.provider).toBe('openai');
    expect(active?.temperature).toBe(0.7);
    // 当前生效的 mini 未配置 apiKey
    expect(active?.apiKey).toBeUndefined();

    // 切回带 apiKey 的 GPT-4o → 解密回填
    const view = await aiModels.list(orgId);
    const gpt4o = view.models.find((m) => m.name === 'GPT-4o');
    expect(gpt4o).toBeDefined();
    await aiModels.select(orgId, { type: 'llm', modelId: gpt4o!.id });
    const activeWithKey = await aiModels.resolveActiveModel(orgId, 'llm');
    expect(activeWithKey?.apiKey).toBe('sk-test-123');
  });

  it('embedding 维度非 1536 / 提供方不支持时拒绝（与知识索引列约束一致）', async () => {
    await expect(
      aiModels.create(orgId, userId, {
        type: 'embedding',
        name: 'Wrong Dim',
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
      }),
    ).rejects.toThrow('1536');

    await expect(
      aiModels.create(orgId, userId, {
        type: 'embedding',
        name: 'Wrong Provider',
        provider: 'anthropic',
        model: 'voyage-3',
        dimensions: 1536,
      }),
    ).rejects.toThrow('提供方');
  });
});

describe('M5-D3 · 运行时接入：选用模型驱动 LlmGateway / Embedding（16 FR-10 扩展）', () => {
  it('LlmGateway 采用台账选用模型（provider/凭据/模型来自台账，场景仅保留温度与上限）', async () => {
    const gateway = new LlmGateway(appDb, logger, {
      provider: 'mock',
      defaultModel: 'env-default',
      encryptionKey: process.env.ENCRYPTION_KEY,
    });

    // 台账当前选用 GPT-4o（openai / sk-test-123）；场景 email_reply 种子为 gpt-4o / 0.7 / 2048
    const target = await gateway.resolveTarget(orgId, 'email_reply');
    expect(target.provider).toBe('openai');
    expect(target.model).toBe('gpt-4o');
    expect(target.apiKey).toBe('sk-test-123');
    expect(target.temperature).toBe(0.7);
    expect(target.maxTokens).toBe(2048);
    expect(target.degraded).toBe(false);

    // 切到台账 GPT-4o mini → 模型以台账为准（覆盖场景模型），场景温度/上限精调保留
    const view = await aiModels.list(orgId);
    const mini = view.models.find((m) => m.name === 'GPT-4o mini');
    expect(mini).toBeDefined();
    await aiModels.select(orgId, { type: 'llm', modelId: mini!.id });

    const switched = await gateway.resolveTarget(orgId, 'email_reply');
    expect(switched.model).toBe('gpt-4o-mini');
    expect(switched.temperature).toBe(0.7);
    expect(switched.maxTokens).toBe(2048);
    expect(switched.degraded).toBe(false);
  });

  it('Embedding 解析：台账选用 → toEmbeddingProviderConfig 输出 openai + 1536 维', async () => {
    const active = await aiModels.resolveActiveModel(orgId, 'embedding');
    expect(active).not.toBeNull();
    expect(active?.dimensions).toBe(1536);

    const config = toEmbeddingProviderConfig(active, {
      provider: 'mock',
      baseUrl: '',
      apiKey: '',
      model: 'env-embedding',
    });
    expect(config.provider).toBe('openai');
    expect(config.dimensions).toBe(1536);
    expect(config.model).toBe(active?.model);

    // 未配置台账（active=null）→ 原样回落环境变量
    expect(
      toEmbeddingProviderConfig(null, {
        provider: 'mock',
        baseUrl: '',
        apiKey: '',
        model: 'env-embedding',
      }),
    ).toEqual({ provider: 'mock', baseUrl: '', apiKey: '', model: 'env-embedding' });
  });

  it('setEmbeddingProviderFactory 后 getEmbeddingProvider(orgId) 按 org 解析，未命中回落环境变量', async () => {
    // 为该 org 准备带凭据的生效 embedding 模型（避免空 key 触发 SDK 构造异常）
    const emb = await aiModels.create(orgId, userId, {
      type: 'embedding',
      name: 'Embedding Live',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      apiKey: 'sk-embed-123',
    });
    await aiModels.select(orgId, { type: 'embedding', modelId: emb.id });

    setEmbeddingProviderFactory(async (oid) => {
      const active =
        oid === undefined
          ? null
          : await resolveActiveModel(appDb, oid, 'embedding', process.env.ENCRYPTION_KEY);
      return createEmbeddingProvider(
        toEmbeddingProviderConfig(active, {
          provider: 'mock',
          baseUrl: '',
          apiKey: '',
          model: 'env-embedding',
        }),
      );
    });

    expect(await getEmbeddingProvider(orgId)).toBeInstanceOf(OpenAiEmbeddingProvider);
    // 未配置台账的 org → 回落环境变量（本例 mock）
    expect(await getEmbeddingProvider('org-not-configured')).toBeInstanceOf(MockEmbeddingProvider);
  });
});

describe('M5-D3 · 搜索供应商接入：选用驱动 web_search/site_crawl 供应商（16 FR-10 扩展）', () => {
  let searchId = '';

  it('search 字段按 type 收窄：http 缺端点/缺凭据/provider 越界均拒绝', async () => {
    await expect(
      aiModels.create(orgId, userId, {
        type: 'search',
        name: 'No Endpoint',
        provider: 'http',
        apiKey: 'sk-search-123',
      }),
    ).rejects.toThrow('接口地址');

    await expect(
      aiModels.create(orgId, userId, {
        type: 'search',
        name: 'No Key',
        provider: 'http',
        baseUrl: 'https://google.serper.dev',
      }),
    ).rejects.toThrow('API Key');

    await expect(
      aiModels.create(orgId, userId, {
        type: 'search',
        name: 'Wrong Provider',
        provider: 'anthropic',
      }),
    ).rejects.toThrow('提供方');
  });

  it('创建 search 无需模型标识（以 provider 占位），首建即选中并出现在 selection.search', async () => {
    const serper = await aiModels.create(orgId, userId, {
      type: 'search',
      name: 'Serper',
      provider: 'http',
      baseUrl: 'https://google.serper.dev',
      apiKey: 'sk-search-123',
    });
    expect(serper.type).toBe('search');
    expect(serper.isSelected).toBe(true);
    // 无模型标识 → 以 provider 名占位（model 列 NOT NULL，06 §3）
    expect(serper.model).toBe('http');
    expect(serper.hasApiKey).toBe(true);
    searchId = serper.id;

    const view = await aiModels.list(orgId);
    expect(view.selection.search).toBe(serper.id);
    // 其他类型选中项不受影响
    expect(view.selection.llm).not.toBeNull();
    expect(view.selection.embedding).not.toBeNull();
  });

  it('resolveActiveModel(search) 解密凭据，toSearchProviderConfig 输出 http 端点', async () => {
    const active = await aiModels.resolveActiveModel(orgId, 'search');
    expect(active).not.toBeNull();
    expect(active?.provider).toBe('http');
    expect(active?.apiKey).toBe('sk-search-123');

    const config = toSearchProviderConfig(active, { provider: 'mock', baseUrl: '', apiKey: '' });
    expect(config).toEqual({
      provider: 'http',
      baseUrl: 'https://google.serper.dev',
      apiKey: 'sk-search-123',
    });

    // 未配置台账（active=null）→ 原样回落环境变量
    expect(toSearchProviderConfig(null, { provider: 'mock', baseUrl: '', apiKey: '' })).toEqual({
      provider: 'mock',
      baseUrl: '',
      apiKey: '',
    });
  });

  it('setSearchProviderFactory 后 getSearchProvider(orgId) 按 org 解析，未命中回落 mock', async () => {
    setSearchProviderFactory(async (oid) => {
      const active =
        oid === undefined
          ? null
          : await resolveActiveModel(appDb, oid, 'search', process.env.ENCRYPTION_KEY).catch(
              () => null,
            );
      return createSearchProvider(
        toSearchProviderConfig(active, { provider: 'mock', baseUrl: '', apiKey: '' }),
      );
    });

    expect(await getSearchProvider(orgId)).toBeInstanceOf(HttpSearchProvider);
    expect(await getSearchProvider('org-not-configured')).toBeInstanceOf(MockSearchProvider);
  });

  it('search 编辑：provider 切 mock 可清空端点；切回 http 缺端点被拒', async () => {
    const asMock = await aiModels.update(orgId, searchId, { provider: 'mock', baseUrl: null });
    expect(asMock.provider).toBe('mock');
    expect(asMock.baseUrl).toBeNull();

    await expect(aiModels.update(orgId, searchId, { provider: 'http' })).rejects.toThrow(
      '接口地址',
    );
  });
});
