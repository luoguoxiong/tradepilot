import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { CustomersService } from './customers.service.js';
import {
  batchDeleteSchema,
  batchOwnerSchema,
  createContactSchema,
  createCustomerSchema,
  listActivitiesQuerySchema,
  listCustomersQuerySchema,
  stageTransitionSchema,
  updateContactSchema,
  updateCustomerSchema,
  type BatchDeleteDto,
  type BatchOwnerDto,
  type CreateContactDto,
  type CreateCustomerDto,
  type ListActivitiesQuery,
  type ListCustomersQuery,
  type StageTransitionDto,
  type UpdateContactDto,
  type UpdateCustomerDto,
} from './customers.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 05 CRM 客户中心接口（接口 05 §2，P0，M5-A4/B1）：
 * - A4：GET/POST /customers、PUT /customers/{id}、POST /customers/{id}/stage
 * - B1：DELETE /customers/{id}、POST /customers/batch-delete、POST /customers/batch-owner
 * - B1：POST /customers/{id}/contacts、PUT /customers/{id}/contacts/{contactId}、DELETE /customers/{id}/contacts/{contactId}
 * - B1：GET /customers/activities
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

  // ===== B1-1 软删 =====

  /** B1 §1 单条软删：锁定态走审批，非锁定态直接删 */
  @Delete(':id')
  async delete(
    @Param('id') customerId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.delete(this.ctx(req), customerId);
  }

  /** B1 §1 批量删除（仅 manager/admin；逐客户生成审批或直接删） */
  @Post('batch-delete')
  async batchDelete(
    @Body(new ZodValidationPipe(batchDeleteSchema)) dto: BatchDeleteDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.batchDelete(this.ctx(req), dto);
  }

  // ===== B1-2 batch-owner =====

  /** B1 §2 批量转交负责人（仅 manager/admin；逐客户写 owner_change 活动） */
  @Post('batch-owner')
  async batchOwner(
    @Body(new ZodValidationPipe(batchOwnerSchema)) dto: BatchOwnerDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.batchOwner(this.ctx(req), dto);
  }

  // ===== B1-3 contacts CRUD =====

  /** B1 §3 创建联系人（单条） */
  @Post(':customerId/contacts')
  async createContact(
    @Param('customerId') customerId: string,
    @Body(new ZodValidationPipe(createContactSchema)) dto: CreateContactDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.createContact(this.ctx(req), customerId, dto);
  }

  /** B1 §3 编辑联系人 */
  @Put(':customerId/contacts/:contactId')
  async updateContact(
    @Param('customerId') customerId: string,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(updateContactSchema)) dto: UpdateContactDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.updateContact(this.ctx(req), customerId, contactId, dto);
  }

  /** B1 §3 删除单条联系人（不走审批） */
  @Delete(':customerId/contacts/:contactId')
  async deleteContact(
    @Param('customerId') customerId: string,
    @Param('contactId') contactId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.deleteContact(this.ctx(req), customerId, contactId);
  }

  // ===== B1-4 activities 全局列表 =====

  /** B1 §4 活动全局列表（refType+refId 跳转 + type 筛选 + 分页） */
  @Get('activities')
  async listActivities(
    @Query(new ZodValidationPipe(listActivitiesQuerySchema.merge(paginationQuerySchema)))
    query: ListActivitiesQuery & { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listActivities(this.ctx(req), query);
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