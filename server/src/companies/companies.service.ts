import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { ListCompaniesQuery } from './companies.schemas';

@Injectable()
export class CompaniesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(query: ListCompaniesQuery) {
    const where = {
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { website: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.isFavorite !== undefined ? { isFavorite: query.isFavorite } : {}),
      ...(query.inCrm !== undefined ? { crmStatus: query.inCrm ? { not: null } : null } : {}),
    };

    const [total, data] = await Promise.all([
      this.prisma.company.count({ where }),
      this.prisma.company.findMany({
        where,
        orderBy: { searchedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          leadScores: { orderBy: { createdAt: 'desc' }, take: 1, select: { score: true, grade: true } },
        },
      }),
    ]);

    return {
      data: data.map((c) => ({
        ...c,
        latestScore: c.leadScores[0] ?? null,
        leadScores: undefined,
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  /** 详情：企业 + 联系人 + 海关记录 + 最新评分（Company Detail 基础版） */
  async get(id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        contacts: { orderBy: { createdAt: 'asc' } },
        customsRecords: { orderBy: { shipmentDate: 'desc' } },
        leadScores: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
    }
    return { ...company, latestScore: company.leadScores[0] ?? null };
  }

  async setFavorite(id: string, isFavorite: boolean) {
    const company = await this.prisma.company.findUnique({ where: { id }, select: { id: true } });
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
    }
    return this.prisma.company.update({ where: { id }, data: { isFavorite } });
  }

  /** 批量导入 CRM：置 NEW + 负责人；已在 CRM 的跳过；写审计日志 */
  async importCrm(companyIds: string[], userId: string): Promise<{ imported: number; skipped: number }> {
    const result = await this.prisma.company.updateMany({
      where: { id: { in: companyIds }, crmStatus: null },
      data: { crmStatus: 'NEW', ownerUserId: userId },
    });
    const imported = result.count;
    const skipped = companyIds.length - imported;

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'crm.import',
        entityType: 'Company',
        detail: { requested: companyIds.length, imported, skipped },
      },
    });
    return { imported, skipped };
  }
}
