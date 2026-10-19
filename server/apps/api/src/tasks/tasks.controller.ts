import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema, logAfterQuerySchema } from '@tradepilot/shared';
import { TasksService } from './tasks.service.js';
import {
  batchTaskActionSchema,
  createTaskSchema,
  listTasksQuerySchema,
  transferToHumanSchema,
} from './tasks.dto.js';
import type {
  BatchTaskActionDto,
  CreateTaskDto,
  ListTasksQuery,
  TransferToHumanDto,
} from './tasks.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 任务中心接口（接口 14 §3）：
 * P0：POST/GET /tasks、GET /{id}、GET /{id}/logs（after 增量）、GET /{id}/steps、POST /{id}/retry。
 * P1-X-30~33：POST /{id}/pause、/{id}/resume、/{id}/cancel、/{id}/transfer-to-human、POST /tasks/batch。
 * SSE stream 见 sse.controller（M3-15）。
 */
@Controller('tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(createTaskSchema)) dto: CreateTaskDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.tasks.create(user.orgId, user.sub, dto);
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(listTasksQuerySchema.merge(paginationQuerySchema)))
    query: ListTasksQuery & { page: number; pageSize: number; keyword?: string },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.tasks.list(this.requireUser(req).orgId, query);
  }

  @Get(':id')
  async detail(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.tasks.detail(this.requireUser(req).orgId, taskId);
  }

  @Get(':id/logs')
  async logs(
    @Param('id') taskId: string,
    @Query(new ZodValidationPipe(logAfterQuerySchema)) query: { after?: string; limit: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.tasks.logs(this.requireUser(req).orgId, taskId, query.after, query.limit);
  }

  @Get(':id/steps')
  async steps(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const detail = await this.tasks.detail(this.requireUser(req).orgId, taskId);
    return { items: detail.steps };
  }

  @Post(':id/retry')
  async retry(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.tasks.retry(user.orgId, user.sub, taskId);
  }

  /** 14 §3.6 暂停（P1-X-30） */
  @Post(':id/pause')
  async pause(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.tasks.pause(this.requireUser(req).orgId, taskId);
  }

  /** 14 §3.6 恢复（P1-X-30）：已产生检查点则从最近检查点续跑 */
  @Post(':id/resume')
  async resume(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.tasks.resume(this.requireUser(req).orgId, taskId);
  }

  /** 14 §3.6 取消（P1-X-30）：终态 canceled + SSE 收口 */
  @Post(':id/cancel')
  async cancel(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.tasks.cancel(this.requireUser(req).orgId, taskId);
  }

  /** 14 §3.6 转人工（P1-X-31）：暂停图 + 写 outputs 交接摘要 */
  @Post(':id/transfer-to-human')
  async transferToHuman(
    @Param('id') taskId: string,
    @Body(new ZodValidationPipe(transferToHumanSchema)) dto: TransferToHumanDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.tasks.transferToHuman(user.orgId, user.sub, taskId, dto);
  }

  /** 14 §3.7 失败批量处理（P1-X-33）：多选重试 / 转人工 */
  @Post('batch')
  async batch(
    @Body(new ZodValidationPipe(batchTaskActionSchema)) dto: BatchTaskActionDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.tasks.batch(user.orgId, user.sub, dto);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}
