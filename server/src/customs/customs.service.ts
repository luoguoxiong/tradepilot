import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { AdapterFactory, isAdapterError } from '../adapters/adapter.factory';
import type { CustomsRecordResult } from '../adapters/customs/customs.adapter';

export interface CustomsSummary {
  recordCount: number;
  firstShipmentDate: string | null;
  lastShipmentDate: string | null;
  frequency: 'monthly' | 'quarterly' | 'yearly' | 'irregular' | 'unknown';
  supplierCountries: string[];
  demo: boolean;
}

@Injectable()
export class CustomsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdapterFactory) private readonly factory: AdapterFactory,
  ) {}

  /** 查询并缓存海关记录：Adapter 拉取 → 幂等落库（companyId+shipmentDate+description 去重）→ 聚合 */
  async queryAndStore(companyId: string, userId: string): Promise<{ records: unknown[]; summary: CustomsSummary; error?: string }> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
    }

    const adapter = await this.factory.customs({ userId, timeoutMs: 15000 });
    let fetched: CustomsRecordResult[];
    let error: string | undefined;
    try {
      fetched = await adapter.queryImportRecords(
        { company: { name: company.name, website: company.website ?? undefined, country: company.country } },
        { userId, timeoutMs: 15000 },
      );
    } catch (err) {
      if (isAdapterError(err)) {
        logger.warn({ companyId, code: err.code }, '海关数据查询失败（Adapter）');
        error = `${err.code}: ${err.message}`;
        fetched = [];
      } else {
        throw err;
      }
    }

    for (const record of fetched) {
      const existing = await this.prisma.customsRecord.findFirst({
        where: {
          companyId,
          shipmentDate: record.shipmentDate,
          productDescription: record.productDescription ?? null,
        },
      });
      if (!existing) {
        await this.prisma.customsRecord.create({
          data: {
            companyId,
            companyName: record.companyName,
            importCountry: record.importCountry,
            productDescription: record.productDescription,
            hsCode: record.hsCode,
            shipmentDate: record.shipmentDate,
            quantity: record.quantity,
            supplierCountry: record.supplierCountry,
            supplierName: record.supplierName,
            source: record.source,
          },
        });
      }
    }

    const records = await this.prisma.customsRecord.findMany({
      where: { companyId },
      orderBy: { shipmentDate: 'desc' },
    });
    return { records, summary: this.summarize(records.map((r) => ({ ...r, shipmentDate: r.shipmentDate }))), error };
  }

  /** 已存记录 + 聚合摘要（不触发外部调用） */
  async listWithSummary(companyId: string): Promise<{ records: unknown[]; summary: CustomsSummary | null }> {
    const records = await this.prisma.customsRecord.findMany({
      where: { companyId },
      orderBy: { shipmentDate: 'desc' },
    });
    return {
      records,
      summary: records.length ? this.summarize(records) : null,
    };
  }

  /** 企业级聚合（architecture.md §4.5：频率等结论由服务层从多条记录推导） */
  private summarize(records: { shipmentDate: Date; supplierCountry: string | null; source: string }[]): CustomsSummary {
    const sorted = [...records].sort((a, b) => a.shipmentDate.getTime() - b.shipmentDate.getTime());
    let frequency: CustomsSummary['frequency'] = 'unknown';
    if (sorted.length >= 2) {
      const spanDays = (sorted[sorted.length - 1].shipmentDate.getTime() - sorted[0].shipmentDate.getTime()) / 86400000;
      const avgGapDays = spanDays / (sorted.length - 1);
      frequency =
        avgGapDays <= 40 ? 'monthly' : avgGapDays <= 100 ? 'quarterly' : avgGapDays <= 380 ? 'yearly' : 'irregular';
    }
    return {
      recordCount: sorted.length,
      firstShipmentDate: sorted[0]?.shipmentDate.toISOString().slice(0, 10) ?? null,
      lastShipmentDate: sorted[sorted.length - 1]?.shipmentDate.toISOString().slice(0, 10) ?? null,
      frequency,
      supplierCountries: [...new Set(records.map((r) => r.supplierCountry).filter((c): c is string => Boolean(c)))],
      demo: records.length > 0 && records.every((r) => r.source === 'demo'),
    };
  }
}
