import { Inject, Injectable } from '@nestjs/common';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { rowsToObjects, toCsv } from './csv.util';

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
}

/** CSV 导入导出（companies/contacts）：导出再导入数据无损往返（阶段 7 验收门） */
@Injectable()
export class CsvService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async exportCompanies(): Promise<string> {
    const companies = await this.prisma.company.findMany({ orderBy: { createdAt: 'asc' } });
    const rows = companies.map((c) => [
      c.name,
      c.dedupeKey,
      c.website ?? '',
      c.country,
      c.description ?? '',
      c.mainProducts.join('|'),
      c.email ?? '',
      c.linkedinUrl ?? '',
      c.source,
      c.isFavorite ? 'true' : 'false',
      c.crmStatus ?? '',
      c.nextFollowUpAt ? c.nextFollowUpAt.toISOString() : '',
      c.searchedAt.toISOString(),
    ]);
    return toCsv(
      ['name', 'dedupeKey', 'website', 'country', 'description', 'mainProducts', 'email', 'linkedinUrl', 'source', 'isFavorite', 'crmStatus', 'nextFollowUpAt', 'searchedAt'],
      rows,
    );
  }

  async exportContacts(): Promise<string> {
    const contacts = await this.prisma.contact.findMany({
      orderBy: { createdAt: 'asc' },
      include: { company: { select: { dedupeKey: true, name: true } } },
    });
    const rows = contacts.map((c) => [
      c.company.name,
      c.company.dedupeKey,
      c.name,
      c.title,
      c.email ?? '',
      c.linkedinUrl ?? '',
      c.country ?? '',
      c.source,
      c.emailVerified,
      c.isManual ? 'true' : 'false',
    ]);
    return toCsv(
      ['companyName', 'companyDedupeKey', 'name', 'title', 'email', 'linkedinUrl', 'country', 'source', 'emailVerified', 'isManual'],
      rows,
    );
  }

  /** 企业导入：按 dedupeKey upsert（存在则更新展示字段，CRM 状态不覆盖） */
  async importCompanies(csv: string, userId: string): Promise<ImportResult> {
    const rows = rowsToObjects(csv);
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.name || !row.country || !row.dedupeKey) {
        skipped += 1;
        continue;
      }
      const data = {
        name: row.name,
        website: row.website || null,
        country: row.country.toUpperCase().slice(0, 2),
        description: row.description || null,
        mainProducts: row.mainProducts ? row.mainProducts.split('|').filter(Boolean) : [],
        email: row.email || null,
        linkedinUrl: row.linkedinUrl || null,
      };
      const existing = await this.prisma.company.findUnique({ where: { dedupeKey: row.dedupeKey } });
      if (existing) {
        await this.prisma.company.update({ where: { dedupeKey: row.dedupeKey }, data });
        updated += 1;
      } else {
        await this.prisma.company.create({
          data: { ...data, dedupeKey: row.dedupeKey, source: row.source || 'import', searchedAt: new Date() },
        });
        created += 1;
      }
    }

    await this.prisma.auditLog.create({
      data: { userId, action: 'crm.import_csv', entityType: 'Company', detail: { created, updated, skipped } },
    });
    logger.info({ created, updated, skipped }, 'CSV 企业导入完成');
    return { created, updated, skipped };
  }

  /** 联系人导入：按公司 dedupeKey 定位；(companyId,email) 唯一 → 已存在跳过 */
  async importContacts(csv: string, userId: string): Promise<ImportResult> {
    const rows = rowsToObjects(csv);
    let created = 0;
    let updated = 0;
    let skipped = 0;

    const companyByKey = new Map<string, { id: string }>();
    for (const row of rows) {
      if (!row.companyDedupeKey || !row.name || !row.title) {
        skipped += 1;
        continue;
      }
      let company = companyByKey.get(row.companyDedupeKey);
      if (!company) {
        const found = await this.prisma.company.findUnique({ where: { dedupeKey: row.companyDedupeKey } });
        if (!found) {
          skipped += 1;
          continue;
        }
        company = { id: found.id };
        companyByKey.set(row.companyDedupeKey, company);
      }

      const data = {
        title: row.title,
        linkedinUrl: row.linkedinUrl || null,
        country: row.country || null,
        emailVerified: (['VERIFIED', 'UNVERIFIED', 'UNKNOWN'].includes(row.emailVerified)
          ? row.emailVerified
          : 'UNKNOWN') as 'VERIFIED' | 'UNVERIFIED' | 'UNKNOWN',
        isManual: row.isManual === 'true',
        source: row.source || 'import',
      };

      if (row.email) {
        const existing = await this.prisma.contact.findUnique({
          where: { companyId_email: { companyId: company.id, email: row.email } },
        });
        if (existing) {
          await this.prisma.contact.update({ where: { id: existing.id }, data });
          updated += 1;
          continue;
        }
        await this.prisma.contact.create({
          data: { ...data, companyId: company.id, name: row.name, email: row.email },
        });
        created += 1;
      } else {
        await this.prisma.contact.create({
          data: { ...data, companyId: company.id, name: row.name },
        });
        created += 1;
      }
    }

    await this.prisma.auditLog.create({
      data: { userId, action: 'crm.import_csv', entityType: 'Contact', detail: { created, updated, skipped } },
    });
    return { created, updated, skipped };
  }
}
