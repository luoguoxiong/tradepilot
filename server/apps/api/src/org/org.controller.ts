import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BizException, ErrorCode } from '@tradepilot/core';
import { OrgService } from './org.service.js';
import {
  inviteMemberSchema,
  updateMemberSchema,
  updateOnboardingSchema,
  updateOrgSchema,
} from './org.dto.js';
import type { InviteMemberDto, UpdateMemberDto, UpdateOrgDto } from './org.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 组织与成员接口（接口 16 §2）：
 * GET/PUT /org/onboarding、GET/PUT /org、GET /org/members、POST /org/members/invite、PUT /org/members/:id。
 * 组织级变更（向导推进/企业信息/邀请/成员变更）仅 admin（03 §4）；读接口三角色可访问。
 */
@Controller('org')
export class OrgController {
  constructor(@Inject(OrgService) private readonly org: OrgService) {}

  @Get('onboarding')
  async getOnboarding(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.org.getOnboarding(this.requireUser(req).orgId);
  }

  @Roles('admin')
  @Put('onboarding')
  async updateOnboarding(
    @Body(new ZodValidationPipe(updateOnboardingSchema)) dto: { currentStep: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.org.updateOnboarding(this.requireUser(req).orgId, dto.currentStep);
  }

  @Get()
  async getOrg(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.org.getOrg(this.requireUser(req).orgId);
  }

  @Roles('admin')
  @Put()
  async updateOrg(
    @Body(new ZodValidationPipe(updateOrgSchema)) dto: UpdateOrgDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.org.updateOrg(this.requireUser(req).orgId, dto);
  }

  @Get('members')
  async listMembers(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.org.listMembers(this.requireUser(req).orgId);
  }

  @Roles('admin')
  @Post('members/invite')
  async invite(
    @Body(new ZodValidationPipe(inviteMemberSchema)) dto: InviteMemberDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.org.inviteMember(user.orgId, user.sub, dto);
  }

  @Roles('admin')
  @Put('members/:id')
  async updateMember(
    @Param('id') memberId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) dto: UpdateMemberDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.org.updateMember(this.requireUser(req).orgId, memberId, dto);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '未认证或登录已失效');
    }
    return user;
  }
}
