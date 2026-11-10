import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { logger } from '../../logger';
import { PrismaService } from '../../prisma/prisma.service';
import { AdapterFactory, isAdapterError } from '../../adapters/adapter.factory';
import type { CompanySearchInput } from '../../adapters/types';
import { buildDedupeKey } from '../../adapters/dedupe.util';

interface TaskParams {
  productKeywords: string[];
  country: string;
  companyTypes: string[];
  industryKeywords?: string[];
  limit: number;
}

/**
 * Lead Discovery 编排器（阶段 5 交付 searching 步；enriching/scoring/emailing 在阶段 6/7 接入）。
 * 状态机：PENDING → SEARCHING → DONE/FAILED；每步写 task_step_logs；公司按 dedupeKey 幂等 upsert。
 */
@Processor('lead-discovery', { concurrency: 2 })
@Injectable()
export class LeadDiscoveryProcessor extends WorkerHost implements OnModuleDestroy {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdapterFactory) private readonly factory: AdapterFactory,
  ) {
    super();
  }

  async process(job: Job<{ taskId: string }>): Promise<void> {
    const { taskId } = job.data;
    const task = await this.prisma.searchTask.findUnique({ where: { id: taskId } });
    if (!task) {
      logger.warn({ taskId }, '任务不存在，跳过 job');
      return;
    }
    if (task.status === 'DONE') {
      logger.info({ taskId }, '任务已完成（重复投递），跳过');
      return;
    }

    const params = task.params as unknown as TaskParams;
    const totalCompanies = await this.runSearching(task.id, task.userId, params);

    await this.prisma.searchTask.update({
      where: { id: task.id },
      data: { status: 'DONE', totalCompanies, finishedAt: new Date() },
    });
    logger.info({ taskId, totalCompanies }, '搜索任务完成');
  }

  /** searching 步骤：调用搜索 Adapter → 幂等 upsert companies */
  private async runSearching(taskId: string, userId: string, params: TaskParams): Promise<number> {
    await this.prisma.searchTask.update({ where: { id: taskId }, data: { status: 'SEARCHING', startedAt: new Date() } });
    const log = await this.prisma.taskStepLog.create({
      data: { taskId, step: 'searching', status: 'STARTED', detail: `keywords=${params.productKeywords.join('|')} country=${params.country}` },
    });

    try {
      const adapter = await this.factory.companySearch({ userId, timeoutMs: 15000 });
      const input: CompanySearchInput = {
        productKeywords: params.productKeywords,
        country: params.country,
        companyTypes: params.companyTypes,
        industryKeywords: params.industryKeywords,
        limit: params.limit,
      };
      const results = await adapter.search(input, { userId, timeoutMs: 15000 });

      let processed = 0;
      for (const result of results) {
        const dedupeKey = buildDedupeKey(result.name, result.website);
        await this.prisma.company.upsert({
          where: { dedupeKey },
          update: {
            name: result.name,
            website: result.website,
            country: result.country,
            description: result.description,
            mainProducts: result.mainProducts ?? [],
            email: result.email,
            linkedinUrl: result.linkedinUrl,
            source: result.source,
            searchedAt: result.searchedAt,
          },
          create: {
            dedupeKey,
            name: result.name,
            website: result.website,
            country: result.country,
            description: result.description,
            mainProducts: result.mainProducts ?? [],
            email: result.email,
            linkedinUrl: result.linkedinUrl,
            source: result.source,
            searchedAt: result.searchedAt,
          },
        });
        processed += 1;
      }

      await this.prisma.searchTask.update({
        where: { id: taskId },
        data: { processedCompanies: processed, totalCompanies: processed },
      });
      await this.prisma.taskStepLog.update({
        where: { id: log.id },
        data: { status: 'DONE', finishedAt: new Date(), detail: `upserted=${processed}` },
      });
      return processed;
    } catch (err) {
      const detail = isAdapterError(err)
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      await this.prisma.taskStepLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', finishedAt: new Date(), detail },
      });
      await this.prisma.searchTask.update({
        where: { id: taskId },
        data: { status: 'FAILED', error: detail, finishedAt: new Date() },
      });
      throw err; // 交给 BullMQ 按 attempts 重试；任务已标 FAILED，重试成功会重新置 DONE
    }
  }

  /** 重试耗尽兜底：确保任务不永久卡在中间态（架构 §3.2 对账） */
  protected async onFailed(job: Job<{ taskId: string }>, error: Error): Promise<void> {
    logger.error({ taskId: job.data?.taskId, err: error.message }, '搜索任务重试耗尽');
    if (!job.data?.taskId) return;
    await this.prisma.searchTask.updateMany({
      where: { id: job.data.taskId, status: { in: ['PENDING', 'SEARCHING'] } },
      data: { status: 'FAILED', error: `重试耗尽: ${error.message}`, finishedAt: new Date() },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
