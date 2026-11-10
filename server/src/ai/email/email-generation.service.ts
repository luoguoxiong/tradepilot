import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

import { logger } from '../../logger';
import { PrismaService } from '../../prisma/prisma.service';
import { createLlmClient, LlmClient } from '../llm/deepseek.client';
import { LlmOutputError, LlmUnavailableError } from '../llm/types';
import { buildEmailUserPrompt, EMAIL_SYSTEM_PROMPT, type EmailPromptInput } from '../prompts/email';

const EmailOutputSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  followUp1: z.string().min(1).max(4000),
  followUp2: z.string().min(1).max(4000),
});

export type EmailOutput = z.infer<typeof EmailOutputSchema>;

/** 确定性模板生成（无 LLM Key 降级）：含企业名与产品关联；无采购记录绝不提采购 */
export function templateEmail(input: EmailPromptInput): EmailOutput {
  const productName = input.productName ?? input.productKeywords[0] ?? 'our products';
  const salutation = input.contact ? `Hi ${input.contact.name.split(' ')[0]},` : 'Hi there,';
  const theirBusiness =
    input.company.mainProducts.length > 0
      ? `I see ${input.company.name} works with ${input.company.mainProducts.slice(0, 3).join(', ')}.`
      : `I came across ${input.company.name} while researching the ${input.company.country} market.`;
  const angle = input.sellingPoints.length
    ? `What might be relevant for you: ${input.sellingPoints[0].toLowerCase()}.`
    : `We focus on ${productName} with consistent quality and stable lead times.`;
  const recordLine =
    input.customsRecords.length > 0
      ? ` I also noticed import records showing shipments of ${
          input.customsRecords[0]?.productDescription ?? 'related products'
        } — so this may line up with what you are already sourcing.`
      : '';

  const body = [
    `${salutation}`,
    '',
    `I'm reaching out from a factory specializing in ${productName}. ${theirBusiness}${recordLine}`,
    '',
    `${angle} If it would be useful, I can send over our latest catalog and a few sample options — no obligation.`,
    '',
    'Would a short reply be okay to exchange catalogs?',
    '',
    'Best regards,',
    'TradePilot AI (draft — review before sending)',
  ].join('\n');

  const followUp1 = [
    `${salutation}`,
    '',
    'Just floating this back to the top of your inbox in case it got buried.',
    `Happy to send the ${productName} catalog plus recent reference photos whenever convenient.`,
    '',
    'Best regards,',
  ].join('\n');

  const followUp2 = [
    `${salutation}`,
    '',
    `Last note from me — if ${productName.toLowerCase()} is not a fit right now, no worries at all.`,
    "If you'd like, I can still send the catalog so you have it on file for later.",
    '',
    'Best regards,',
  ].join('\n');

  return {
    subject: `${productName} supply for ${input.company.name} — samples available`,
    body,
    followUp1,
    followUp2,
  };
}

@Injectable()
export class EmailGenerationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async generate(
    companyId: string,
    userId: string,
    contactId: string | null,
    clientOverride?: LlmClient,
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        customsRecords: { orderBy: { shipmentDate: 'desc' }, take: 3 },
      },
    });
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
    }

    const contact = contactId
      ? await this.prisma.contact.findFirst({ where: { id: contactId, companyId } })
      : null;
    if (contactId && !contact) {
      throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message: 'Contact not found' });
    }

    const product = await this.prisma.product.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    const latestScore = await this.prisma.leadScore.findFirst({
      where: { companyId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
    });
    const subScores = latestScore?.subScores as Record<string, number> | null;
    const leadSummary = latestScore
      ? `Match level ${latestScore.grade}. Key reasons: ${latestScore.matchReasons.slice(0, 2).join('; ')}. Uncertainties: ${latestScore.uncertaintyNotes}`
      : subScores
        ? null
        : null;

    const input: EmailPromptInput = {
      ourCompanyIntro: product?.companyIntro ?? null,
      productName: product?.name ?? null,
      productKeywords: product?.keywords ?? ['general merchandise'],
      sellingPoints: product?.sellingPoints ?? [],
      company: {
        name: company.name,
        country: company.country,
        description: company.description,
        mainProducts: company.mainProducts,
      },
      contact: contact ? { name: contact.name, title: contact.title } : null,
      customsRecords: company.customsRecords.map((r) => ({
        productDescription: r.productDescription,
        shipmentDate: r.shipmentDate.toISOString().slice(0, 10),
      })),
      leadSummary: leadSummary ?? null,
    };

    let output: EmailOutput;
    let model: string;
    const client = clientOverride ?? createLlmClient();
    if (client) {
      try {
        const result = await client.chatJson({
          system: EMAIL_SYSTEM_PROMPT,
          user: buildEmailUserPrompt(input),
          schema: EmailOutputSchema,
          maxTokens: 2000,
          temperature: 0.6,
        });
        output = result.data;
        model = result.usage.model;
        logger.info({ companyId, model, promptTokens: result.usage.promptTokens }, '开发信生成完成（LLM）');
      } catch (err) {
        if (err instanceof LlmOutputError) {
          throw new ServiceUnavailableException({
            code: 'LLM_OUTPUT_INVALID',
            message: `AI 输出校验未通过（已重试一次）：${err.message}`,
          });
        }
        if (err instanceof LlmUnavailableError) {
          throw new ServiceUnavailableException({
            code: 'LLM_UNAVAILABLE',
            message: `AI 服务暂不可用：${err.message}`,
          });
        }
        throw new ServiceUnavailableException({ code: 'LLM_UNAVAILABLE', message: 'AI 服务发生未知错误' });
      }
    } else {
      output = templateEmail(input);
      model = 'mock-template-v1';
      logger.info({ companyId }, '开发信生成完成（无 LLM Key，模板降级，model=mock-template-v1）');
    }

    return this.prisma.emailDraft.create({
      data: {
        companyId,
        contactId: contact?.id ?? null,
        subject: output.subject,
        body: output.body,
        followUp1: output.followUp1,
        followUp2: output.followUp2,
        model,
      },
    });
  }

  list(companyId: string) {
    return this.prisma.emailDraft.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async update(
    draftId: string,
    input: { subject?: string; body?: string; followUp1?: string; followUp2?: string },
  ) {
    const draft = await this.prisma.emailDraft.findUnique({ where: { id: draftId } });
    if (!draft) {
      throw new NotFoundException({ code: 'DRAFT_NOT_FOUND', message: 'Draft not found' });
    }
    return this.prisma.emailDraft.update({ where: { id: draftId }, data: input });
  }
}
