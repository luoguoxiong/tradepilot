import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { AdapterFactory } from '../adapters/adapter.factory';
import { isAdapterError } from '../adapters/adapter.factory';
import type { ManualContactInput } from './contacts.schemas';

export interface DiscoverResult {
  created: number;
  skipped: number;
  /** 适配器是否 Mock（DEMO 数据） */
  demo: boolean;
  error?: string;
}

@Injectable()
export class ContactsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdapterFactory) private readonly factory: AdapterFactory,
  ) {}

  private async getCompany(companyId: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
    }
    return company;
  }

  /** 手动补充联系人（isManual=true, source='manual'）；邮箱重复返回 409 由唯一约束+过滤器承担 */
  async addManual(companyId: string, input: ManualContactInput) {
    await this.getCompany(companyId);
    return this.prisma.contact.create({
      data: {
        companyId,
        name: input.name,
        title: input.title,
        email: input.email,
        linkedinUrl: input.linkedinUrl,
        country: input.country,
        source: 'manual',
        emailVerified: input.email ? 'UNVERIFIED' : 'UNKNOWN',
        isManual: true,
      },
    });
  }

  /**
   * 联系人挖掘（Apollo Real / Mock 降级）。
 * 去重：有邮箱按 (companyId, email) 唯一跳过；无邮箱按 (companyId, name, title) 跳过。
 * 结果 source='demo'（Mock）或 'apollo'（Real），前端展示 DEMO 徽章。
   */
  async discover(companyId: string, userId: string, titles: string[]): Promise<DiscoverResult & { contacts: unknown[] }> {
    const company = await this.getCompany(companyId);
    const adapter = await this.factory.contactDiscovery({ userId, timeoutMs: 15000 });
    const demo = adapter.constructor.name.includes('Mock');

    let candidates;
    try {
      candidates = await adapter.discover({ company: { id: company.id, name: company.name, website: company.website ?? undefined, country: company.country }, titles }, { userId, timeoutMs: 15000 });
    } catch (err) {
      if (isAdapterError(err)) {
        logger.warn({ companyId, code: err.code }, '联系人挖掘失败（Adapter）');
        return { created: 0, skipped: 0, demo: false, error: `${err.code}: ${err.message}`, contacts: [] };
      }
      throw err;
    }

    const existing = await this.prisma.contact.findMany({ where: { companyId } });
    const emailSet = new Set(existing.filter((c) => c.email).map((c) => c.email as string));
    const nameTitleSet = new Set(existing.map((c) => `${c.name}|${c.title}`.toLowerCase()));

    let created = 0;
    let skipped = 0;
    const isDemo = candidates.every((c) => c.source === 'demo');
    for (const candidate of candidates) {
      const dupByEmail = candidate.email && emailSet.has(candidate.email);
      const dupByName = nameTitleSet.has(`${candidate.name}|${candidate.title}`.toLowerCase());
      if (dupByEmail || dupByName) {
        skipped += 1;
        continue;
      }
      await this.prisma.contact.create({
        data: {
          companyId,
          name: candidate.name,
          title: candidate.title,
          email: candidate.email,
          linkedinUrl: candidate.linkedinUrl,
          country: candidate.country ?? company.country,
          source: candidate.source,
          // 契约小写 → Prisma 枚举大写
          emailVerified: candidate.emailVerified.toUpperCase() as 'VERIFIED' | 'UNVERIFIED' | 'UNKNOWN',
          isManual: false,
        },
      });
      if (candidate.email) emailSet.add(candidate.email);
      nameTitleSet.add(`${candidate.name}|${candidate.title}`.toLowerCase());
      created += 1;
    }

    return { created, skipped, demo: isDemo, contacts: await this.prisma.contact.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }) };
  }

  listByCompany(companyId: string) {
    return this.prisma.contact.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
  }
}
