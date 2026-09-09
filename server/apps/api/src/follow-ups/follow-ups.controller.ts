/**
 * 07-AI 自动跟进接口（接口 07 §2/§3，M5-D1）：
 * - @Controller('follow-ups')：GET /follow-ups/summary
 * - @Controller('follow-up-tasks')：GET /、POST /{id}/pause、POST /{id}/skip
 * - @Controller('follow-up-strategies')：GET /、POST /、PUT /{id}、DELETE /{id}、
 *   GET /{id}/executions、POST /{id}/apply
 * 策略写操作（创建/编辑/删除）在服务层按角色限制（sales 越权 40301）。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { FollowUpsService } from './follow-ups.service.js';
import {
  applyStrategySchema,
  listFollowUpTasksQuerySchema,
  listStrategiesQuerySchema,
  upsertStrategySchema,
  type ApplyStrategyDto,
  type ListFollowUpTasksQuery,
  type ListStrategiesQuery,
  type UpsertStrategyDto,
} from './follow-ups.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/** 统一构造 OrgScopeContext（scope 缺省取角色上限） */
function ctxOf(req: Request & { authUser?: AccessTokenPayload }): OrgScopeContext {
  const user = req.authUser;
  if (!user) {
    throw new Error('未认证（JwtAuthGuard 缺失）');
  }
  return { orgId: user.orgId, userId: user.sub, role: user.role, scope: resolveScope(user.role) };
}

/** 07 §3.1 总览统计 */
@Controller('follow-ups')
export class FollowUpsController {
  constructor(@Inject(FollowUpsService) private readonly followUps: FollowUpsService) {}

  @Get('summary')
  async summary(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.followUps.summary(ctxOf(req));
  }
}

/** 07 §3.2 跟进任务列表 / 暂停 / 跳过 */
@Controller('follow-up-tasks')
export class FollowUpTasksController {
  constructor(@Inject(FollowUpsService) private readonly followUps: FollowUpsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listFollowUpTasksQuerySchema.merge(paginationQuerySchema)))
    query: ListFollowUpTasksQuery & { page: number; pageSize: number; keyword?: string },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.listTasks(ctxOf(req), query);
  }

  @Post(':id/pause')
  async pause(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.pause(ctxOf(req), taskId);
  }

  @Post(':id/skip')
  async skip(
    @Param('id') taskId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.skip(ctxOf(req), taskId);
  }
}

/** 07 §3.3/§3.4/§3.5 策略 CRUD + 执行记录 + apply */
@Controller('follow-up-strategies')
export class FollowUpStrategiesController {
  constructor(@Inject(FollowUpsService) private readonly followUps: FollowUpsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listStrategiesQuerySchema.merge(paginationQuerySchema)))
    query: ListStrategiesQuery & { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.listStrategies(ctxOf(req), query);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(upsertStrategySchema)) dto: UpsertStrategyDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.createStrategy(ctxOf(req), dto);
  }

  @Put(':id')
  async update(
    @Param('id') strategyId: string,
    @Body(new ZodValidationPipe(upsertStrategySchema)) dto: UpsertStrategyDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.updateStrategy(ctxOf(req), strategyId, dto);
  }

  @Delete(':id')
  async remove(
    @Param('id') strategyId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.deleteStrategy(ctxOf(req), strategyId);
  }

  @Get(':id/executions')
  async executions(
    @Param('id') strategyId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.executions(ctxOf(req), strategyId, query.page, query.pageSize);
  }

  @Post(':id/apply')
  async apply(
    @Param('id') strategyId: string,
    @Body(new ZodValidationPipe(applyStrategySchema)) dto: ApplyStrategyDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.followUps.apply(ctxOf(req), strategyId, dto);
  }
}
