/**
 * Apollo 相似客户获客服务（四步工作流）：
 * ① getSeedProfile：读取种子客户（如 EASYFEET）CRM 档案 + 联系人 + 画像 → 种子画像快照
 * ② generateKeywords：LLM 拆解种子画像 → Apollo 搜索参数（关键词标签/地域/规模/头衔）
 * ③ search：调用 Apollo API（公司检索 + 联系人检索）→ 原始结果落 run
 * ④ analyze：LLM 二次复筛（对照种子画像逐公司打分）→ 符合条件的写入 ai_lead/ai_lead_contact
 *    （source=apollo，域名三级去重复用 ai_lead 唯一索引），后续转 CRM/开发信走既有链路。
 *
 * 供应商凭据：type=apollo 的「AI 模型配置」选用项（与 llm/search 同口径）；LLM 走
 * LlmGateway（scene=lead_hunting，与既有获客工作流同场景，org 级模型配置统一生效）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { BizException, createId, ErrorCode } from '@tradepilot/core';
import { schema, withOrg, type Db, type OrgScopeContext } from '@tradepilot/db';
import {
  APOLLO_FIELD_DEFAULTS,
  LlmGateway,
  resolveActiveModel,
  toApolloProviderConfig,
} from '@tradepilot/runtime';
import {
  createApolloProvider,
  normalizeApolloDomain,
  type ApolloProvider,
} from '@tradepilot/integrations';
import { z } from 'zod';
import type { Logger } from 'pino';
import pino from 'pino';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import { PINO_ROOT } from '../common/logger/logger.factory.js';
import type {
  ApolloSearchDto,
  ApolloAnalyzeDto,
  GenerateKeywordsDto,
} from './apollo-acquisition.dto.js';
import type { ApolloAnalyzeResult, ApolloOrgResult, ApolloSearchParams } from '@tradepilot/db';

/** LLM 场景/节点：与既有获客工作流同场景 lead_hunting，org 级模型配置统一生效 */
const LEAD_SCENE = 'lead_hunting';
const KEYWORDS_NODE = 'apollo_seed_keywords';
const ANALYZE_NODE = 'apollo_analyze';

/** 复筛批次大小（一次 LLM 调用复核的公司数，控制上下文与稳定性） */
const ANALYZE_BATCH_SIZE = 8;
/** 联系人检索批次大小（Apollo people search 单次 organization_ids 上限内分批） */
const PEOPLE_BATCH_SIZE = 10;
/** 每家公司最多保留联系人数 */
const MAX_CONTACTS_PER_ORG = 10;

/** 步骤② LLM 输出 schema：Apollo 搜索参数 */
const apolloKeywordsOutputSchema = z.object({
  keywordTags: z.array(z.string().min(1)).min(1).max(10),
  locations: z.array(z.string().min(1)).max(10),
  employeeRanges: z.array(z.tuple([z.number(), z.number()])).max(3),
  contactTitles: z.array(z.string().min(1)).max(10),
  rationale: z.string().min(1),
});

/** 步骤④ LLM 输出 schema：逐公司复筛结论 */
const apolloAnalyzeOutputSchema = z.object({
  companies: z
    .array(
      z.object({
        companyName: z.string().min(1),
        matchPct: z.number().int().min(0).max(100),
        qualified: z.boolean(),
        reasons: z
          .array(z.object({ text: z.string().min(1), evidence: z.string().optional() }))
          .max(5),
        rejectReason: z.string().optional(),
      }),
    )
    .min(1),
});

export interface SeedProfileView {
  customerId: string;
  companyName: string;
  country: string;
  website: string | null;
  industry: string | null;
  industryTags: string[];
  customerType: string | null;
  stage: string;
  score: number | null;
  remark: string | null;
  contacts: { name: string; title: string | null; email: string | null }[];
  insights: { type: string; value: string | null; confidence: string | null; reasons: string[] }[];
}

@Injectable()
export class ApolloAcquisitionService {
  private readonly log: Logger;
  private gateway: LlmGateway | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EnvService) private readonly env?: EnvService,
    @Inject(PINO_ROOT) private readonly logger?: Logger,
  ) {
    this.log = this.logger ?? pino({ level: 'silent' });
  }

  /** LlmGateway（懒装配，与 LeadsService 同口径） */
  private get llm(): LlmGateway {
    this.gateway ??= new LlmGateway(this.db, this.log, {
      ...(this.env?.env.ENCRYPTION_KEY !== undefined && {
        encryptionKey: this.env.env.ENCRYPTION_KEY,
      }),
    });
    return this.gateway;
  }

  // ===== 步骤① 种子画像 =====

  async getSeedProfile(ctx: OrgScopeContext, customerId: string): Promise<SeedProfileView> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [customer] = await tx
        .select()
        .from(schema.customer)
        .where(and(eq(schema.customer.id, customerId), eq(schema.customer.orgId, ctx.orgId)))
        .limit(1);
      if (!customer) {
        throw new BizException(ErrorCode.NOT_FOUND, '种子客户不存在');
      }
      const contacts = await tx
        .select({
          name: schema.contact.name,
          title: schema.contact.title,
          email: schema.contact.email,
        })
        .from(schema.contact)
        .where(eq(schema.contact.customerId, customerId))
        .limit(50);
      const insights = await tx
        .select()
        .from(schema.customerInsight)
        .where(eq(schema.customerInsight.customerId, customerId))
        .limit(50);
      return {
        customerId,
        companyName: customer.companyName,
        country: customer.country,
        website: customer.website,
        industry: customer.industry,
        industryTags: customer.industryTags ?? [],
        customerType: customer.customerType,
        stage: customer.stage,
        score: customer.score,
        remark: customer.remark,
        contacts,
        insights: insights.map((i) => ({
          type: i.insightType,
          value: i.value,
          confidence: i.confidence,
          reasons: (i.reasons ?? []).map((r) => r.text),
        })),
      };
    });
  }

  // ===== 步骤② LLM 拆解 → Apollo 搜索参数 =====

  async generateKeywords(
    ctx: OrgScopeContext,
    dto: GenerateKeywordsDto,
  ): Promise<{ runId: string; searchParams: ApolloSearchParams }> {
    // 种子来源二选一：CRM 客户（读全量画像）/ 手动输入公司名（画像由输入字段构成）
    let seed: SeedProfileView;
    let seedCustomerId: string | null = null;
    if (dto.customerId) {
      seed = await this.getSeedProfile(ctx, dto.customerId);
      seedCustomerId = dto.customerId;
    } else {
      seed = {
        customerId: '',
        companyName: dto.companyName ?? '',
        country: dto.country || 'Unknown',
        website: dto.website ?? null,
        industry: dto.industry ?? null,
        industryTags: [],
        customerType: null,
        stage: 'manual_seed',
        score: null,
        remark: dto.remark ?? null,
        contacts: [],
        insights: [],
      };
    }

    let params: ApolloSearchParams;
    try {
      const { data } = await this.llm.structured(
        { orgId: ctx.orgId, node: KEYWORDS_NODE, scene: LEAD_SCENE },
        apolloKeywordsOutputSchema,
        {
          system:
            '你是外贸获客分析师。基于种子客户画像，拆解出「与种子客户高度相似的目标客户」的检索特征，' +
            '并生成 Apollo.io B2B 数据库可用的搜索参数。要求：' +
            'keywordTags 用英文行业/产品关键词（如 sports shoes, footwear wholesale）；' +
            'locations 用种子客户所在市场一致的英文国家/城市名；' +
            'employeeRanges 用员工数区间 [min, max]（估算种子客户同档规模，max 为 0 表示不设上限，最多 3 组）；' +
            'contactTitles 给出目标公司里最可能负责采购的英文头衔（如 Purchasing Manager, CEO）；' +
            'rationale 用中文简要说明拆解逻辑，供用户校对。只输出 JSON。',
          user: JSON.stringify({ seedProfile: seed, extraGoal: dto.extraGoal ?? '' }),
        },
      );
      params = {
        keywordTags: data.keywordTags,
        locations: data.locations,
        employeeRanges: data.employeeRanges.map(
          ([min, max]) =>
            [Math.max(0, Math.round(min)), Math.max(0, Math.round(max))] as [number, number],
        ),
        contactTitles: data.contactTitles,
        rationale: data.rationale,
      };
    } catch (err) {
      this.log.warn({ err }, 'apollo keywords LLM 拆解失败');
      throw new BizException(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        '种子画像拆解失败：请检查「系统设置 → AI 模型配置」的大语言模型，稍后重试',
      );
    }

    const runId = createId('arun');
    await withOrg(this.db, ctx.orgId, async (tx) => {
      await tx.insert(schema.apolloSearchRun).values({
        id: runId,
        orgId: ctx.orgId,
        seedCustomerId,
        createdBy: ctx.userId,
        status: 'keywords_ready',
        seedProfile: seed as unknown as Record<string, unknown>,
        searchParams: params,
      });
    });
    return { runId, searchParams: params };
  }

  // ===== 步骤③ Apollo 检索（公司 + 联系人） =====

  async search(
    ctx: OrgScopeContext,
    runId: string,
    dto: ApolloSearchDto,
  ): Promise<{ runId: string; totalCompanies: number; results: ApolloOrgResult[] }> {
    const run = await this.loadRun(ctx, runId);
    if (run.status === 'analyzed') {
      throw new BizException(ErrorCode.BIZ_VALIDATION, '该轮已复筛入库，如需重新检索请新建一轮');
    }
    const params = dto.searchParams ?? run.searchParams ?? undefined;
    if (!params) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, '缺少搜索参数（请先完成种子画像拆解）');
    }
    const apollo = await this.resolveApolloProvider(ctx.orgId);

    const page = dto.page ?? 1;
    const perPage = dto.perPage ?? 25;
    let orgs;
    try {
      orgs = await apollo.searchOrganizations({
        keywordTags: params.keywordTags,
        locations: params.locations,
        employeeRanges: (params.employeeRanges ?? []) as [number, number][],
        page,
        perPage,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BizException(ErrorCode.DEPENDENCY_UNAVAILABLE, `Apollo 公司检索失败：${message}`);
    }

    // 联系人检索：命中公司分批（people search 单次 org id 数量有限）
    const contactResults = new Map<string, Awaited<ReturnType<ApolloProvider['searchPeople']>>>();
    const orgIds = orgs.map((o) => o.apolloOrgId).filter((id) => id.length > 0);
    try {
      for (let i = 0; i < orgIds.length; i += PEOPLE_BATCH_SIZE) {
        const batch = orgIds.slice(i, i + PEOPLE_BATCH_SIZE);
        const people = await apollo.searchPeople({
          organizationIds: batch,
          titles: params.contactTitles,
          perPage: MAX_CONTACTS_PER_ORG * 2,
        });
        // 按 organizationName 回填到公司（people search 返回不含 org id，用名称兜底对齐）
        for (const person of people) {
          const org = orgs.find(
            (o) => o.name.toLowerCase() === person.organizationName?.toLowerCase(),
          );
          if (org) {
            const list = contactResults.get(org.apolloOrgId) ?? [];
            if (list.length < MAX_CONTACTS_PER_ORG) {
              list.push(person);
              contactResults.set(org.apolloOrgId, list);
            }
          }
        }
      }
    } catch (err) {
      // 联系人检索失败不阻断整轮：公司结果已到手，错误信息留存 run 供诊断
      this.log.warn({ err, runId }, 'Apollo 联系人检索失败（保留公司结果）');
    }

    const results: ApolloOrgResult[] = orgs
      .filter((o) => o.name.length > 0)
      .map((o) => ({
        apolloOrgId: o.apolloOrgId,
        companyName: o.name,
        website: o.website,
        domain: o.domain,
        country: o.country,
        industry: o.industry,
        employeeCount: o.employeeCount,
        linkedinUrl: o.linkedinUrl,
        shortDescription: o.shortDescription,
        contacts: (contactResults.get(o.apolloOrgId) ?? []).map((p) => ({
          apolloPersonId: p.apolloPersonId,
          name: p.name,
          title: p.title,
          email: p.email,
          emailStatus: p.emailStatus,
          linkedinUrl: p.linkedinUrl,
          seniority: p.seniority,
        })),
      }));

    await withOrg(this.db, ctx.orgId, async (tx) => {
      await tx
        .update(schema.apolloSearchRun)
        .set({
          status: 'searched',
          searchParams: params as unknown as ApolloSearchParams,
          results,
          totalCompanies: results.length,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.apolloSearchRun.id, runId));
    });
    return { runId, totalCompanies: results.length, results };
  }

  // ===== 步骤④ AI 二次复筛 → 落 ai_lead =====

  async analyze(
    ctx: OrgScopeContext,
    runId: string,
    dto: ApolloAnalyzeDto,
  ): Promise<{
    runId: string;
    totalCompanies: number;
    qualifiedCount: number;
    savedLeadCount: number;
    analyzeResults: ApolloAnalyzeResult[];
  }> {
    const run = await this.loadRun(ctx, runId);
    if (!run.results || run.results.length === 0) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, '该轮无检索结果（请先执行 Apollo 检索）');
    }
    const threshold = dto.threshold ?? 60;
    const seedProfile = run.seedProfile;

    // 分批 LLM 复筛（自纠正重试由 LlmGateway 承担）
    const analyzeResults: ApolloAnalyzeResult[] = [];
    for (let i = 0; i < run.results.length; i += ANALYZE_BATCH_SIZE) {
      const batch = run.results.slice(i, i + ANALYZE_BATCH_SIZE);
      try {
        const { data } = await this.llm.structured(
          { orgId: ctx.orgId, node: ANALYZE_NODE, scene: LEAD_SCENE },
          apolloAnalyzeOutputSchema,
          {
            system:
              '你是外贸获客质检员。逐家公司对照种子客户画像，判断其是否属于「与种子客户同类型的目标客户」' +
              '（行业/产品/市场/规模相似，且具备从中国采购的潜在需求）。' +
              'matchPct 为 0-100 的相似度；qualified 表示是否达到目标客户标准；' +
              'reasons 给出关键判断依据（中文，可附 evidence）；不符合的给 rejectReason。只输出 JSON。',
            user: JSON.stringify({
              seedProfile,
              threshold,
              companies: batch.map((o) => ({
                companyName: o.companyName,
                country: o.country,
                industry: o.industry,
                employeeCount: o.employeeCount,
                shortDescription: o.shortDescription,
                contactTitles: o.contacts.map((c) => c.title).filter(Boolean),
              })),
            }),
          },
        );
        for (const item of data.companies) {
          const matchPct = Math.max(0, Math.min(100, Math.round(item.matchPct)));
          const qualified = item.qualified && matchPct >= threshold;
          analyzeResults.push({
            apolloOrgId: '',
            companyName: item.companyName,
            matchPct,
            scoreLevel: matchPct >= 80 ? 'high' : matchPct >= threshold ? 'medium' : 'low',
            qualified,
            reasons: item.reasons.map((r) => ({
              text: r.text,
              ...(r.evidence ? { evidence: r.evidence } : {}),
            })),
            ...(item.rejectReason ? { rejectReason: item.rejectReason } : {}),
          });
        }
      } catch (err) {
        this.log.warn({ err, runId, batch: i }, 'Apollo 复筛选批失败，跳过该批');
      }
    }

    // LLM 按 companyName 回填 apolloOrgId（analyze 输出不含 id）
    for (const result of analyzeResults) {
      const org = run.results.find(
        (o) => o.companyName.toLowerCase() === result.companyName.toLowerCase(),
      );
      if (org) {
        result.apolloOrgId = org.apolloOrgId;
      }
    }

    // 符合条件的写入发现池 ai_lead（域名三级去重：唯一索引冲突即跳过）
    let savedLeadCount = 0;
    const qualified = analyzeResults.filter((r) => r.qualified);
    if (qualified.length > 0) {
      await withOrg(this.db, ctx.orgId, async (tx) => {
        for (const result of qualified) {
          const org = run.results!.find(
            (o) => o.companyName.toLowerCase() === result.companyName.toLowerCase(),
          );
          if (!org) continue;
          const domain = normalizeApolloDomain(org.domain);
          const [inserted] = await tx
            .insert(schema.aiLead)
            .values({
              id: createId('lead'),
              orgId: ctx.orgId,
              companyName: org.companyName,
              country: org.country || 'Unknown',
              industry: org.industry,
              website: org.website,
              companyDomain: domain,
              matchPct: result.matchPct,
              scoreLevel: result.scoreLevel,
              insight: {
                value: result.matchPct,
                confidence: 0.8,
                reasons: result.reasons.map((r) => ({ ...r, source: 'apollo' })),
              },
              overview: {
                ...(org.employeeCount !== null && { companySize: String(org.employeeCount) }),
                apolloOrgId: org.apolloOrgId,
                ...(org.linkedinUrl && { linkedinUrl: org.linkedinUrl }),
                ...(org.shortDescription && { shortDescription: org.shortDescription }),
                source: 'apollo',
              },
            })
            // 同 org 同域名已存在（既有 lead / 已转 CRM）→ 跳过不覆盖
            .onConflictDoNothing({ target: [schema.aiLead.orgId, schema.aiLead.companyDomain] })
            .returning({ id: schema.aiLead.id });
          if (!inserted) {
            continue;
          }
          savedLeadCount += 1;
          if (org.contacts.length > 0) {
            await tx.insert(schema.aiLeadContact).values(
              org.contacts.slice(0, MAX_CONTACTS_PER_ORG).map((c) => ({
                id: createId('con'),
                orgId: ctx.orgId,
                leadId: inserted.id,
                name: c.name,
                title: c.title,
                email: c.email,
                decisionInfluencePct: null,
                source: 'apollo',
              })),
            );
          }
        }
      });
    }

    await withOrg(this.db, ctx.orgId, async (tx) => {
      await tx
        .update(schema.apolloSearchRun)
        .set({
          status: 'analyzed',
          analyzeResults,
          qualifiedCount: qualified.length,
          savedLeadCount,
          updatedAt: new Date(),
        })
        .where(eq(schema.apolloSearchRun.id, runId));
    });

    return {
      runId,
      totalCompanies: run.results.length,
      qualifiedCount: qualified.length,
      savedLeadCount,
      analyzeResults,
    };
  }

  // ===== 查询 =====

  async listRuns(
    ctx: OrgScopeContext,
    query: { seedCustomerId?: string },
  ): Promise<{ runs: Record<string, unknown>[] }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const where = query.seedCustomerId
        ? and(
            eq(schema.apolloSearchRun.orgId, ctx.orgId),
            eq(schema.apolloSearchRun.seedCustomerId, query.seedCustomerId),
          )
        : eq(schema.apolloSearchRun.orgId, ctx.orgId);
      const rows = await tx
        .select({
          id: schema.apolloSearchRun.id,
          seedCustomerId: schema.apolloSearchRun.seedCustomerId,
          status: schema.apolloSearchRun.status,
          searchParams: schema.apolloSearchRun.searchParams,
          totalCompanies: schema.apolloSearchRun.totalCompanies,
          qualifiedCount: schema.apolloSearchRun.qualifiedCount,
          savedLeadCount: schema.apolloSearchRun.savedLeadCount,
          errorMessage: schema.apolloSearchRun.errorMessage,
          createdAt: schema.apolloSearchRun.createdAt,
        })
        .from(schema.apolloSearchRun)
        .where(where)
        .orderBy(desc(schema.apolloSearchRun.createdAt))
        .limit(50);
      return {
        runs: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      };
    });
  }

  async getRun(ctx: OrgScopeContext, runId: string): Promise<Record<string, unknown>> {
    const run = await this.loadRun(ctx, runId);
    return {
      ...run,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }

  // ===== helpers =====

  private async loadRun(ctx: OrgScopeContext, runId: string) {
    const [run] = await withOrg(this.db, ctx.orgId, (tx) =>
      tx
        .select()
        .from(schema.apolloSearchRun)
        .where(
          and(eq(schema.apolloSearchRun.id, runId), eq(schema.apolloSearchRun.orgId, ctx.orgId)),
        )
        .limit(1),
    );
    if (!run) {
      throw new BizException(ErrorCode.NOT_FOUND, '获客轮次不存在');
    }
    return run;
  }

  /** 解析 org 选用的 Apollo 供应商（type=apollo；未配置明确报错，与 search 同口径） */
  private async resolveApolloProvider(orgId: string): Promise<ApolloProvider> {
    const active = await resolveActiveModel(this.db, orgId, 'apollo', this.env?.env.ENCRYPTION_KEY);
    if (!active) {
      throw new BizException(
        ErrorCode.BIZ_VALIDATION,
        '未配置 Apollo 供应商：请在「系统设置 → AI 模型配置」中配置并选用 Apollo 数据源',
      );
    }
    return createApolloProvider(toApolloProviderConfig(active, APOLLO_FIELD_DEFAULTS));
  }
}
