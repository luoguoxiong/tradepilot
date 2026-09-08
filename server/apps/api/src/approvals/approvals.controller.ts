import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { ApprovalsService } from './approvals.service.js';
import {
  approveApprovalSchema,
  listApprovalsQuerySchema,
  rejectApprovalSchema,
  type ApproveApprovalDto,
  type ListApprovalsQuery,
  type RejectApprovalDto,
} from './approvals.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 审核中心接口（接口 12 §2，P0）：
 * GET /approvals/summary、GET /approvals、GET /approvals/{id}、
 * POST /approvals/{id}/approve、POST /approvals/{id}/reject、GET /approvals/{id}/logs。
 * 权限（12 §4）：审批人按类型绑定业务角色——P0（email_send/customer_delete）经理以上处置。
 */
@Controller('approvals')
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  /** 12 §3.1 各类型待审数量（前端 15s 轮询徽标对端） */
  @Get('summary')
  async summary(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.approvals.summary(this.requireUser(req).orgId);
  }

  /** 12 §3.2 审批列表（type/status 筛选） */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listApprovalsQuerySchema.merge(paginationQuerySchema)))
    query: ListApprovalsQuery & { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.approvals.list(this.requireUser(req).orgId, query);
  }

  /** 12 §1.2 审批详情（审核卡片字段） */
  @Get(':id')
  async detail(
    @Param('id') approvalId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.approvals.detail(this.requireUser(req).orgId, approvalId);
  }

  /** 12 §3.3 批准（approve / edited_approved + editedContent） */
  @Post(':id/approve')
  @Roles('admin', 'manager')
  async approve(
    @Param('id') approvalId: string,
    @Body(new ZodValidationPipe(approveApprovalSchema)) dto: ApproveApprovalDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.approvals.approve(user.orgId, user.sub, approvalId, dto);
  }

  /** 12 §3.4 拒绝（必填原因） */
  @Post(':id/reject')
  @Roles('admin', 'manager')
  async reject(
    @Param('id') approvalId: string,
    @Body(new ZodValidationPipe(rejectApprovalSchema)) dto: RejectApprovalDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.approvals.reject(user.orgId, user.sub, approvalId, dto);
  }

  /** 12 §1.5 审核留痕记录 */
  @Get(':id/logs')
  async logs(
    @Param('id') approvalId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.approvals.logs(this.requireUser(req).orgId, approvalId);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}
