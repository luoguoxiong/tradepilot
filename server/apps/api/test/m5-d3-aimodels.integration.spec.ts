/**
 * M5-D3 16 ai-models 配置 → LLM Gateway org 级路由联动（后端开发计划表 D3，M5 #9）：
 * - register 种子（register-seed DEFAULT_MODEL_SETTINGS ×4 scenes）经 LlmGateway.resolveTarget 可读，
 *   命中场景返回配置的 model/temperature/maxTokens 且 degraded=false；
 * - SettingsService.updateAiModels（16 §3.6 PUT）改写场景模型后，Gateway 下次解析即联动生效；
 * - 场景配置删除（P1 兜底路径）→ degraded=true + defaultModel 兜底（05 §6.2 降级链标记）；
 * - 场景间隔离：email_reply 改写不影响 lead_hunting 种子配置。
 * 前置：docker compose up（PG 5432 / Redis 6379）+ 迁移已执行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { LlmGateway } from '@tradepilot/runtime';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { testLlmOptions } from './setup/providers.js';

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

const logger = pino({ level: 'silent' });

let superDb: Db;
let appDb: Db;
let redis: Redis;
let settings: SettingsService;
let gateway: LlmGateway;

let orgId = '';

const adminEmail = `it-m5d3-${createId('org')}@test.com`;

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);

  const session = await auth.register({
    companyName: 'IT M5 D3 租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;

  settings = new SettingsService(appDb);
  gateway = new LlmGateway(appDb, logger, {
    provider: testLlmOptions.provider,
    defaultModel: 'default-model',
  });
}, 30_000);

afterAll(async () => {
  if (orgId) {
    // register-seed 会建 followUpStrategy/StrategyStep + 默认 6 员工，须先删子表再删 org（FK 顺序）
    await superDb.transaction(async (tx) => {
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

describe('M5-D3 · ai_model_setting → LlmGateway org 级路由联动（05 §6.2 / 16 FR-10）', () => {
  it('register 种子配置可解析：email_reply 命中 gpt-4o/0.7/2048，degraded=false', async () => {
    const target = await gateway.resolveTarget(orgId, 'email_reply');
    expect(target).toEqual({
      provider: testLlmOptions.provider,
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 2048,
      degraded: false,
    });
  });

  it('16 PUT 改写场景模型 → Gateway 立即联动（gpt-4o-mini/0.25/4096 + budget 落库）', async () => {
    const { scenes } = await settings.updateAiModels(orgId, {
      scenes: [
        {
          scene: 'email_reply',
          model: 'gpt-4o-mini',
          temperature: 0.25,
          maxTokens: 4096,
          budgetLimit: 200,
        },
      ],
    });
    const view = scenes.find((s) => s.scene === 'email_reply')!;
    expect(view.model).toBe('gpt-4o-mini');
    expect(Number(view.temperature)).toBe(0.25);
    expect(view.maxTokens).toBe(4096);
    expect(Number(view.budgetLimit)).toBe(200);

    const target = await gateway.resolveTarget(orgId, 'email_reply');
    expect(target).toEqual({
      provider: testLlmOptions.provider,
      model: 'gpt-4o-mini',
      temperature: 0.25,
      maxTokens: 4096,
      degraded: false,
    });
  });

  it('场景配置删除 → degraded=true 默认模型兜底；场景间互不影响（lead_hunting 种子仍生效）', async () => {
    // 删除 analysis 场景配置（superDb 直接删行，模拟无配置兜底路径）
    await superDb
      .delete(schema.aiModelSetting)
      .where(
        and(eq(schema.aiModelSetting.orgId, orgId), eq(schema.aiModelSetting.scene, 'analysis')),
      );

    const degraded = await gateway.resolveTarget(orgId, 'analysis');
    expect(degraded).toEqual({
      provider: testLlmOptions.provider,
      model: 'default-model',
      temperature: 0.7,
      maxTokens: 4096,
      degraded: true,
    });

    // email_reply 改写不影响 lead_hunting 种子（org 级场景隔离）
    const hunting = await gateway.resolveTarget(orgId, 'lead_hunting');
    expect(hunting).toMatchObject({
      model: 'gpt-4o',
      temperature: 0.3,
      maxTokens: 4096,
      degraded: false,
    });
  });
});
