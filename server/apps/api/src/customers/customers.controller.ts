import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { CustomersService } from './customers.service.js';
import {
  createCustomerSchema,
  listCustomersQuerySchema,
  stageTransitionSchema,
  updateCustomerSchema,
  type CreateCustomerDto,
  type ListCustomersQuery,
  type StageTransitionDto,
  type UpdateCustomerDto,
} from './customers.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 05 CRM 客户中心接口（接口 05 §2，P0，M5-A4）：
 * GET/POST /customers、PUT /customers/{id}、POST /customers/{id}/stage。
 * 详情（GET /{id}）复用 04 客户360°（B3）；软删/批量/contacts/activities 随 M5-B1。
 */
@Controller('customers')
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  /** 05 §3.1 客户列表（tab 区分潜在/正式；scope 缺省取角色上限） */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listCustomersQuerySchema.merge(paginationQuerySchema)))
    query: ListCustomersQuery & { page: number; pageSize: number; keyword?: string },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.list(this.ctx(req, query.scope), query);
  }

  /** 05 §1.2 添加客户（手工录入；ownerId 指派他人仅 manager/admin） */
  @Post()
  async create(
    @Body(new ZodValidationPipe(createCustomerSchema)) dto: CreateCustomerDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.create(this.ctx(req), dto);
  }

  /** 05 §2 编辑客户资料（改 ownerId 即转交，经理/管理员限定） */
  @Put(':id')
  async update(
    @Param('id') customerId: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) dto: UpdateCustomerDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.update(this.ctx(req), customerId, dto);
  }

  /** 05 §3.2 推进客户阶段（正向或回退 contacted；非法 40901；stage_change 活动留痕） */
  @Post(':id/stage')
  async stage(
    @Param('id') customerId: string,
    @Body(new ZodValidationPipe(stageTransitionSchema)) dto: StageTransitionDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.stage(this.ctx(req), customerId, dto);
  }

  /** 资源级访问取角色上限（sales=self / manager=team / admin=all；query scope 显式传入时校验并收窄） */
  private ctx(
    req: Request & { authUser?: AccessTokenPayload },
    scope?: 'self' | 'team' | 'all',
  ): OrgScopeContext {
    const user = this.requireUser(req);
    return {
      orgId: user.orgId,
      userId: user.sub,
      role: user.role,
      scope: resolveScope(user.role, scope),
    };
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}
