import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { ALLOWED_TRANSITIONS, type ListCustomersQuery } from './crm.schemas';
import type { CrmStatusValue } from './crm.schemas';

export interface CrmSummary {
  totalCustomers: number;
  byStatus: Record<string, number>;
  dueFollowUps: { id: string; name: string; crmStatus: string; nextFollowUpAt: string }[];
}

@Injectable()
export class CrmService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private customerWhere(query: ListCustomersQuery) {
    return {
      crmStatus: query.status ? query.status : { not: null },
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
      ...(query.dueWithinDays !== undefined
        ? { nextFollowUpAt: { lte: new Date(Date.now() + query.dueWithinDays * 86400000) } }
        : {}),
    } as const;
  }

  /** CRM 客户列表（= crmStatus 非空的企业），状态筛选/搜索/分页 */
  async list(query: ListCustomersQuery) {
    const where = this.customerWhere(query);
    const [total, data] = await Promise.all([
      this.prisma.company.count({ where }),
      this.prisma.company.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          leadScores: { orderBy: { createdAt: 'desc' }, take: 1, select: { score: true, grade: true } },
          activities: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, createdAt: true } },
        },
      }),
    ]);
    return {
      data: data.map((c) => ({
        ...c,
        latestScore: c.leadScores[0] ?? null,
        latestActivity: c.activities[0] ?? null,
        leadScores: undefined,
        activities: undefined,
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  /** 客户详情整合视图：企业 + 联系人 + 采购记录 + AI + 邮件 + 跟进时间线 */
  async getCustomer(id: string) {
    const customer = await this.prisma.company.findUnique({
      where: { id },
      include: {
        contacts: { orderBy: { createdAt: 'asc' } },
        customsRecords: { orderBy: { shipmentDate: 'desc' } },
        leadScores: { orderBy: { createdAt: 'desc' }, take: 1 },
        emailDrafts: { orderBy: { createdAt: 'desc' }, take: 5 },
        activities: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!customer || customer.crmStatus === null) {
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found in CRM' });
    }
    return {
      ...customer,
      latestScore: customer.leadScores[0] ?? null,
      leadScores: undefined,
    };
  }

  /** 状态流转：非法跳转 400；每次流转写审计 + STATUS_CHANGE 跟进记录 */
  async transition(id: string, userId: string, to: CrmStatusValue, note?: string) {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company || company.crmStatus === null) {
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found in CRM' });
    }
    const from = company.crmStatus as CrmStatusValue;
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException({
        code: 'INVALID_TRANSITION',
        message: `不允许的状态流转：${from} → ${to}（合法目标：${ALLOWED_TRANSITIONS[from].join(', ') || '无（终态）'}）`,
      });
    }

    const updated = await this.prisma.company.update({ where: { id }, data: { crmStatus: to } });
    await this.prisma.crmActivity.create({
      data: {
        companyId: id,
        userId,
        type: 'STATUS_CHANGE',
        content: note ? `状态流转 ${from} → ${to}：${note}` : `状态流转 ${from} → ${to}`,
      },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: 'crm.status_change', entityType: 'Company', entityId: id, detail: { from, to } },
    });
    logger.info({ companyId: id, from, to, userId }, 'CRM 状态流转');
    return updated;
  }

  /** 添加跟进记录；设置了 nextFollowUpAt 时同步 company.nextFollowUpAt（Dashboard 待跟进依据） */
  async addActivity(
    id: string,
    userId: string,
    input: { type: 'NOTE' | 'STATUS_CHANGE' | 'FOLLOW_UP'; content: string; nextFollowUpAt?: Date },
  ) {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company || company.crmStatus === null) {
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found in CRM' });
    }
    const [activity] = await this.prisma.$transaction([
      this.prisma.crmActivity.create({
        data: { companyId: id, userId, type: input.type, content: input.content, nextFollowUpAt: input.nextFollowUpAt },
      }),
      ...(input.nextFollowUpAt
        ? [this.prisma.company.update({ where: { id }, data: { nextFollowUpAt: input.nextFollowUpAt } })]
        : []),
    ]);
    return activity;
  }

  /** Dashboard 汇总：总数、状态分布、待跟进（7 天内到期优先） */
  async summary(): Promise<CrmSummary> {
    const [total, groupBy, due] = await Promise.all([
      this.prisma.company.count({ where: { crmStatus: { not: null } } }),
      this.prisma.company.groupBy({ by: ['crmStatus'], where: { crmStatus: { not: null } }, _count: true }),
      this.prisma.company.findMany({
        where: {
          crmStatus: { not: null },
          nextFollowUpAt: { not: null, lte: new Date(Date.now() + 7 * 86400000) },
        },
        orderBy: { nextFollowUpAt: 'asc' },
        take: 10,
        select: { id: true, name: true, crmStatus: true, nextFollowUpAt: true },
      }),
    ]);
    const byStatus: Record<string, number> = {};
    groupBy.forEach((g) => {
      if (g.crmStatus) byStatus[g.crmStatus] = g._count;
    });
    return {
      totalCustomers: total,
      byStatus,
      dueFollowUps: due.map((c) => ({
        id: c.id,
        name: c.name,
        crmStatus: c.crmStatus as string,
        nextFollowUpAt: (c.nextFollowUpAt as Date).toISOString(),
      })),
    };
  }
}
