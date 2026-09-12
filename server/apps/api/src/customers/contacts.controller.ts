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
  createContactRootSchema,
  listActivitiesQuerySchema,
  listContactsQuerySchema,
  updateContactSchema,
  type CreateContactRootDto,
  type ListActivitiesQuery,
  type ListContactsQuery,
  type UpdateContactDto,
} from './customers.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 05 §2 联系人 / 活动根级接口（契约见 05 接口文档 §2 / §3.4）：
 * - GET    /contacts        全局联系人列表
 * - POST   /contacts        新增联系人（body 带 customerId）
 * - PUT    /contacts/{id}   编辑联系人
 * - DELETE /contacts/{id}   删除联系人（单条，不走审批、不写客户活动）
 * - GET    /activities      活动全局时间线
 *
 * 注：04 客户 360° 的子资源 GET /customers/{id}/contacts、/customers/{id}/activities
 * 仍由 CustomersController 提供，与本控制器的全局口径区分。
 */
@Controller()
export class ContactsController {
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  /** 05 §2 全局联系人列表（scope 按所属客户 owner 裁剪 + keyword 命中姓名/邮箱/公司名） */
  @Get('contacts')
  async list(
    @Query(new ZodValidationPipe(listContactsQuerySchema.merge(paginationQuerySchema)))
    query: ListContactsQuery & { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listContacts(this.ctx(req), query);
  }

  /** 05 §2 新增联系人（普通写操作，owner 权限内；所属客户随 body 传入） */
  @Post('contacts')
  async create(
    @Body(new ZodValidationPipe(createContactRootSchema)) dto: CreateContactRootDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const { customerId, ...rest } = dto;
    return this.customers.createContact(this.ctx(req), customerId, rest);
  }

  /** 05 §2 编辑联系人（归属不可变更；邮箱 org 内唯一，重复 40901） */
  @Put('contacts/:id')
  async update(
    @Param('id') contactId: string,
    @Body(new ZodValidationPipe(updateContactSchema)) dto: UpdateContactDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.updateContactById(this.ctx(req), contactId, dto);
  }

  /** 05 §2 / §3.5 删除单条联系人 */
  @Delete('contacts/:id')
  async remove(
    @Param('id') contactId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.deleteContactById(this.ctx(req), contactId);
  }

  /** 05 §3.4 活动全局列表（customerId / type / operatorType / startDate+endDate 筛选 + 分页） */
  @Get('activities')
  async listActivities(
    @Query(new ZodValidationPipe(listActivitiesQuerySchema.merge(paginationQuerySchema)))
    query: ListActivitiesQuery & { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.listActivities(this.ctx(req), query);
  }

  /** 资源级访问取角色上限（sales=self / manager=team / admin=all） */
  private ctx(req: Request & { authUser?: AccessTokenPayload }): OrgScopeContext {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return { orgId: user.orgId, userId: user.sub, role: user.role, scope: resolveScope(user.role) };
  }
}
