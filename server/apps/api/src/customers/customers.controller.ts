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
import { CustomersService } from './customers.service.js';
import {
  analyzeSchema,
  batchDeleteSchema,
  batchOwnerSchema,
  createCustomerSchema,
  listCustomersQuerySchema,
  stageTransitionSchema,
  updateCustomerSchema,
  type AnalyzeDto,
  type BatchDeleteDto,
  type BatchOwnerDto,
  type CreateCustomerDto,
  type ListCustomersQuery,
  type StageTransitionDto,
  type UpdateCustomerDto,
} from './customers.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 05 CRM 客户中心接口（接口 05 §2，P0，M5-A4/B1）：
 * - A4：GET/POST /customers、PUT /customers/{id}、POST /customers/{id}/stage
 * - B1：DELETE /customers/{id}、POST /customers/batch-delete、POST /customers/batch-owner
 * - B3：GET /customers/{id}/contacts、/customers/{id}/activities 等 04 客户360° 子资源
 *
 * 注：05 §2 的 contacts CRUD（POST/PUT/DELETE /contacts）与活动全局列表（GET /activities）
 * 为根级路由，由 ContactsController 提供（契约：05 接口文档 §2/§3.4）。
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

  // ===== B3 04 客户360° =====

  /** B3 §3.1 GET /customers/{id} 客户详情 + Overview */
  @Get(':id')
  async detail(
    @Param('id') customerId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.detail(this.ctx(req), customerId);
  }

  /** B3 §3.3 POST /customers/{id}/analyze 触发 AI 分析（异步 → product_analysis 任务） */
  @Post(':id/analyze')
  async analyze(
    @Param('id') customerId: string,
    @Body(new ZodValidationPipe(analyzeSchema)) dto: AnalyzeDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.analyze(this.ctx(req), customerId, dto);
  }

  /** B3 §3.2 GET /customers/{id}/insights AI 客户洞察 */
  @Get(':id/insights')
  async insights(
    @Param('id') customerId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ): Promise<unknown> {
    return this.customers.insights(this.ctx(req), customerId);
  }

  /** B3 GET /customers/{id}/products 产品匹配列表（04 §1.5 Products 页签；产品目录未落地 → []） */
  @Get(':id/products')
  async listCustomerProducts(
    @Param('id') customerId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listCustomerProducts(this.ctx(req), customerId);
  }

  /** B3 GET /customers/{id}/contacts 联系人列表 */
  @Get(':id/contacts')
  async listCustomerContacts(
    @Param('id') customerId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ): Promise<unknown> {
    return this.customers.listCustomerContacts(
      this.ctx(req),
      customerId,
      query.page,
      query.pageSize,
    );
  }

  /** B3 GET /customers/{id}/conversations 会话列表 */
  @Get(':id/conversations')
  async listCustomerConversations(
    @Param('id') customerId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listCustomerConversations(
      this.ctx(req),
      customerId,
      query.page,
      query.pageSize,
    );
  }

  /** B3 GET /customers/{id}/quotes 历史报价（D6 降级） */
  @Get(':id/quotes')
  async listCustomerQuotes(
    @Param('id') customerId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listCustomerQuotes(this.ctx(req), customerId, query.page, query.pageSize);
  }

  /** B3 GET /customers/{id}/orders 历史订单（D6 降级） */
  @Get(':id/orders')
  async listCustomerOrders(
    @Param('id') customerId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listCustomerOrders(this.ctx(req), customerId, query.page, query.pageSize);
  }

  /** B3 GET /customers/{id}/activities 活动时间线 */
  @Get(':id/activities')
  async listCustomerActivities(
    @Param('id') customerId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listCustomerActivities(
      this.ctx(req),
      customerId,
      query.page,
      query.pageSize,
    );
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
