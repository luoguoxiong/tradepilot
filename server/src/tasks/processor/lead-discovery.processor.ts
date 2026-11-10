import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { logger } from '../../logger';
import { PrismaService } from '../../prisma/prisma.service';
import { AdapterFactory, isAdapterError } from '../../adapters/adapter.factory';
import type { CompanySearchInput } from '../../adapters/types';
import { buildDedupeKey } from '../../adapters/dedupe.util';
import { ContactsService } from '../../contacts/contacts.service';
import { CustomsService } from '../../customs/customs.service';
import { LeadScoringService } from '../../ai/scoring/lead-scoring.service';
import { EmailGenerationService } from '../../ai/email/email-generation.service';
import { getEnv } from '../../config';

interface TaskParams {
  productKeywords: string[];
  country: string;
  companyTypes: string[];
  industryKeywords?: string[];
  limit: number;
}

type PipelineStep = 'searching' | 'enriching' | 'scoring' | 'emailing';
const PIPELINE: PipelineStep[] = ['searching', 'enriching', 'scoring', 'emailing'];

/**
 * Lead Discovery 编排器（完整闭环：搜索 → 联系人/海关补充 → AI 评分 → 开发信 + 合格客户入 CRM）。
 * 状态机：PENDING → SEARCHING → ENRICHING → SCORING → EMAILING → DONE / FAILED。
 * 每步写 task_step_logs；单企业失败不阻断（记 failed 后继续）；公司级操作幂等 upsert。
 */
@Processor('lead-discovery', { concurrency: 2 })
@Injectable()
export class LeadDiscoveryProcessor extends WorkerHost implements OnModuleDestroy {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdapterFactory) private readonly factory: AdapterFactory,
    @Inject(ContactsService) private readonly contactsService: ContactsService,
    @Inject(CustomsService) private readonly customsService: CustomsService,
    @Inject(LeadScoringService) private readonly scoringService: LeadScoringService,
    @Inject(EmailGenerationService) private readonly emailService: EmailGenerationService,
  ) {
    super();
  }

  async process(job: Job<{ taskId: string; fromStep?: PipelineStep }>): Promise<void> {
    const { taskId, fromStep } = job.data;
    const task = await this.prisma.searchTask.findUnique({ where: { id: taskId } });
    if (!task) {
      logger.warn({ taskId }, '任务不存在，跳过 job');
      return;
    }
    if (task.status === 'DONE' && !fromStep) {
      logger.info({ taskId }, '任务已完成（重复投递），跳过');
      return;
    }

    const params = task.params as unknown as TaskParams;
    const startIndex = fromStep ? PIPELINE.indexOf(fromStep) : 0;
    const steps = PIPELINE.slice(Math.max(0, startIndex));

    // searching 产出企业 ID 列表，供后续步骤使用
    let companyIds: string[] = [];
    for (const step of steps) {
      if (step === 'searching') {
        companyIds = await this.runSearching(task.id, task.userId, params);
      } else if (step === 'enriching') {
        await this.runEnriching(task.id, task.userId, companyIds);
      } else if (step === 'scoring') {
        companyIds = await this.runScoring(task.id, task.userId, companyIds);
      } else if (step === 'emailing') {
        await this.runEmailing(task.id, task.userId, companyIds);
      }
    }

    await this.prisma.searchTask.update({
      where: { id: task.id },
      data: { status: 'DONE', finishedAt: new Date() },
    });
    logger.info({ taskId }, '搜索任务完成（全闭环）');
  }

  // ---------- 步骤实现 ----------

  private async startStep(taskId: string, step: string, detail: string) {
    await this.prisma.searchTask.update({ where: { id: taskId }, data: { status: this.statusOf(step) } });
    return this.prisma.taskStepLog.create({
      data: { taskId, step, status: 'STARTED', detail },
    });
  }

  private statusOf(step: string): 'SEARCHING' | 'ENRICHING' | 'SCORING' | 'EMAILING' {
    return step === 'searching'
      ? 'SEARCHING'
      : step === 'enriching'
        ? 'ENRICHING'
        : step === 'scoring'
          ? 'SCORING'
          : 'EMAILING';
  }

  private async finishStep(logId: string, ok: boolean, detail: string) {
    await this.prisma.taskStepLog.update({
      where: { id: logId },
      data: { status: ok ? 'DONE' : 'FAILED', finishedAt: new Date(), detail },
    });
  }

  /** searching：搜索 → 幂等 upsert companies → 建 enrichment_tasks（3 子步占位） */
  private async runSearching(taskId: string, userId: string, params: TaskParams): Promise<string[]> {
    const log = await this.startStep(taskId, 'searching', `keywords=${params.productKeywords.join('|')} country=${params.country}`);
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

      const companyIds: string[] = [];
      for (const result of results) {
        const dedupeKey = buildDedupeKey(result.name, result.website);
        const company = await this.prisma.company.upsert({
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
        companyIds.push(company.id);
        // 每企业 3 个补充子步占位（CONTACTS/CUSTOMS 由本任务执行；ENRICH 预留）
        for (const substep of ['CONTACTS', 'CUSTOMS', 'ENRICH'] as const) {
          await this.prisma.enrichmentTask.upsert({
            where: { searchTaskId_companyId_substep: { searchTaskId: taskId, companyId: company.id, substep } },
            update: {},
            create: { searchTaskId: taskId, companyId: company.id, substep, status: 'PENDING' },
          });
        }
      }

      await this.prisma.searchTask.update({
        where: { id: taskId },
        data: { processedCompanies: companyIds.length, totalCompanies: companyIds.length },
      });
      await this.finishStep(log.id, true, `upserted=${companyIds.length}`);
      return companyIds;
    } catch (err) {
      const detail = this.errorDetail(err);
      await this.finishStep(log.id, false, detail);
      await this.prisma.searchTask.update({
        where: { id: taskId },
        data: { status: 'FAILED', error: detail, finishedAt: new Date() },
      });
      throw err;
    }
  }

  /** enriching：逐企业逐子步（联系人挖掘 / 海关查询）；单企业失败记录后继续 */
  private async runEnriching(taskId: string, userId: string, companyIds: string[]): Promise<void> {
    const log = await this.startStep(taskId, 'enriching', `companies=${companyIds.length}`);
    const tasks = await this.prisma.enrichmentTask.findMany({
      where: { searchTaskId: taskId, status: { in: ['PENDING', 'FAILED'] } },
    });

    let done = 0;
    let failed = 0;
    for (const subtask of tasks) {
      await this.prisma.enrichmentTask.update({ where: { id: subtask.id }, data: { status: 'RUNNING' } });
      try {
        if (subtask.substep === 'CONTACTS') {
          await this.contactsService.discover(subtask.companyId, userId, [
            'Purchasing Manager',
            'Procurement Manager',
            'Sourcing Manager',
            'Import Manager',
            'CEO',
            'Founder',
          ]);
        } else if (subtask.substep === 'CUSTOMS') {
          await this.customsService.queryAndStore(subtask.companyId, userId);
        } else {
          // ENRICH：企业信息补充 Adapter 在 Real 数据源场景生效；Mock 搜索结果已含主参数据
          await this.prisma.enrichmentTask.update({
            where: { id: subtask.id },
            data: { status: 'SKIPPED', error: 'Mock 搜索结果已含主参数据，无需补充' },
          });
          done += 1;
          continue;
        }
        await this.prisma.enrichmentTask.update({ where: { id: subtask.id }, data: { status: 'DONE' } });
        done += 1;
      } catch (err) {
        const detail = this.errorDetail(err);
        await this.prisma.enrichmentTask.update({ where: { id: subtask.id }, data: { status: 'FAILED', error: detail } });
        await this.prisma.taskStepLog.create({
          data: { taskId, step: `enriching:${subtask.substep.toLowerCase()}`, status: 'FAILED', detail, companyId: subtask.companyId },
        });
        failed += 1; // 单企业失败不阻断
      }
    }

    await this.prisma.searchTask.update({
      where: { id: taskId },
      data: { failedCount: failed },
    });
    await this.finishStep(log.id, true, `done=${done} failed=${failed}`);
  }

  /** scoring：逐企业 AI 评分；超过 TASK_SCORE_LIMIT 的标记 SKIPPED（可单企业手动触发） */
  private async runScoring(taskId: string, userId: string, companyIds: string[]): Promise<string[]> {
    const limit = getEnv().TASK_SCORE_LIMIT;
    const log = await this.startStep(taskId, 'scoring', `companies=${companyIds.length} limit=${limit}`);
    const scoredIds: string[] = [];
    let skipped = 0;
    let failed = 0;

    for (const companyId of companyIds) {
      if (scoredIds.length >= limit) {
        skipped += 1;
        continue;
      }
      try {
        await this.scoringService.score(companyId, userId);
        scoredIds.push(companyId);
      } catch (err) {
        const detail = this.errorDetail(err);
        await this.prisma.taskStepLog.create({
          data: { taskId, step: 'scoring', status: 'FAILED', detail, companyId },
        });
        failed += 1;
      }
    }

    await this.prisma.searchTask.update({
      where: { id: taskId },
      data: { skippedCount: skipped, failedCount: { increment: failed } },
    });
    await this.finishStep(log.id, true, `scored=${scoredIds.length} skipped=${skipped} failed=${failed}`);
    return scoredIds;
  }

  /** emailing：A/B/C 级客户生成开发信草稿 + 自动导入 CRM（NEW） */
  private async runEmailing(taskId: string, userId: string, companyIds: string[]): Promise<void> {
    const log = await this.startStep(taskId, 'emailing', `candidates=${companyIds.length}`);
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const companyId of companyIds) {
      const latest = await this.prisma.leadScore.findFirst({
        where: { companyId, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
      });
      if (!latest || !latest.grade || !['A', 'B', 'C'].includes(latest.grade)) {
        skipped += 1;
        continue;
      }
      try {
        await this.emailService.generate(companyId, userId, null);
        const company = await this.prisma.company.findUnique({ where: { id: companyId } });
        if (company && company.crmStatus === null) {
          await this.prisma.company.update({
            where: { id: companyId },
            data: { crmStatus: 'NEW', ownerUserId: userId },
          });
        }
        created += 1;
      } catch (err) {
        await this.prisma.taskStepLog.create({
          data: { taskId, step: 'emailing', status: 'FAILED', detail: this.errorDetail(err), companyId },
        });
        failed += 1;
      }
    }

    await this.prisma.searchTask.update({
      where: { id: taskId },
      data: { failedCount: { increment: failed } },
    });
    await this.finishStep(log.id, true, `emailed=${created} skipped=${skipped} failed=${failed}`);
  }

  private errorDetail(err: unknown): string {
    return isAdapterError(err)
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  }

  /** 重试耗尽兜底：确保任务不永久卡在中间态（架构 §3.2 对账） */
  protected async onFailed(job: Job<{ taskId: string; fromStep?: PipelineStep }>, error: Error): Promise<void> {
    logger.error({ taskId: job.data?.taskId, err: error.message }, '搜索任务重试耗尽');
    if (!job.data?.taskId) return;
    await this.prisma.searchTask.updateMany({
      where: { id: job.data.taskId, status: { notIn: ['DONE'] } },
      data: { status: 'FAILED', error: `重试耗尽: ${error.message}`, finishedAt: new Date() },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
