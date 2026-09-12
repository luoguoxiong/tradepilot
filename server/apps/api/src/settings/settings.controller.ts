import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BizException, ErrorCode } from '@tradepilot/core';
import { MailboxService } from './mailbox.service.js';
import { SettingsService } from './settings.service.js';
import {
  createMailboxSchema,
  rolePermissionsSchema,
  updateAiModelsSchema,
  updateMailboxSchema,
  updateNotificationsSchema,
} from './settings.dto.js';
import type {
  CreateMailboxDto,
  RolePermissionsDto,
  UpdateAiModelsDto,
  UpdateMailboxDto,
  UpdateNotificationsDto,
} from './settings.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 系统设置接口（接口 16 §2）：
 * - 邮箱连接 GET/POST/PUT/DELETE /settings/mailboxes + POST /{id}/test（P0）；
 * - 权限管理 GET/PUT /settings/roles/{role}/permissions；
 * - 通知设置 GET/PUT /settings/notifications；AI 模型 GET/PUT /settings/ai-models。
 * 变更仅 admin（03 §4）；读取 admin+manager（settings: view）；
 * AI 模型配置属敏感配置，读写均仅 admin（不开放给 manager）。
 */
@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(MailboxService) private readonly mailboxes: MailboxService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  // ===== 邮箱连接 =====

  @Roles('admin', 'manager')
  @Get('mailboxes')
  async listMailboxes(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.mailboxes.list(this.requireUser(req).orgId);
  }

  @Roles('admin')
  @Post('mailboxes')
  async createMailbox(
    @Body(new ZodValidationPipe(createMailboxSchema)) dto: CreateMailboxDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.mailboxes.create(user.orgId, user.sub, dto);
  }

  @Roles('admin')
  @Put('mailboxes/:id')
  async updateMailbox(
    @Param('id') mailboxId: string,
    @Body(new ZodValidationPipe(updateMailboxSchema)) dto: UpdateMailboxDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.mailboxes.update(this.requireUser(req).orgId, mailboxId, dto);
  }

  @Roles('admin')
  @Delete('mailboxes/:id')
  async deleteMailbox(
    @Param('id') mailboxId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.mailboxes.remove(this.requireUser(req).orgId, mailboxId);
  }

  @Roles('admin')
  @Post('mailboxes/:id/test')
  async testMailbox(
    @Param('id') mailboxId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.mailboxes.test(this.requireUser(req).orgId, mailboxId);
  }

  // ===== 权限管理（FR-08）=====

  @Roles('admin', 'manager')
  @Get('roles/:role/permissions')
  async getRolePermissions(
    @Param('role') role: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.settings.getRolePermissions(this.requireUser(req).orgId, role);
  }

  @Roles('admin')
  @Put('roles/:role/permissions')
  async updateRolePermissions(
    @Param('role') role: string,
    @Body(new ZodValidationPipe(rolePermissionsSchema)) dto: RolePermissionsDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.settings.updateRolePermissions(user.orgId, user.sub, role, dto);
  }

  // ===== 通知设置（FR-09）=====

  @Roles('admin', 'manager')
  @Get('notifications')
  async getNotifications(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.settings.getNotifications(this.requireUser(req).orgId);
  }

  @Roles('admin')
  @Put('notifications')
  async updateNotifications(
    @Body(new ZodValidationPipe(updateNotificationsSchema)) dto: UpdateNotificationsDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.settings.updateNotifications(this.requireUser(req).orgId, dto);
  }

  // ===== AI 模型配置（FR-10）=====

  @Roles('admin')
  @Get('ai-models')
  async getAiModels(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.settings.getAiModels(this.requireUser(req).orgId);
  }

  @Roles('admin')
  @Put('ai-models')
  async updateAiModels(
    @Body(new ZodValidationPipe(updateAiModelsSchema)) dto: UpdateAiModelsDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.settings.updateAiModels(this.requireUser(req).orgId, dto);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '未认证或登录已失效');
    }
    return user;
  }
}
