import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { CreateSearchTaskInput, RetryTaskInput } from './tasks.schemas';

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue('lead-discovery') private readonly queue: Queue,
  ) {}

  /** 创建任务并入队（幂等：同一任务重复入队无副作用，job 依赖 taskId 幂等 upsert） */
  async create(userId: string, input: CreateSearchTaskInput) {
    // 产品归属校验
    if (input.productId) {
      const product = await this.prisma.product.findUnique({ where: { id: input.productId } });
      if (!product || product.userId !== userId) {
        throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
      }
    }

    const task = await this.prisma.searchTask.create({
      data: {
        userId,
        productId: input.productId,
        params: {
          productKeywords: input.productKeywords,
          country: input.country,
          companyTypes: input.companyTypes,
          ...(input.industryKeywords ? { industryKeywords: input.industryKeywords } : {}),
          limit: input.limit,
        },
      },
    });

    await this.queue.add('lead-discovery', { taskId: task.id }, { jobId: task.id });

    return task;
  }

  async list(userId: string, page: number, pageSize: number): Promise<Paginated<unknown>> {
    const [total, data] = await Promise.all([
      this.prisma.searchTask.count({ where: { userId } }),
      this.prisma.searchTask.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data,
      pagination: { page, pageSize, totalItems: total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /** 任务详情（含步骤日志）；归属校验 */
  async get(userId: string, id: string) {
    const task = await this.prisma.searchTask.findUnique({
      where: { id },
      include: { steps: { orderBy: { startedAt: 'asc' } } },
    });
    if (!task || task.userId !== userId) {
      throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    }
    return task;
  }

  /** 从指定步骤重试（阶段 5 支持 searching 整步重跑；enriching 子步在阶段 6/7 接入） */
  async retry(userId: string, id: string, input: RetryTaskInput) {
    const task = await this.get(userId, id);
    if (input.fromStep !== 'searching') {
      // 阶段 6/7 交付对应子步；当前明确拒绝而非假装成功
      throw new NotFoundException({
        code: 'STEP_NOT_IMPLEMENTED',
        message: `步骤 ${input.fromStep} 将在后续阶段交付，当前仅支持 searching`,
      });
    }

    await this.prisma.$transaction([
      this.prisma.searchTask.update({
        where: { id: task.id },
        data: {
          status: 'PENDING',
          error: null,
          processedCompanies: 0,
          skippedCount: 0,
          failedCount: 0,
          finishedAt: null,
        },
      }),
      this.prisma.taskStepLog.deleteMany({ where: { taskId: task.id, step: 'searching' } }),
    ]);

    // jobId 固定为 taskId：若旧 job 仍在队里会冲突，先清理再入队
    await this.queue.removeJobScheduler?.(`repeat:${task.id}`).catch(() => undefined);
    await this.queue
      .add('lead-discovery', { taskId: task.id }, { jobId: `${task.id}:retry:${Date.now()}` });
    return this.get(userId, task.id);
  }
}
