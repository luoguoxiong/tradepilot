import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

import { logger } from '../../logger';
import { PrismaService } from '../../prisma/prisma.service';
import { createLlmClient, LlmClient } from '../llm/deepseek.client';
import { LlmOutputError, LlmUnavailableError } from '../llm/types';
import { buildScoringUserPrompt, SCORING_SYSTEM_PROMPT, type ScoringPromptInput } from '../prompts/lead-scoring';

/** LLM 结构化输出 schema（六项解释 + 五维子分）；总分/等级由代码按 PRD 权重计算，保证一致性 */
const ScoringOutputSchema = z.object({
  subScores: z.object({
    product: z.number().min(0).max(100),
    business: z.number().min(0).max(100),
    customs: z.number().min(0).max(100),
    contact: z.number().min(0).max(100),
    region: z.number().min(0).max(100),
  }),
  matchReasons: z.array(z.string().min(1).max(300)).min(1).max(6),
  purchaseNeeds: z.string().min(1).max(1000),
  opportunities: z.string().min(1).max(1000),
  suggestions: z.string().min(1).max(1000),
  uncertaintyNotes: z.string().min(1).max(1000),
});

export type ScoringOutput = z.infer<typeof ScoringOutputSchema>;

/** PRD §3.4 权重：产品 30 / 业务 25 / 采购记录可信度 25 / 联系人职位 10 / 地区 10 */
const WEIGHTS = {
  product: 0.3,
  business: 0.25,
  customs: 0.25,
  contact: 0.1,
  region: 0.1,
} as const;

export function computeWeightedScore(s: ScoringOutput['subScores']): number {
  return Math.round(
    s.product * WEIGHTS.product +
      s.business * WEIGHTS.business +
      s.customs * WEIGHTS.customs +
      s.contact * WEIGHTS.contact +
      s.region * WEIGHTS.region,
  );
}

export function gradeOf(score: number): 'A' | 'B' | 'C' | 'D' {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

const TARGET_TITLES = [
  'purchasing', 'procurement', 'sourcing', 'import', 'ceo', 'founder', 'owner',
];

/**
 * 确定性规则评分（无 LLM Key 时的降级实现）：
 * 同输入同输出 → 满足「两次评分波动 ≤ 10」验收门；结果 model 标注 mock-rules，前端明示非 AI。
 */
export function ruleBasedScoring(input: ScoringPromptInput): ScoringOutput {
  const haystack = `${input.company.mainProducts.join(' ')} ${input.company.description ?? ''}`.toLowerCase();
  const keywords = input.productKeywords.map((k) => k.toLowerCase());

  const hits = keywords.filter((k) => haystack.includes(k)).length;
  const product = keywords.length ? Math.min(100, 45 + Math.round((55 * hits) / keywords.length)) : 50;

  const isTradeCo = /(import|distribut|wholesale|retail|sourcing|trading)/.test(haystack);
  const business = isTradeCo ? 78 : 55;

  const n = input.customsRecords.length;
  const hasRecent = input.customsRecords.some(
    (r) => Date.now() - new Date(r.shipmentDate).getTime() < 365 * 24 * 3600 * 1000,
  );
  const customs = n === 0 ? 25 : Math.min(100, 55 + Math.min(3, n) * 10 + (hasRecent ? 15 : 0));

  const bestTitle = input.contacts.reduce((best, c) => {
    const hit = TARGET_TITLES.some((t) => c.title.toLowerCase().includes(t));
    return Math.max(best, hit ? 85 : 40);
  }, 0);
  const contact = input.contacts.length ? bestTitle : 30;

  const region = ['US', 'CA'].includes(input.company.country) ? 90 : 45;

  const matchReasons: string[] = [];
  matchReasons.push(
    hits > 0
      ? `Company business text mentions ${hits}/${keywords.length} of our product keywords`
      : 'Company products partially overlap with our category',
  );
  matchReasons.push(isTradeCo ? 'Business profile matches importer/distributor type' : 'Business type unclear from available data');
  if (n > 0) matchReasons.push(`${n} import record(s) found, indicating real purchasing activity`);
  else matchReasons.push('No import records found yet');
  if (input.contacts.length) matchReasons.push(`Contact title coverage: ${input.contacts.map((c) => c.title).join(', ')}`);

  const missing: string[] = [];
  if (n === 0) missing.push('no customs import records — purchasing credibility unverified');
  if (input.contacts.length === 0) missing.push('no purchasing contacts discovered yet');
  if (input.company.source === 'demo') missing.push('company data is DEMO, not real API data');
  if (!input.productName) missing.push('no product linked to this scoring run');

  return {
    subScores: { product, business, customs, contact, region },
    matchReasons,
    purchaseNeeds:
      n > 0
        ? `Recent import activity suggests ongoing sourcing of ${input.customsRecords[0]?.productDescription ?? 'related products'}.`
        : 'Purchasing needs unverified — company profile suggests potential interest in this category.',
    opportunities:
      'Position our product as an upgrade to their current assortment; offer samples and OEM options.',
    suggestions: input.contacts.length
      ? 'Reach out to the discovered purchasing contact with a specific product angle.'
      : 'Discover purchasing contacts first, then send a personalized first-touch email.',
    uncertaintyNotes: missing.length
      ? `Data gaps: ${missing.join('; ')}.`
      : 'All key data present.',
  };
}

@Injectable()
export class LeadScoringService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 触发评分（LLM 有 Key → LLM；无 Key → 规则降级并标注 mock）；同一企业可重跑，历史保留 */
  async score(companyId: string, userId: string, clientOverride?: LlmClient) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        contacts: { select: { name: true, title: true } },
        customsRecords: { orderBy: { shipmentDate: 'desc' }, take: 10 },
      },
    });
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
    }

    // 取该用户最新产品作为我方产品输入（可无产品，评分照常输出并在 uncertaintyNotes 注明）
    const product = await this.prisma.product.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const input: ScoringPromptInput = {
      productName: product?.name ?? null,
      productKeywords: product?.keywords ?? ['general merchandise'],
      sellingPoints: product?.sellingPoints ?? [],
      company: {
        name: company.name,
        country: company.country,
        description: company.description,
        mainProducts: company.mainProducts,
        source: company.source,
      },
      contacts: company.contacts,
      customsRecords: company.customsRecords.map((r) => ({
        productDescription: r.productDescription,
        shipmentDate: r.shipmentDate.toISOString().slice(0, 10),
        quantity: r.quantity,
        supplierCountry: r.supplierCountry,
      })),
    };

    let output: ScoringOutput;
    let model: string;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    const client = clientOverride ?? createLlmClient();
    if (client) {
      try {
        const result = await client.chatJson({
          system: SCORING_SYSTEM_PROMPT,
          user: buildScoringUserPrompt(input),
          schema: ScoringOutputSchema,
          maxTokens: 1500,
          temperature: 0.2,
        });
        output = result.data;
        model = result.usage.model;
        promptTokens = result.usage.promptTokens;
        completionTokens = result.usage.completionTokens;
        logger.info(
          { companyId, model, promptTokens, completionTokens },
          'AI 评分完成（LLM）',
        );
      } catch (err) {
        throw this.mapAiError(err);
      }
    } else {
      output = ruleBasedScoring(input);
      model = 'mock-rules-v1';
      logger.info({ companyId }, 'AI 评分完成（无 LLM Key，规则降级，model=mock-rules-v1）');
    }

    const score = computeWeightedScore(output.subScores);
    return this.prisma.leadScore.create({
      data: {
        companyId,
        status: 'COMPLETED',
        score,
        grade: gradeOf(score),
        matchReasons: output.matchReasons,
        purchaseNeeds: output.purchaseNeeds,
        opportunities: output.opportunities,
        suggestions: output.suggestions,
        uncertaintyNotes: output.uncertaintyNotes,
        subScores: output.subScores,
        model,
        promptTokens,
        completionTokens,
      },
    });
  }

  history(companyId: string) {
    return this.prisma.leadScore.findMany({
      where: { companyId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  /** LLM 错误 → 结构化 503（不 500，满足异常注入验收门） */
  private mapAiError(err: unknown): ServiceUnavailableException {
    if (err instanceof LlmOutputError) {
      return new ServiceUnavailableException({
        code: 'LLM_OUTPUT_INVALID',
        message: `AI 输出校验未通过（已重试一次）：${err.message}`,
      });
    }
    if (err instanceof LlmUnavailableError) {
      return new ServiceUnavailableException({
        code: 'LLM_UNAVAILABLE',
        message: `AI 服务暂不可用：${err.message}`,
      });
    }
    return new ServiceUnavailableException({
      code: 'LLM_UNAVAILABLE',
      message: 'AI 服务发生未知错误',
    });
  }
}
